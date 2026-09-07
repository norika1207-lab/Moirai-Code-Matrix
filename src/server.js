// Moirai 的 HTTP server：整合所有模組，對應 app.py 的 class H(BaseHTTPRequestHandler) 全部路由。
// 直接跑在 Electron main process 裡(不再是獨立 python 子行程)。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';

import { discover, readSshHosts } from './discover.js';
import { makeState } from './state.js';
import { makeShared } from './shared.js';
import { makeChildTracker } from './child-tracking.js';
import { makeCliDriver } from './cli-driver.js';
import { makeWatchdog, snapshot, diffSnapshots } from './watchdog.js';
import { zeroTokens, tokenStats } from './tokens.js';
import { makeMetaCache, makeClaudeGroups, makeSessions } from './sessions.js';
import { makeOverrides } from './overrides.js';
import { sessionName } from './tool-format.js';

// M2 交接規則的放行判斷。抽成純函式是為了能被測試直接驗證,
// 不必真的跑 agent 燒 token(對應 Forseti Engineering Book 的 AI-03 / AI-08)。
// 回傳 'allow' | 'loop' | 'busy' | 'hops'
export function handoffDecision({ edge, fromPane, chain, isRunning, maxHops, maxRoundtrips }) {
  const to = edge.to;
  if (isRunning) return 'busy';
  if (chain.length >= maxHops) return 'hops';
  if (edge.kind === 'roundtrip') {
    // 數「fromPane -> to 這個轉移」走過幾次,不是數 to 出現幾次。
    // 數 to 出現次數會偏移一輪,因為起點自己就在 chain 裡。
    let hops = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
      if (chain[i] === fromPane && chain[i + 1] === to) hops++;
    }
    return hops < maxRoundtrips ? 'allow' : 'loop';
  }
  return chain.includes(to) ? 'loop' : 'allow';
}

export function startServer({ HERE, port }) {
  const discovered = discover();
  discovered.HERE = HERE;

  const ctx = makeState(HERE);
  ctx.loadState();
  const { sharedAdd, sharedPreamble, memFiles, memDir } = makeShared(ctx, HERE);
  const tracker = makeChildTracker(HERE);
  tracker.reapOrphans();
  const { runStreamClaude, runStreamCodex } = makeCliDriver(ctx, tracker, HERE, discovered);
  const { recordBehavior } = makeWatchdog(ctx);
  const metaCache = makeMetaCache(HERE);
  const claudeGroups = makeClaudeGroups(HERE);
  const sessionsApi = makeSessions(discovered, metaCache, claudeGroups, ctx);
  const overrides = makeOverrides(HERE);

  // ---- token 快取：背景刷新，永不擋 request thread ----
  const TOK_CACHE = { ts: 0, data: null, computing: false };
  function maybeRefreshTokens() {
    const now = Date.now() / 1000;
    if (TOK_CACHE.computing) return;
    if (TOK_CACHE.data != null && now - TOK_CACHE.ts < 300) return;
    TOK_CACHE.computing = true;
    setImmediate(() => {
      try { TOK_CACHE.data = tokenStats(discovered); } catch {}
      TOK_CACHE.ts = Date.now() / 1000;
      TOK_CACHE.computing = false;
    });
  }

  // ---- session 列表快取：背景刷新 ----
  const SESS_CACHE = {}; // engine -> {ts, rows}
  const SESS_COMPUTING = new Set();
  function sessionsCached(engine, hidden) {
    const now = Date.now() / 1000;
    const hit = SESS_CACHE[engine];
    const fresh = hit && now - hit.ts < 20;
    if (!fresh && !SESS_COMPUTING.has(engine)) {
      SESS_COMPUTING.add(engine);
      setImmediate(() => {
        try {
          SESS_CACHE[engine] = { ts: Date.now() / 1000, rows: sessionsApi.listSessions(engine) };
          metaCache.save();
        } catch {} finally { SESS_COMPUTING.delete(engine); }
      });
    }
    return hit ? overrides.apply(engine, hit.rows, hidden) : [];
  }

  // ---- M2:交接規則引擎 ----
  // 上游 done 之後自動把產出送給下游,取代「每一輪都要人按一顆 → Audit」。
  //
  // 迴圈防護說明(這是本機制最容易出事的地方,不是選配):
  // 每一次由規則觸發的執行都帶一條 chain(走過哪些 pane)。再往下傳之前檢查三件事:
  //   1. 下游已經在這條 chain 裡  → 擋掉(A→B→A 這種環)
  //   2. chain 長度超過 MAX_HOPS  → 擋掉(長鏈失控)
  //   3. 下游此刻正在跑           → 擋掉(避免同一個 pane 被灌爆)
  // 擋掉時記進 HANDOFF_STATS.blocked_loop,不靜默丟棄。
  const MAX_HOPS = 4;
  const MAX_ROUNDTRIPS = 1;   // A→B→A 最多來回一次,再多就停下來交給人

  function edgesFrom(pane) {
    return ctx.HANDOFF.edges.filter(e => e.from === pane && e.enabled !== false);
  }
  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  }
  function crossTaskText(toPane, srcText, fromPane) {
    // 與前端 crossTask() 同一套語意:送的是「下游自己的職責 + 上游結果當任務來源」,
    // 不是把上游的對話逐字倒過去。職責文字目前存在前端 localStorage,後端拿不到,
    // 所以這裡只組任務框架,職責由下游自己的 system prompt 承擔。
    const src = (srcText || '').trim();
    const who = ctx.pname(fromPane);
    return '=== 交辦任務 ===\n'
      + '上面是「' + who + '」談定的結果。把它當成這一棒的「任務來源」:從中抽出「要做什麼」,'
      + '直接執行你自己的職責。這是交棒給你的任務,不是要你覆述、接續或評論那段對話逐字。\n\n'
      + '--- 來源結果(供你萃取任務,不要照抄) ---\n' + src;
  }

  // 規則觸發。chain 是走過的 pane 列表,用來斷環。
  async function runHandoff(fromPane, finalText, chain) {
    if (!finalText || !finalText.trim()) return;
    for (const edge of edgesFrom(fromPane)) {
      const to = edge.to;
      const decision = handoffDecision({
        edge, fromPane, chain, isRunning: !!ctx.RUNNING[to],
        maxHops: MAX_HOPS, maxRoundtrips: MAX_ROUNDTRIPS,
      });
      if (decision !== 'allow') {
        ctx.HANDOFF_STATS.blocked_loop++;
        ctx.saveState();
        // roundtrip 被擋下時不要靜默丟掉,轉成閘門讓人決定要不要再送一次
        if (edge.kind === 'roundtrip' && !ctx.RUNNING[to]) {
          ctx.GATES.push({
            gate_id: newId('g'), edge_id: edge.id, from: fromPane, to,
            text: finalText, at: new Date().toISOString(), state: 'waiting',
            chain, reason: 'roundtrip 已達上限,需要你決定',
          });
        }
        ctx.saveState();
        continue;
      }
      if (edge.kind === 'gated') {
        ctx.GATES.push({
          gate_id: newId('g'), edge_id: edge.id, from: fromPane, to,
          text: finalText, at: new Date().toISOString(), state: 'waiting', chain,
        });
        ctx.saveState();
        continue;
      }
      ctx.HANDOFF_STATS.auto++;
      if (!ctx.HANDOFF_STATS.since) ctx.HANDOFF_STATS.since = new Date().toISOString();
      ctx.saveState();
      // 不 await:交棒是背景動作,不該把上游那一輪的回應卡住。
      handleStream(to, crossTaskText(to, finalText, fromPane), () => {}, chain.concat([to]))
        .catch(() => {});
    }
  }

  // ---- watchdog 用：多 pane 平行送出 ----
  async function handleStream(target, text, emit, chain = []) {
    const proj = ctx.SETTINGS.project;
    const writable = {};
    for (const p of Object.keys(ctx.STATE)) writable[p] = ctx.WRITABLE.has(ctx.AGENT_CFG[p].mode);
    const before = proj ? snapshot(proj) : {};
    const panes = ctx.STATE[target] ? [target] : Object.keys(ctx.STATE);

    async function work(pane) {
      const t0 = Date.now();
      const eng = ctx.STATE[pane].engine;
      const fn = eng === 'claude' ? runStreamClaude : runStreamCodex;
      const { body: pre, n, froms } = sharedPreamble(pane);
      if (n) emit({ engine: pane, k: 'shared', n, from: froms });
      const final = await fn(pane, pre ? pre + text : text, emit);
      const ms = Date.now() - t0;
      sharedAdd(pane, 'user', text);
      sharedAdd(pane, 'bot', final);
      const curSid = ctx.STATE[pane].id;
      emit({ engine: pane, k: 'done', ms, sid: curSid });
      return { pane, final, ms };
    }

    const results = await Promise.all(panes.map(work));
    const changed = proj ? diffSnapshots(before, snapshot(proj)) : [];
    for (const r of results) {
      if (r.final) recordBehavior(r.pane, r.final, proj, changed, writable[r.pane]);
    }
    // 完成之後才觸發交接規則。放在 recordBehavior 之後,是為了讓照妖鏡先對這一輪
    // 做完誠實性比對,再把結果往下游送,避免把一個已經被判定可疑的產出自動散布出去。
    for (const r of results) {
      if (r.final) await runHandoff(r.pane, r.final, chain.length ? chain : [r.pane]);
    }
  }

  // ---------- HTTP ----------
  function send(res, code, body, ctype = 'application/json') {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'Content-Type': ctype, 'Content-Length': b.length });
    res.end(b);
  }
  function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj)); }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = u.pathname;
      const q = u.searchParams;

      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') {
          return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
        }
        if (p === '/logo.svg') {
          try { return send(res, 200, fs.readFileSync(path.join(HERE, 'logo.svg')), 'image/svg+xml'); }
          catch { return send(res, 404, 'no logo', 'text/plain'); }
        }
        if (p === '/api/sessions') {
          const eng = q.get('engine') || 'claude';
          const hidden = q.get('hidden') === '1';
          return sendJson(res, 200, sessionsCached(eng, hidden));
        }
        if (p === '/api/transcript') {
          const eng = q.get('engine') || 'claude';
          const sid = q.get('id') || '';
          return sendJson(res, 200, sessionsApi.readTranscript(eng, sid));
        }
        if (p === '/api/state') {
          const out = {};
          for (const pn of Object.keys(ctx.STATE)) {
            const running = pn in ctx.RUNNING && ctx.RUNNING[pn].exitCode === null;
            out[pn] = { ...ctx.STATE[pn], running };
          }
          return sendJson(res, 200, out);
        }
        if (p === '/api/project') return sendJson(res, 200, { project: ctx.SETTINGS.project });
        if (p === '/api/agent-config') return sendJson(res, 200, ctx.AGENT_CFG);
        if (p === '/api/ssh-hosts') return sendJson(res, 200, { hosts: readSshHosts() });
        if (p === '/api/remote-login') {
          const remote = q.get('remote') || '';
          if (!remote) return send(res, 400, 'bad remote', 'text/plain');
          // 白名單:這支是 GET,一個 <img src> 就能觸發,是三個入口裡門檻最低的
          const chk2 = ctx.allowedRemote(remote, readSshHosts());
          if (!chk2.ok) return send(res, 400, chk2.reason, 'text/plain');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          try {
            const proc = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
              '-o', 'StrictHostKeyChecking=accept-new', remote, 'claude', 'auth', 'login'],
              { stdio: ['ignore', 'pipe', 'pipe'] });
            let buf = '';
            proc.stdout.on('data', (chunk) => {
              buf += chunk.toString();
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                res.write(`data: ${JSON.stringify({ line })}\n\n`);
              }
            });
            proc.stderr.on('data', (chunk) => {
              buf += chunk.toString();
            });
            proc.on('close', (rc) => {
              res.write(`data: ${JSON.stringify({ done: true, rc })}\n\n`);
              res.end();
            });
            proc.on('error', (e) => {
              try { res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`); } catch {}
              res.end();
            });
          } catch (e) {
            try { res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`); } catch {}
            res.end();
          }
          return;
        }
        if (p === '/api/projects') {
          const seen = new Set(); const out = [];
          if (ctx.SETTINGS.project) {
            out.push({ path: ctx.SETTINGS.project, label: path.basename(ctx.SETTINGS.project) + ' (shared)' });
            seen.add(ctx.SETTINGS.project);
          }
          for (const eng of ['claude', 'codex']) {
            for (const r of sessionsApi.listSessions(eng, 300)) {
              const c = r.cwd;
              if (c && !seen.has(c) && fs.existsSync(c)) {
                seen.add(c);
                out.push({ path: c, label: r.project || path.basename(c) });
              }
            }
          }
          return sendJson(res, 200, out.slice(0, 40));
        }
        if (p === '/api/files') {
          const base = ctx.SETTINGS.project || HERE;
          const rel = q.get('dir') || '';
          let d = path.normalize(path.join(base, rel));
          if (!d.startsWith(path.normalize(base))) { d = base; }
          const entries = [];
          try {
            const names = fs.readdirSync(d).sort((a, b) => {
              const ad = fs.statSync(path.join(d, a)).isDirectory();
              const bd = fs.statSync(path.join(d, b)).isDirectory();
              if (ad !== bd) return ad ? -1 : 1;
              return a.toLowerCase().localeCompare(b.toLowerCase());
            });
            for (const name of names) {
              if (name.startsWith('.')) continue;
              entries.push({ name, dir: fs.statSync(path.join(d, name)).isDirectory() });
            }
          } catch {}
          return sendJson(res, 200, { base, rel: d !== base ? path.relative(base, d) : '', entries: entries.slice(0, 400) });
        }
        if (p === '/api/tokens') {
          maybeRefreshTokens();
          return sendJson(res, 200, TOK_CACHE.data || zeroTokens());
        }
        if (p === '/api/behavior') return sendJson(res, 200, { records: ctx.BEHAVIOR, streak: ctx.STREAK });
        if (p === '/api/memory') {
          const fsList = memFiles().map(f => ({ path: f, bytes: fs.existsSync(f) ? fs.statSync(f).size : 0 }));
          return sendJson(res, 200, { dir: memDir(), max_bytes: 1_000_000, files: fsList });
        }
        if (p === '/api/shared') return sendJson(res, 200, { shared: ctx.SHARED, seen: ctx.SHARED_SEEN, names: ctx.NAMES });
        if (p === '/api/engines') {
          return sendJson(res, 200, {
            claude: { available: !!discovered.claudeBin, bin: discovered.claudeBin, title_source: discovered.claudeSess ? 'desktop' : 'cli-jsonl' },
            codex: { available: !!discovered.codexBin, bin: discovered.codexBin },
          });
        }
        return send(res, 404, 'not found', 'text/plain');
      }

      if (req.method === 'POST') {
        if (p === '/api/upload') {
          const buf = await readBody(req);
          if (buf.length > 60 * 1024 * 1024) return sendJson(res, 413, { error: 'file too large (>60MB)' });
          let fname = path.basename(decodeURIComponent(req.headers['x-filename'] || 'file')) || 'file';
          fname = fname.replace(/\x00/g, '');
          const base = ctx.SETTINGS.project || HERE;
          const updir = path.join(base, '.duo_uploads');
          try {
            fs.mkdirSync(updir, { recursive: true });
            const ext = path.extname(fname), stem = path.basename(fname, ext);
            let dest = path.join(updir, fname), i = 1;
            while (fs.existsSync(dest)) { dest = path.join(updir, `${stem}_${i}${ext}`); i++; }
            fs.writeFileSync(dest, buf);
            return sendJson(res, 200, { ok: true, rel: path.relative(base, dest), name: path.basename(dest) });
          } catch (e) { return sendJson(res, 500, { error: String(e) }); }
        }
        if (p === '/api/stream') {
          const buf = await readBody(req);
          let reqBody = {}; try { reqBody = JSON.parse(buf.toString() || '{}'); } catch {}
          const target = reqBody.target || 'both';
          const text = (reqBody.text || '').trim();
          const nm = reqBody.names;
          if (nm && typeof nm === 'object') {
            for (const [k, v] of Object.entries(nm)) if (k in ctx.STATE && typeof v === 'string') ctx.NAMES[k] = v;
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
          const emit = (ev) => {
            try { res.write(JSON.stringify(ev) + '\n'); } catch {}
          };
          try { if (text) await handleStream(target, text, emit); }
          catch (e) { emit({ k: 'error', t: String(e) }); }
          return res.end();
        }

        const buf = await readBody(req);
        let reqBody = {}; try { reqBody = JSON.parse(buf.toString() || '{}'); } catch {}

        if (p === '/api/load') {
          const pane = reqBody.pane || reqBody.engine;
          const sid = reqBody.id; const cwd = reqBody.cwd || HERE;
          if (ctx.STATE[pane]) {
            const realEngine = ['claude', 'codex'].includes(reqBody.engine) ? reqBody.engine : ctx.STATE[pane].engine;
            ctx.STATE[pane].id = sid; ctx.STATE[pane].cwd = cwd;
            ctx.saveState();
            return sendJson(res, 200, { ok: true, transcript: sessionsApi.readTranscript(realEngine, sid) });
          }
          return sendJson(res, 400, { error: 'bad pane' });
        }
        if (p === '/api/session/patch') {
          const eng = reqBody.engine, sid = reqBody.id, patch = reqBody.patch || {};
          if (!['claude', 'codex'].includes(eng) || !sid) return sendJson(res, 400, { error: 'bad args' });
          overrides.patch(eng, sid, patch);
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/project') {
          let projPath = (reqBody.path || '').trim();
          if (projPath && !fs.existsSync(projPath.replace(/^~/, os.homedir()))) {
            return sendJson(res, 400, { error: `directory not found: ${projPath}` });
          }
          projPath = projPath ? projPath.replace(/^~/, os.homedir()) : null;
          const changed = projPath !== null && projPath !== ctx.SETTINGS.project;
          ctx.SETTINGS.project = projPath;
          if (changed) for (const e of Object.keys(ctx.STATE)) { ctx.STATE[e].cwd = projPath; ctx.STATE[e].id = null; }
          ctx.saveState();
          return sendJson(res, 200, { ok: true, project: projPath });
        }
        if (p === '/api/agent-config') {
          const pane = reqBody.engine;
          if (!ctx.AGENT_CFG[pane]) return sendJson(res, 400, { error: 'bad pane' });
          const eng = ctx.STATE[pane].engine;
          for (const k of ['model', 'mode', 'effort']) {
            if (k in reqBody) {
              ctx.AGENT_CFG[pane][k] = reqBody[k] || (k === 'mode' ? (eng === 'claude' ? 'auto' : 'read-only') : '');
            }
          }
          // 收一次尾:不論前端送什麼,mode 一定落在該 engine 的合法集合內,
          // 否則會被原樣送進 --permission-mode / codex sandbox 參數。
          ctx.AGENT_CFG[pane].mode = ctx.legalMode(eng, ctx.AGENT_CFG[pane].mode);
          if ('fast' in reqBody && 'fast' in ctx.AGENT_CFG[pane]) ctx.AGENT_CFG[pane].fast = !!reqBody.fast;
          ctx.saveState();
          return sendJson(res, 200, { ok: true, cfg: ctx.AGENT_CFG[pane] });
        }
        if (p === '/api/handoff') {
          const act = reqBody.act;
          if (act === 'add') {
            const { from, to } = reqBody;
            const kind = ['gated', 'roundtrip'].includes(reqBody.kind) ? reqBody.kind : 'direct';
            if (!ctx.STATE[from] || !ctx.STATE[to] || from === to) {
              return sendJson(res, 400, { error: 'bad from/to' });
            }
            // 同一組 from/to 只留一條,重複加就是改 kind
            const exist = ctx.HANDOFF.edges.find(e => e.from === from && e.to === to);
            if (exist) { exist.kind = kind; exist.enabled = true; }
            else ctx.HANDOFF.edges.push({ id: newId('e'), from, to, kind, enabled: true });
            ctx.saveState();
          } else if (act === 'remove') {
            ctx.HANDOFF.edges = ctx.HANDOFF.edges.filter(e => e.id !== reqBody.id);
            ctx.saveState();
          } else if (act === 'manual') {
            // 前端每按一次「→ 某某」就打這支,這是 M2 唯一的驗收指標
            ctx.HANDOFF_STATS.manual++;
            if (!ctx.HANDOFF_STATS.since) ctx.HANDOFF_STATS.since = new Date().toISOString();
            ctx.saveState();
          }
          return sendJson(res, 200, {
            ok: true, edges: ctx.HANDOFF.edges, stats: ctx.HANDOFF_STATS,
            gates: ctx.GATES.filter(g => g.state === 'waiting').map(g => ({
              gate_id: g.gate_id, from: g.from, to: g.to, at: g.at,
              preview: (g.text || '').slice(0, 160),
            })),
          });
        }
        if (p === '/api/gate') {
          const g = ctx.GATES.find(x => x.gate_id === reqBody.gate_id && x.state === 'waiting');
          if (!g) return sendJson(res, 400, { error: 'gate not found' });
          if (reqBody.act === 'release') {
            g.state = 'released';
            ctx.HANDOFF_STATS.gated_released++;
            ctx.saveState();
            handleStream(g.to, crossTaskText(g.to, g.text, g.from), () => {},
              (g.chain || [g.from]).concat([g.to])).catch(() => {});
          } else {
            g.state = 'dropped';
            ctx.saveState();
          }
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/clear-context') {
          const eng = reqBody.engine;
          const engines = [null, 'both', 'all'].includes(eng) ? Object.keys(ctx.STATE) : [eng];
          for (const e of engines) if (ctx.STATE[e]) { ctx.STATE[e].id = null; ctx.STREAK[e] = 0; }
          ctx.saveState();
          return sendJson(res, 200, { ok: true, cleared: engines });
        }
        if (p === '/api/agent-cwd') {
          const eng = reqBody.engine;
          let cwd = (reqBody.cwd || '').trim();
          if (!ctx.STATE[eng]) return sendJson(res, 400, { error: 'bad engine' });
          const expanded = cwd.replace(/^~/, os.homedir());
          if (cwd && !fs.existsSync(expanded)) return sendJson(res, 400, { error: `directory not found: ${cwd}` });
          cwd = cwd ? expanded : (ctx.SETTINGS.project || HERE);
          ctx.STATE[eng].cwd = cwd; ctx.STATE[eng].id = null; ctx.STREAK[eng] = 0;
          ctx.saveState();
          return sendJson(res, 200, { ok: true, cwd });
        }
        if (p === '/api/stop') {
          const pane = reqBody.pane;
          const targets = [null, '', 'both', 'all'].includes(pane) ? Object.keys(ctx.STATE) : [pane];
          const stopped = [];
          for (const pp of targets) {
            const proc = ctx.RUNNING[pp];
            if (proc && proc.exitCode === null) {
              try { proc.kill('SIGTERM'); stopped.push(pp); } catch {}
            }
          }
          return sendJson(res, 200, { ok: true, stopped });
        }
        if (p === '/api/pane-engine') {
          const pane = reqBody.pane, eng = reqBody.engine;
          if (!ctx.STATE[pane] || !['claude', 'codex'].includes(eng)) return sendJson(res, 400, { error: 'bad pane/engine' });
          ctx.STATE[pane].engine = eng; ctx.STATE[pane].id = null; ctx.STREAK[pane] = 0;
          ctx.AGENT_CFG[pane] = ctx.defaultCfg(eng);
          ctx.saveState();
          return sendJson(res, 200, { ok: true, pane, engine: eng });
        }
        if (p === '/api/pane-remote') {
          const pane = reqBody.pane, remote = reqBody.remote || null;
          if (!ctx.STATE[pane]) return sendJson(res, 400, { error: 'bad pane' });
          // 白名單:未經檢查的 remote 會落磁碟並影響該 pane 之後每一輪
          const chk1 = ctx.allowedRemote(remote, readSshHosts());
          if (!chk1.ok) return sendJson(res, 400, { error: chk1.reason });
          ctx.STATE[pane].remote = chk1.value; ctx.STATE[pane].id = null;
          ctx.saveState();
          return sendJson(res, 200, { ok: true, pane, remote });
        }
        if (p === '/api/reset') {
          for (const e of Object.keys(ctx.STATE)) { ctx.STATE[e].id = null; ctx.STATE[e].cwd = HERE; ctx.STREAK[e] = 0; }
          ctx.saveState();
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/open-file') {
          let raw = (reqBody.path || '').trim();
          const pane = reqBody.pane;
          if (!raw) return sendJson(res, 400, { error: 'no path' });
          raw = raw.replace(/^~/, os.homedir());
          let cands;
          if (path.isAbsolute(raw)) cands = [raw];
          else {
            const bases = [ctx.STATE[pane] && ctx.STATE[pane].cwd, ctx.SETTINGS.project, HERE].filter(Boolean);
            cands = bases.map(b => path.join(b, raw));
          }
          const resolved = cands.find(c => fs.existsSync(c));
          if (!resolved) return sendJson(res, 404, { error: 'not found', tried: cands });
          try {
            const isDir = fs.statSync(resolved).isDirectory();
            const args = process.platform === 'darwin'
              ? (isDir ? ['open', resolved] : ['open', '-R', resolved])
              : ['xdg-open', isDir ? resolved : path.dirname(resolved)];
            spawn(args[0], args.slice(1), { stdio: 'ignore', detached: true }).unref();
            return sendJson(res, 200, { ok: true, resolved });
          } catch (e) { return sendJson(res, 500, { error: String(e) }); }
        }
        return sendJson(res, 404, { error: 'not found' });
      }

      send(res, 405, 'method not allowed', 'text/plain');
    } catch (e) {
      try { sendJson(res, 500, { error: String((e && e.stack) || e) }); } catch {}
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Moirai running  ->  http://localhost:${port}`);
      console.log(`  platform : ${process.platform}`);
      console.log(`  Claude CLI : ${discovered.claudeBin || 'not found (set DUO_CLAUDE_BIN or install Claude Code)'}`);
      console.log(`  Claude titles : ${discovered.claudeSess ? 'desktop app index' : 'CLI projects jsonl (aiTitle)'}`);
      console.log(`  Codex CLI  : ${discovered.codexBin || 'not found (set DUO_CODEX_BIN or install Codex)'}`);
      console.log(`  Codex home : ${discovered.codexHome}`);
      resolve({
        server, port,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}
