// Claude Code terminal 風格的工具呼叫格式化：ToolName(關鍵參數)。對應 app.py 的 _fmt_tool。
// 完全不截斷：UI 必須是 CLI 回報內容的逐字呈現，才能跟 CLI 自己的 session jsonl 對得上。
import path from 'node:path';

function diffCounts(oldStr, newStr) {
  // 輕量版 diff：逐行比對新增/刪除行數(不需要完整 LCS，跟 Python difflib.ndiff 的行為在「+N -M」計數上等價足夠)
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');
  const oldSet = new Map();
  for (const l of oldLines) oldSet.set(l, (oldSet.get(l) || 0) + 1);
  const newSet = new Map();
  for (const l of newLines) newSet.set(l, (newSet.get(l) || 0) + 1);
  let add = 0, rem = 0;
  for (const [l, n] of newSet) add += Math.max(0, n - (oldSet.get(l) || 0));
  for (const [l, n] of oldSet) rem += Math.max(0, n - (newSet.get(l) || 0));
  return { add, rem };
}

export function fmtTool(name, inp) {
  inp = inp || {};
  if (name === 'Bash') return `Bash(${inp.command || ''})`;
  if (['Edit', 'Write', 'NotebookEdit', 'Read'].includes(name)) {
    const fp = String(inp.file_path || '');
    const base = path.basename(fp) || fp;
    if (name === 'Edit') {
      const { add, rem } = diffCounts(inp.old_string, inp.new_string);
      return `Edit(${base}) +${add} -${rem}`;
    }
    if (name === 'Write') {
      const n = String(inp.content || '').split('\n').length;
      return `Write(${base}) +${n}`;
    }
    return `${name}(${base})`;
  }
  if (['Grep', 'Glob'].includes(name)) return `${name}(${inp.pattern || ''})`;
  if (['WebFetch', 'WebSearch'].includes(name)) return `${name}(${inp.url || inp.query || ''})`;
  if (name === 'TodoWrite') return 'TodoWrite';
  if (name === 'Workflow') return `Workflow(${inp.name || inp.description || ''})`;
  return `${name}(${JSON.stringify(inp)})`;
}

export function sessionName(text, pane, NAMES) {
  const marker = '=== 共享內容結束,以下才是這次要給你的指令 ===\n\n';
  if (text.includes(marker)) text = text.split(marker).slice(1).join(marker);
  const base = text.trim().replace(/\n/g, ' ').slice(0, 35) || 'session';
  // 前綴詞來源:命名這個視窗時取的角色名稱(PM/Dev/Audit/QA 或自訂名),不是 pane id;
  // 前綴而非後綴,rail 列表一眼就看得出這個 session 是哪個視窗開的,不用點進去才知道。
  const label = (NAMES && NAMES[pane]) || pane || '';
  return label ? `${label}-${base}` : base;
}
