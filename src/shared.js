// 共享內容池：四個視窗共讀同一份池子，並鏡射進 memory.md（滿了自動滾到 memory-2.md...）。
// 對應 app.py 的 _shared_add / _shared_preamble / _mem_* 那一段。
import fs from 'node:fs';
import path from 'node:path';

const MEM_MAX = 1_000_000; // bytes

export function makeShared(ctx, HERE) {
  const { SHARED, SHARED_SEEN, SETTINGS, pname, saveState } = ctx;

  function memDir() { return SETTINGS.project || HERE; }

  function memFiles() {
    const d = memDir();
    const out = [];
    const first = path.join(d, 'memory.md');
    if (fs.existsSync(first)) out.push(first);
    let i = 2;
    while (true) {
      const p = path.join(d, `memory-${i}.md`);
      if (!fs.existsSync(p)) break;
      out.push(p); i++;
    }
    return out;
  }

  function memTarget() {
    const d = memDir();
    const files = memFiles();
    if (!files.length) return path.join(d, 'memory.md');
    const last = files[files.length - 1];
    try {
      if (fs.statSync(last).size >= MEM_MAX) return path.join(d, `memory-${files.length + 1}.md`);
    } catch {}
    return last;
  }

  function memAppend(e) {
    const p = memTarget();
    try {
      const fresh = !fs.existsSync(p);
      let chunk = '';
      if (fresh) {
        chunk += '# Moirai 共享記憶\n\n'
          + '四個視窗共用這一份。每一輪的指令與產出都自動寫進來,原文照錄,不摘要、不截斷。\n'
          + '檔案寫滿會自動接到 memory-2.md、memory-3.md;四個視窗都會被告知全部檔案。\n\n';
      }
      const now = new Date();
      const ts = now.toISOString().slice(0, 19).replace('T', ' ');
      chunk += `## [${e.seq}] ${pname(e.pane)} · ${e.role === 'user' ? '指令' : '產出'} · ${ts}\n\n${e.text}\n\n`;
      fs.appendFileSync(p, chunk, 'utf8');
    } catch {}
  }

  function sharedAdd(pane, role, text) {
    text = (text || '').trim();
    if (!text) return;
    const seq = ctx.nextSeq();
    const e = { seq, pane, role, text };
    SHARED.push(e);
    memAppend(e);
    saveState();
  }

  function sharedPreamble(pane) {
    const seen = SHARED_SEEN[pane] || 0;
    let neu = SHARED.filter(e => e.seq > seen && e.pane !== pane);
    SHARED_SEEN[pane] = SHARED.length ? SHARED[SHARED.length - 1].seq : seen;
    neu = neu.filter(e => e.role === 'bot');
    if (!neu.length) return { body: '', n: 0, froms: [] };
    const files = memFiles();
    let hint = '';
    if (files.length) {
      hint = '完整的共享記憶存在這些檔案,需要更早的內容就自己讀它們(全部都要讀,不是只讀第一個):\n'
        + files.map(f => '  ' + f).join('\n') + '\n\n';
    }
    const blocks = neu.map(e => `[${pname(e.pane)} · 產出]\n${e.text}`);
    const body = '=== 共享內容 ===\n'
      + '以下是其他視窗到目前為止『產出的結果』(不是它們跟人對話的逐字)。四個視窗讀的是同一份共享內容,'
      + '這段是自動帶入的,不是使用者手打的。你可以直接引用它,不需要重複別人已經做完的事。\n\n'
      + hint
      + '以下是你還沒看過的部分:\n\n'
      + blocks.join('\n\n')
      + '\n\n=== 共享內容結束,以下才是這次要給你的指令 ===\n\n';
    const froms = [...new Set(neu.map(e => pname(e.pane)))].sort();
    return { body, n: neu.length, froms };
  }

  return { memDir, memFiles, memTarget, memAppend, sharedAdd, sharedPreamble };
}
