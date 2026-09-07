// session 掃描：列出歷史對話、讀取逐字稿、解析 Claude 桌面 App 的自訂群組(leveldb)。
// 對應 app.py 的 list_sessions / read_transcript / _claude_groups 那一大段。
import fs from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const SCAN_HEAD = 262144; // bytes：session 檔案可能高達數 GB，只讀檔頭

// ---------- 檔案 meta 快取(cwd/title/first message)，用 mtime+size 判斷是否需要重新解析 ----------
export function makeMetaCache(HERE) {
  const META_PATH = path.join(HERE, 'duo_meta_cache.json');
  let META = {};
  let dirty = false;

  function load() {
    try { META = JSON.parse(fs.readFileSync(META_PATH, 'utf8')) || {}; } catch { META = {}; }
  }
  function save() {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(META_PATH, JSON.stringify(META)); } catch {}
  }
  function cached(filePath, parseFn) {
    let st;
    try { st = fs.statSync(filePath); } catch { return {}; }
    const hit = META[filePath];
    if (hit && hit.mt === st.mtimeMs && hit.sz === st.size) return hit;
    const res = { ...(parseFn(filePath) || {}) };
    res.mt = st.mtimeMs; res.sz = st.size;
    META[filePath] = res;
    dirty = true;
    return res;
  }
  load();
  return { cached, save };
}

function headLines(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SCAN_HEAD);
    const n = fs.readSync(fd, buf, 0, SCAN_HEAD, 0);
    fs.closeSync(fd);
    const data = buf.slice(0, n).toString('utf8');
    let lines = data.split('\n');
    if (lines.length > 1) lines = lines.slice(0, -1);
    return lines;
  } catch { return []; }
}

function firstUserAndCwdClaude(filePath) {
  let cwd = null, first = '', title = '';
  try {
    for (const ln of headLines(filePath)) {
      if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      cwd = cwd || d.cwd;
      if (d.type === 'ai-title' && !title) title = d.aiTitle || d.title || '';
      if (!first && d.type === 'user') {
        const c = (d.message || {}).content;
        if (typeof c === 'string') first = c;
        else if (Array.isArray(c)) {
          for (const b of c) if (b.type === 'text') { first = b.text || ''; break; }
        }
      }
      if (cwd && first && title) break;
    }
  } catch {}
  return { cwd, title: title.replace(/\n/g, ' '), first: first.replace(/\n/g, ' ') };
}

function firstUserAndCwdCodex(filePath) {
  let cwd = null, first = '';
  try {
    for (const ln of headLines(filePath)) {
      if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      const t = d.type;
      const pl = (d.payload && typeof d.payload === 'object') ? d.payload : {};
      if (t === 'session_meta') cwd = cwd || pl.cwd;
      if (t === 'event_msg' && pl.type === 'user_message' && !first) first = pl.message || '';
      if (cwd && first) break;
    }
  } catch {}
  return { cwd, first: first.replace(/\n/g, ' ') };
}

function codexProjectLabels(discovered) {
  try {
    const d = JSON.parse(fs.readFileSync(discovered.codexState, 'utf8'));
    return d['electron-workspace-root-labels'] || {};
  } catch { return {}; }
}

function projName(cwd, labels) {
  if (labels && cwd in labels) return labels[cwd];
  if (cwd === HOME) return 'ungrouped (home)';
  const base = path.basename((cwd || '').replace(/\/$/, ''));
  return base || cwd || '(unknown)';
}

function codexTitleMap(discovered) {
  const m = {};
  try {
    const lines = fs.readFileSync(discovered.codexIndex, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      if (d.id && d.thread_name) m[d.id] = d.thread_name;
    }
  } catch {}
  return m;
}

// ---------- Chrome leveldb (snappy 壓縮 + table 格式) 解碼，讀 Claude 桌面 App 的自訂群組 ----------
function uvarint(buf, p) {
  let r = 0, s = 0;
  while (true) {
    const c = buf[p]; p++;
    r |= (c & 0x7f) << s;
    if (!(c & 0x80)) return [r, p];
    s += 7;
  }
}

function snappyDecompress(data) {
  // snappy 開頭是 varint 宣告「解壓後總長度」，先配置好整塊輸出 buffer 直接寫，
  // 避免像 Python bytearray.append 那樣逐 byte 增長時還去 Buffer.concat 整段歷史(那是 O(n²))。
  let p = 0, declaredLen = 0, s = 0;
  while (true) {
    const c = data[p]; p++;
    declaredLen |= (c & 0x7f) << s;
    if (!(c & 0x80)) break;
    s += 7;
  }
  const out = Buffer.alloc(declaredLen);
  let w = 0; // write cursor into out
  while (p < data.length) {
    const tag = data[p]; p++;
    const t = tag & 3;
    if (t === 0) {
      const v = tag >> 2;
      let l;
      if (v < 60) l = v + 1;
      else {
        const nb = v - 59;
        l = data.readUIntLE(p, nb) + 1; p += nb;
      }
      data.copy(out, w, p, p + l); p += l; w += l;
    } else {
      let l, off;
      if (t === 1) {
        l = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | data[p]; p += 1;
      } else if (t === 2) {
        l = (tag >> 2) + 1;
        off = data.readUIntLE(p, 2); p += 2;
      } else {
        l = (tag >> 2) + 1;
        off = data.readUIntLE(p, 4); p += 4;
      }
      // back-reference 可能與寫入區重疊(LZ77 常見手法)，必須逐 byte 複製，不能用 Buffer.copy(可能誤用 memmove 語意)
      const st = w - off;
      for (let i = 0; i < l; i++) out[w + i] = out[st + i];
      w += l;
    }
  }
  return out.subarray(0, w);
}

function ldbBlocks(b) {
  const blocks = [];
  if (b.length < 48) return blocks;
  const foot = b.slice(b.length - 48);
  let p = 0;
  let r;
  r = uvarint(foot, p); p = r[1]; // metaindex offset(unused)
  r = uvarint(foot, p); p = r[1]; // metaindex size(unused)
  let ioff, isz;
  r = uvarint(foot, p); ioff = r[0]; p = r[1];
  r = uvarint(foot, p); isz = r[0]; p = r[1];

  function rd(o, s) {
    const raw = b.slice(o, o + s);
    return b[o + s] === 1 ? snappyDecompress(raw) : raw;
  }
  const idx = rd(ioff, isz);
  const num = idx.readUInt32LE(idx.length - 4);
  const end = idx.length - 4 - num * 4;
  let ip = 0;
  let prev = Buffer.alloc(0);
  while (ip < end) {
    let sh, ns, vl;
    r = uvarint(idx, ip); sh = r[0]; ip = r[1];
    r = uvarint(idx, ip); ns = r[0]; ip = r[1];
    r = uvarint(idx, ip); vl = r[0]; ip = r[1];
    const key = Buffer.concat([prev.slice(0, sh), idx.slice(ip, ip + ns)]); ip += ns;
    const val = idx.slice(ip, ip + vl); ip += vl;
    prev = key;
    let o, s2, q;
    r = uvarint(val, 0); o = r[0]; q = r[1];
    r = uvarint(val, q); s2 = r[0]; q = r[1];
    try { blocks.push(rd(o, s2)); } catch {}
  }
  return blocks;
}

function scanGroups(text, groups, assign) {
  for (const m of text.matchAll(/"id":"(cg-[a-f0-9-]+)","name":"([^"]{1,80})"/g)) {
    if (!(m[1] in groups)) groups[m[1]] = m[2];
  }
  for (const m of text.matchAll(/"code:local_([a-f0-9-]+)":"(cg-[a-f0-9-]+)"/g)) {
    if (!(m[1] in assign)) assign[m[1]] = m[2];
  }
}

export function makeClaudeGroups(HERE) {
  const CG_PERSIST = path.join(HERE, 'duo_claude_groups.json');
  let cache = { mtime: 0, groups: {}, assign: {} };

  function get() {
    const ls = path.join(HOME, 'Library', 'Application Support', 'Claude', 'Local Storage', 'leveldb');
    let files = [];
    try {
      files = globSync(path.join(ls, '*')).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch {}
    const newest = files.length ? fs.statSync(files[0]).mtimeMs : 0;
    if (cache.mtime === newest && Object.keys(cache.groups).length) return [cache.groups, cache.assign];

    const groups = {}, assign = {};
    for (const f of files) {
      let raw;
      try { raw = fs.readFileSync(f); } catch { continue; }
      const plain = raw.toString('latin1').replace(/\x00/g, '');
      scanGroups(plain, groups, assign);
      if (f.endsWith('.ldb')) {
        try {
          for (const blk of ldbBlocks(raw)) {
            scanGroups(blk.toString('latin1').replace(/\x00/g, ''), groups, assign);
          }
        } catch {}
      }
    }
    if (Object.keys(groups).length) {
      try { fs.writeFileSync(CG_PERSIST, JSON.stringify({ groups, assign })); } catch {}
    } else {
      try {
        const d = JSON.parse(fs.readFileSync(CG_PERSIST, 'utf8'));
        Object.assign(groups, d.groups || {});
        Object.assign(assign, d.assign || {});
      } catch {}
    }
    cache = { mtime: newest, groups, assign };
    return [groups, assign];
  }

  return { get };
}

// ---------- 對外主函式 ----------
export function makeSessions(discovered, metaCache, claudeGroups, ctx) {
  const { STATE, SETTINGS } = ctx;

  function claudeMetaCached(f) {
    const m = metaCache.cached(f, (p) => firstUserAndCwdClaude(p));
    return { cwd: m.cwd, title: m.title || '', first: m.first || '' };
  }
  function codexMetaCached(f) {
    const m = metaCache.cached(f, (p) => firstUserAndCwdCodex(p));
    return { cwd: m.cwd, first: m.first || '' };
  }

  function listSessions(engine, limit = 300) {
    const rows = [];
    if (engine === 'claude') {
      const seen = new Set();
      if (discovered.claudeSess) {
        const [groups, assign] = claudeGroups.get();
        for (const f of globSync(path.join(discovered.claudeSess, '**', 'local_*.json'))) {
          let d;
          try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
          const cid = d.cliSessionId;
          if (!cid) continue;
          const cwd = d.cwd || d.originCwd || discovered.HERE;
          const sid = (d.sessionId || '').replace('local_', '');
          const grp = groups[assign[sid]];
          seen.add(cid);
          rows.push({
            id: cid, cwd, project: grp || projName(cwd),
            title: d.title || '', first: '',
            archived: !!d.isArchived,
            ts: Math.floor((d.lastActivityAt || d.createdAt || 0) / 1000),
          });
        }
      }
      const duoCwds = new Set(Object.values(STATE).map(s => s.cwd));
      if (SETTINGS.project) duoCwds.add(SETTINGS.project);
      for (const cwd of duoCwds) {
        const pdir = path.join(discovered.claudeProj, cwd.replace(/\//g, '-'));
        for (const f of globSync(path.join(pdir, '*.jsonl'))) {
          const sid = path.basename(f).slice(0, -6);
          if (seen.has(sid)) continue;
          seen.add(sid);
          const { cwd: c2, title, first } = claudeMetaCached(f);
          let ts; try { ts = Math.floor(fs.statSync(f).mtimeMs / 1000); } catch { ts = 0; }
          rows.push({ id: sid, cwd: c2 || cwd, project: projName(c2 || cwd), title, first, ts });
        }
      }
      rows.sort((a, b) => b.ts - a.ts);
      return rows.slice(0, limit);
    } else {
      const titles = codexTitleMap(discovered);
      const labels = codexProjectLabels(discovered);
      let files = [];
      for (const dd of discovered.codexDirs) files.push(...globSync(path.join(dd, '**', '*.jsonl')));
      files.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });
      for (const f of files.slice(0, limit)) {
        const { cwd: c0, first } = codexMetaCached(f);
        const cwd = c0 || discovered.HERE;
        const m = UUID_RE.exec(path.basename(f));
        const sid = m ? m[0] : null;
        if (sid) {
          let ts; try { ts = Math.floor(fs.statSync(f).mtimeMs / 1000); } catch { ts = 0; }
          rows.push({ id: sid, cwd, project: projName(cwd, labels), title: titles[sid] || '', first, ts });
        }
      }
      return rows;
    }
  }

  function findFile(engine, sid) {
    let hits = [];
    if (engine === 'claude') hits = globSync(path.join(discovered.claudeProj, '*', sid + '.jsonl'));
    else {
      for (const d of discovered.codexDirs) hits.push(...globSync(path.join(d, '**', `*${sid}*.jsonl`)));
    }
    return hits[0] || null;
  }

  function readTranscript(engine, sid) {
    const f = findFile(engine, sid);
    if (!f) return [];
    const msgs = [];
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { return []; }
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      if (engine === 'claude') {
        const t = d.type;
        if (t === 'user' || t === 'assistant') {
          const c = (d.message || {}).content;
          let txt = '';
          if (typeof c === 'string') txt = c;
          else if (Array.isArray(c)) txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('');
          if (txt.trim()) msgs.push({ role: t === 'user' ? 'user' : 'bot', text: txt });
        }
      } else {
        const pl = (d.payload && typeof d.payload === 'object') ? d.payload : {};
        if (d.type === 'event_msg') {
          if (pl.type === 'user_message') msgs.push({ role: 'user', text: pl.message || '' });
          else if (pl.type === 'agent_message') msgs.push({ role: 'bot', text: pl.message || '' });
        }
      }
    }
    return msgs;
  }

  return { listSessions, readTranscript, findFile };
}
