// 全域狀態管理 + 持久化。對應 app.py 的 STATE/SETTINGS/AGENT_CFG/SHARED 那一段。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

export function makeState(HERE) {
  const STATE = {
    w1: { engine: 'claude', id: null, cwd: HERE, remote: null },
    w2: { engine: 'codex', id: null, cwd: HERE, remote: null },
    w3: { engine: 'claude', id: null, cwd: HERE, remote: null },
    w4: { engine: 'codex', id: null, cwd: HERE, remote: null },
  };
  const SETTINGS = { project: null };
  // permission-mode 的合法值以 `claude --help` 為準:acceptEdits / auto / bypassPermissions
  // / manual / dontAsk / plan。沒有 'default' 這個值,舊版預設寫成 'default' 會讓 CLI 收到
  // 一個不存在的參數值。這裡改成 auto,並在 loadState 對舊存檔做遷移。
  const CLAUDE_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  const CODEX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  const CLAUDE_DEF = { model: '', mode: 'auto', effort: '', fast: false };
  const CODEX_DEF = { model: '', mode: 'read-only', effort: '' };
  const defaultCfg = (engine) => ({ ...(engine === 'claude' ? CLAUDE_DEF : CODEX_DEF) });
  function legalMode(engine, mode) {
    const set = engine === 'claude' ? CLAUDE_MODES : CODEX_MODES;
    return set.has(mode) ? mode : (engine === 'claude' ? 'auto' : 'read-only');
  }

  // ---- remote 白名單 ----
  // remote 會被當成位置參數交給 ssh(src/cli-driver.js:36)。ssh 把以 '-' 開頭的參數
  // 當選項解析,所以 remote 若是 -oProxyCommand=<指令> 就會在本機執行任意指令。
  // 隔壁的 claudeArgs 有經過 shquote,remote 沒有,防護正好漏掉這一個。
  // 用白名單而不是黑名單擋 '-':黑名單擋不完(--option=、-o 分寫、未來新選項),
  // 白名單則把可能值收斂成「使用者 ~/.ssh/config 裡真的存在的 Host」。
  // 三個入口共用這一支:/api/pane-remote(POST 落磁碟)、/api/remote-login(GET)、cli-driver 執行前。
  function allowedRemote(remote, knownHosts) {
    if (remote == null || remote === '') return { ok: true, value: null };   // 空 = 用本機,合法
    if (typeof remote !== 'string') return { ok: false, reason: 'remote 必須是字串' };
    if (remote.startsWith('-')) return { ok: false, reason: 'remote 不得以 - 開頭(會被 ssh 當選項解析)' };
    if (!Array.isArray(knownHosts) || !knownHosts.includes(remote)) {
      return { ok: false, reason: `remote 不在 ~/.ssh/config 的 Host 清單裡:${remote}` };
    }
    return { ok: true, value: remote };
  }
  const AGENT_CFG = {};
  for (const p of Object.keys(STATE)) AGENT_CFG[p] = defaultCfg(STATE[p].engine);

  const WRITABLE = new Set(['acceptEdits', 'bypassPermissions', 'auto', 'dontAsk', 'workspace-write', 'danger-full-access']);

  const SHARED = [];                                  // [{seq,pane,role,text}]
  const SHARED_SEEN = {};
  for (const p of Object.keys(STATE)) SHARED_SEEN[p] = 0;
  const NAMES = {};
  let SEQ = 0;

  const STREAK = { claude: 0, codex: 0 };
  const BEHAVIOR = [];
  const RUNNING = {};        // pane -> ChildProcess

  // ---- M2:交接規則 ----
  // 把「做完之後按一顆 → Audit」這個一次性動作,換成一條長期存在的邊。
  // 規則存在後端而不是瀏覽器,因為它必須在視窗關掉、頁面刷新之後仍然有效。
  // HandoffEdge { id, from, to, kind:'direct'|'gated'|'roundtrip', enabled }
  //   direct    = 上游 done 之後直接送出
  //   gated     = 停在閘門等人放行(閘門佇列見 GATES)
  //   roundtrip = 送去下游,允許再退回來源一次,超過上限就轉成閘門交給人
  const HANDOFF = { edges: [] };
  const GATES = [];          // [{gate_id, edge_id, from, to, text, at, state:'waiting'|'released'|'dropped'}]
  // 轉交計數:這是 M2 唯一的驗收指標,手動次數要能逐週往下掉
  const HANDOFF_STATS = { manual: 0, auto: 0, gated_released: 0, blocked_loop: 0, since: null };

  const PERSIST_PATH = path.join(HERE, 'duo_state.json');

  function pname(p) { return NAMES[p] || p; }

  function saveState() {
    try {
      fs.writeFileSync(PERSIST_PATH, JSON.stringify({
        state: STATE, agent_cfg: AGENT_CFG, project: SETTINGS.project,
        shared: SHARED, shared_seen: SHARED_SEEN, seq: SEQ, names: NAMES,
        handoff: HANDOFF, gates: GATES, handoff_stats: HANDOFF_STATS,
      }));
    } catch {}
  }

  function loadState() {
    let d;
    try { d = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8')); } catch { return; }
    for (const [p, v] of Object.entries(d.state || {})) {
      if (STATE[p] && v && typeof v === 'object') {
        for (const k of ['engine', 'id', 'cwd', 'remote']) {
          if (v[k] != null) STATE[p][k] = v[k];
        }
        if (!['claude', 'codex'].includes(STATE[p].engine)) STATE[p].engine = 'claude';
        if (!(STATE[p].cwd && fs.existsSync(STATE[p].cwd) && fs.statSync(STATE[p].cwd).isDirectory())) {
          STATE[p].cwd = HERE;
        }
      }
    }
    for (const [p, v] of Object.entries(d.agent_cfg || {})) {
      if (AGENT_CFG[p] && v && typeof v === 'object') {
        AGENT_CFG[p] = { ...defaultCfg(STATE[p].engine), ...v };
        // 舊存檔遷移:把非法的 mode(例如舊版預設的 'default')收斂回合法值,
        // 否則它會被原樣送進 --permission-mode。
        AGENT_CFG[p].mode = legalMode(STATE[p].engine, AGENT_CFG[p].mode);
      }
    }
    if (d.project && fs.existsSync(d.project) && fs.statSync(d.project).isDirectory()) {
      SETTINGS.project = d.project;
    }
    if (Array.isArray(d.shared)) {
      for (const e of d.shared) if (e && typeof e === 'object' && e.text) SHARED.push(e);
    }
    if (d.shared_seen && typeof d.shared_seen === 'object') {
      for (const [p, v] of Object.entries(d.shared_seen)) {
        if (p in SHARED_SEEN) { try { SHARED_SEEN[p] = parseInt(v) || 0; } catch {} }
      }
    }
    if (d.names && typeof d.names === 'object') {
      for (const [k, v] of Object.entries(d.names)) if (k in STATE && typeof v === 'string') NAMES[k] = v;
    }
    try { SEQ = parseInt(d.seq) || (SHARED.length ? SHARED[SHARED.length - 1].seq : 0); }
    catch { SEQ = SHARED.length ? SHARED[SHARED.length - 1].seq : 0; }

    // M2:交接規則與閘門佇列要跟著存檔一起活過重啟,否則「長期存在的規則」名不副實。
    if (d.handoff && Array.isArray(d.handoff.edges)) {
      HANDOFF.edges = d.handoff.edges.filter(e =>
        e && STATE[e.from] && STATE[e.to] && e.from !== e.to && ['direct', 'gated', 'roundtrip'].includes(e.kind));
    }
    if (Array.isArray(d.gates)) {
      for (const g of d.gates) if (g && g.state === 'waiting') GATES.push(g);
    }
    if (d.handoff_stats && typeof d.handoff_stats === 'object') {
      for (const k of ['manual', 'auto', 'gated_released', 'blocked_loop']) {
        HANDOFF_STATS[k] = parseInt(d.handoff_stats[k]) || 0;
      }
      HANDOFF_STATS.since = d.handoff_stats.since || null;
    }
  }

  function nextSeq() { return ++SEQ; }

  return {
    STATE, SETTINGS, AGENT_CFG, WRITABLE, SHARED, SHARED_SEEN, NAMES,
    STREAK, BEHAVIOR, RUNNING, PERSIST_PATH,
    HANDOFF, GATES, HANDOFF_STATS,
    pname, saveState, loadState, defaultCfg, nextSeq, legalMode, allowedRemote,
    get SEQ() { return SEQ; },
  };
}

export { HOME };
