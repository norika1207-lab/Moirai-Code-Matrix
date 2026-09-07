// Token 使用量與費用統計，解析本機 session jsonl。對應 app.py 的 token_stats（含 PRICING）。
import fs from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const PRICING = {
  claude: { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  codex: { input: 2.50, output: 10.00, cache_read: 0.25, cache_write: 0.0 },
};

function isoEpoch(s) {
  try {
    const t = Date.parse(String(s));
    return Number.isNaN(t) ? null : t / 1000;
  } catch { return null; }
}

function readLines(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n'); } catch { return []; }
}

export function zeroTokens() {
  const out = {};
  for (const v of ['claude', 'codex']) {
    out[v] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, sessions: 0, cache_pct: 0, total_tokens: 0 };
  }
  return out;
}

export function tokenStats(discovered, windowSec = 86400) {
  const cutoff = Date.now() / 1000 - windowSec;
  const out = {};
  for (const v of ['claude', 'codex']) out[v] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, sessions: 0 };

  for (const f of globSync(path.join(discovered.claudeProj, '*', '*.jsonl'))) {
    let mtime;
    try { mtime = fs.statSync(f).mtimeMs / 1000; } catch { continue; }
    if (mtime < cutoff) continue;
    let hit = false;
    for (const ln of readLines(f)) {
      if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      const u = (d.message || {}).usage;
      if (!u) continue;
      const ep = isoEpoch(d.timestamp);
      if (ep != null && ep < cutoff) continue;
      hit = true;
      const a = out.claude;
      a.input += u.input_tokens || 0;
      a.output += u.output_tokens || 0;
      a.cache_read += u.cache_read_input_tokens || 0;
      a.cache_write += u.cache_creation_input_tokens || 0;
    }
    if (hit) out.claude.sessions++;
  }

  for (const dd of discovered.codexDirs) {
    for (const f of globSync(path.join(dd, '**', '*.jsonl'))) {
      let mtime;
      try { mtime = fs.statSync(f).mtimeMs / 1000; } catch { continue; }
      if (mtime < cutoff) continue;
      let base = null, latest = null;
      for (const ln of readLines(f)) {
        if (!ln.trim()) continue;
        let d; try { d = JSON.parse(ln); } catch { continue; }
        const pl = (d.payload && typeof d.payload === 'object') ? d.payload : {};
        if (pl.type !== 'token_count') continue;
        const tu = (pl.info || {}).total_token_usage;
        if (!tu) continue;
        const ep = isoEpoch(d.timestamp);
        if (ep != null && ep < cutoff) base = tu; else latest = tu;
      }
      if (latest) {
        const b = base || {};
        const a = out.codex;
        a.input += Math.max((latest.input_tokens || 0) - (b.input_tokens || 0), 0);
        a.output += Math.max((latest.output_tokens || 0) - (b.output_tokens || 0), 0);
        a.cache_read += Math.max((latest.cached_input_tokens || 0) - (b.cached_input_tokens || 0), 0);
        a.sessions++;
      }
    }
  }

  for (const v of ['claude', 'codex']) {
    const a = out[v], p = PRICING[v];
    const billableIn = Math.max(v === 'codex' ? a.input - a.cache_read : a.input, 0);
    a.cost = Math.round((billableIn / 1e6 * p.input + a.output / 1e6 * p.output
      + a.cache_read / 1e6 * p.cache_read + a.cache_write / 1e6 * p.cache_write) * 100) / 100;
    const denom = billableIn + a.cache_read + a.cache_write;
    a.cache_pct = denom ? Math.round(1000 * a.cache_read / denom) / 10 : 0.0;
    a.total_tokens = billableIn + a.output + a.cache_read + a.cache_write;
  }
  return out;
}
