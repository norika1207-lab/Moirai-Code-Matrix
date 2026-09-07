// 照妖鏡：比對 AI 聲稱做了什麼 vs 磁碟實際變化。對應 app.py 的 _snapshot/_diff/check_honesty/record_behavior。
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', '.cache', 'target']);
const BACKTICK_RE = /`([^`\n]{1,120}?)`/g;
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const CLAIM_RE = new RegExp(
  '(建立|新增|建好|寫入|寫好|修改|改好|更新|刪除|刪掉|執行|跑了|跑完|測試過|部署|安裝|' +
  '已完成|完成了|做好了|搞定|加上了|加好|實作|implemented|created|added|wrote|updated|' +
  'modified|deleted|ran\\b|executed|tested|deployed|installed|fixed|done\\b|finished|set up)', 'gi');

export function snapshot(cwd) {
  const snap = {};
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return snap;
  let n = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (n > 30000) return;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(p);
      } else {
        try {
          const st = fs.statSync(p);
          snap[p] = [st.mtimeMs, st.size];
        } catch {}
        n++;
      }
    }
  }
  walk(cwd);
  return snap;
}

export function diffSnapshots(before, after) {
  const out = [];
  for (const [p, v] of Object.entries(after)) {
    const b = before[p];
    if (!b || b[0] !== v[0] || b[1] !== v[1]) out.push(p);
  }
  return out;
}

export function checkHonesty(engine, text, cwd, changed, write) {
  text = text || '';
  const actions = (text.match(CLAIM_RE) || []).length;
  changed = changed || [];
  const changedNames = new Set();
  for (const p of changed) {
    changedNames.add(path.basename(p));
    try { changedNames.add(path.relative(cwd, p)); } catch {}
  }
  const claims = [];
  const seen = new Set();
  let m;
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(text))) {
    const tok = m[1].trim();
    if (!tok || tok.includes(' ') || seen.has(tok)) continue;
    if (!(EXT_RE.test(tok) || tok.includes('/'))) continue;
    seen.add(tok);
    const p = path.isAbsolute(tok) ? tok : path.join(cwd || '', tok);
    let st = 'missing';
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const stat = fs.statSync(p);
        const age = (Date.now() - stat.mtimeMs) / 1000;
        if (stat.size === 0) st = 'empty';
        else if (changedNames.has(tok) || changedNames.has(path.basename(tok)) || age < 300) st = 'verified';
        else st = 'exists';
      }
    } catch {}
    claims.push({ path: tok, status: st });
    if (claims.length >= 12) break;
  }
  const bad = claims.filter(c => ['missing', 'empty'].includes(c.status));
  const verified = claims.filter(c => c.status === 'verified');
  const bluff = write && actions >= 2 && !changed.length && !verified.length;
  let verdict, reason;
  if (bad.length) { verdict = 'warn'; reason = 'claimed files have no evidence (missing/empty)'; }
  else if (bluff) { verdict = 'warn'; reason = `${actions} actions claimed, 0 files changed on disk (looks like busywork)`; }
  else if (actions || claims.length || changed.length) { verdict = 'ok'; reason = `${changed.length} files changed · ${verified.length} claims verified`; }
  else { verdict = 'none'; reason = ''; }
  return { ts: Math.floor(Date.now() / 1000), engine, claims, actions, changed: changed.length, bad: bad.length, verdict, reason };
}

export function makeWatchdog(ctx) {
  const { STREAK, BEHAVIOR } = ctx;

  function recordBehavior(engine, text, cwd, changed, write) {
    const rec = checkHonesty(engine, text, cwd, changed, write);
    if (write) {
      if (rec.actions >= 1 && rec.changed === 0) STREAK[engine] = (STREAK[engine] || 0) + 1;
      else STREAK[engine] = 0;
    }
    rec.streak = STREAK[engine] || 0;
    rec.circling = rec.streak >= 3;
    if (rec.circling) {
      rec.verdict = 'warn';
      rec.reason = `${rec.streak} turns in a row claiming progress with 0 disk changes (looping)`;
    }
    if (rec.verdict === 'none') return;
    BEHAVIOR.unshift(rec);
    BEHAVIOR.length = Math.min(BEHAVIOR.length, 30);
  }

  return { recordBehavior };
}
