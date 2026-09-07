// 極簡版 shlex.quote：把一個參數包成可以安全塞進 shell 命令字串的形式(用於組 ssh 遠端指令)。
export function shquote(s) {
  s = String(s);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}
