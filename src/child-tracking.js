// 追蹤 spawn 出去的 claude/codex CLI 子行程 pid，避免 server 重啟後留下孤兒行程互撞。
// 對應 app.py 的 _reg_child / _unreg_child / _reap_orphans。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function makeChildTracker(HERE) {
  const CHILDREN_PATH = path.join(HERE, 'duo_children.json');

  function readPids() {
    try { return new Set(JSON.parse(fs.readFileSync(CHILDREN_PATH, 'utf8'))); }
    catch { return new Set(); }
  }
  function writePids(pids) {
    try { fs.writeFileSync(CHILDREN_PATH, JSON.stringify([...pids])); } catch {}
  }
  function regChild(pid) {
    const pids = readPids(); pids.add(pid); writePids(pids);
  }
  function unregChild(pid) {
    const pids = readPids(); pids.delete(pid); writePids(pids);
  }
  function reapOrphans() {
    const killed = [];
    for (const pid of readPids()) {
      try {
        const out = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' });
        if (out && (out.includes('claude') || out.includes('codex')) && (out.includes('-p ') || out.includes('exec'))) {
          process.kill(pid, 'SIGKILL');
          killed.push(pid);
        }
      } catch {}
    }
    writePids(new Set());
    if (killed.length) console.log('  reaped orphaned CLI children from a previous run:', killed);
  }

  return { regChild, unregChild, reapOrphans };
}
