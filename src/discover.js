// 自動偵測 CLI 執行檔位置與 session 存放目錄。對應 app.py 的 discover()。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const SYS = process.platform === 'darwin' ? 'Darwin' : process.platform === 'win32' ? 'Windows' : 'Linux';

function firstDir(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

function which(name) {
  try { return execSync(`command -v ${name}`, { shell: '/bin/bash' }).toString().trim() || null; }
  catch { return null; }
}

function whichOr(name, extra) {
  return which(name) || extra.find(p => p && fs.existsSync(p)) || null;
}

export function discover() {
  const claudeBin = process.env.DUO_CLAUDE_BIN || whichOr('claude', [
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(HOME, '.local/bin/claude'), path.join(HOME, '.npm-global/bin/claude'),
    path.join(HOME, '.bun/bin/claude'),
  ]);
  const codexBin = process.env.DUO_CODEX_BIN || whichOr('codex', [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    path.join(HOME, '.local/bin/codex'),
  ]);

  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const claudeProj = path.join(cfg, 'projects');

  let sessCands;
  if (SYS === 'Darwin') {
    sessCands = [path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions')];
  } else if (SYS === 'Windows') {
    sessCands = [path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions')];
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    sessCands = [path.join(xdg, 'Claude', 'claude-code-sessions')];
  }
  const claudeSess = firstDir(sessCands);

  const cx = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const codexDirs = [path.join(cx, 'sessions'), path.join(cx, 'archived_sessions')];

  return {
    claudeBin, codexBin, claudeProj, claudeSess,
    codexHome: cx, codexDirs,
    codexIndex: path.join(cx, 'session_index.jsonl'),
    codexState: path.join(cx, '.codex-global-state.json'),
  };
}

export function readSshHosts() {
  const cfgPath = path.join(HOME, '.ssh', 'config');
  const hosts = [];
  try {
    const lines = fs.readFileSync(cfgPath, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (line.toLowerCase().startsWith('host ')) {
        for (const h of line.slice(5).split(/\s+/)) {
          if (h && !h.includes('*') && !h.includes('?') && !hosts.includes(h)) hosts.push(h);
        }
      }
    }
  } catch {}
  return hosts;
}

export { HOME, SYS };
