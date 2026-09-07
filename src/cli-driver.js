// 驅動 claude / codex CLI，逐行解析 NDJSON 串流事件並 emit 給前端。
// 對應 app.py 的 run_stream_claude / run_stream_codex / handle_stream。
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fmtTool, sessionName } from './tool-format.js';
import { shquote } from './shquote.js';
import { readSshHosts } from './discover.js';

export function makeCliDriver(ctx, tracker, HERE, discovered) {
  const { STATE, AGENT_CFG, RUNNING, NAMES, saveState } = ctx;
  const { claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN } = discovered;

  // 執行前的最後一道。前面兩個 HTTP 入口已經擋過,這裡再擋一次的理由:
  // 舊存檔裡可能本來就存著未經檢查的 remote(白名單是今天才加的),
  // 那種值不會經過 HTTP 入口,會直接從 duo_state.json 載進 STATE。
  function safeRemote(pane, emit) {
    const raw = STATE[pane].remote;
    const chk = ctx.allowedRemote(raw, readSshHosts());
    if (chk.ok) return chk.value;
    emit({ engine: pane, k: 'text', t: `[remote 被擋下] ${chk.reason}` });
    return false;   // false 代表「有值但非法」,跟 null(本機執行)區分開
  }

  // 逐行讀 child.stdout，每一行呼叫 onLine(line)；行為對應 Python 的 `for line in p.stdout`
  function lineReader(child, onLine) {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      line = line.trim();
      if (line) onLine(line);
    });
    return rl;
  }

  async function runStreamClaude(pane, text, emit) {
    const { id: sid, cwd } = STATE[pane];
    const remote = safeRemote(pane, emit);
    if (remote === false) return '';   // 非法 remote:不執行,不 fallback 到本機(那會靜默改變行為)
    const cfg = { ...AGENT_CFG[pane] };
    const sname = sessionName(text, pane, NAMES);
    let cmd, args, popenCwd;

    if (remote) {
      const claudeArgs = ['claude', '-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
      if (sid) claudeArgs.push('--resume', sid); else claudeArgs.push('--name', sname);
      claudeArgs.push('--permission-mode', cfg.mode || 'auto');
      if (cfg.model) claudeArgs.push('--model', cfg.model);
      if (cfg.effort) claudeArgs.push('--effort', cfg.effort);
      claudeArgs.push('--settings', JSON.stringify({ fastMode: !!cfg.fast }));
      cmd = 'ssh';
      args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
        remote, claudeArgs.map(shquote).join(' ')];
      popenCwd = undefined;
    } else {
      if (!CLAUDE_BIN) { emit({ engine: pane, k: 'text', t: '[claude CLI not found]' }); return ''; }
      cmd = CLAUDE_BIN;
      args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
      if (sid) args.push('--resume', sid); else args.push('--name', sname);
      args.push('--permission-mode', cfg.mode || 'auto');
      if (cfg.model) args.push('--model', cfg.model);
      if (cfg.effort) args.push('--effort', cfg.effort);
      args.push('--settings', JSON.stringify({ fastMode: !!cfg.fast }));
      popenCwd = cwd || HERE;
    }

    let final = '', newsid = null, runOut = 0, streamed = false;
    const agentTuids = new Set();

    await new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: popenCwd, stdio: ['ignore', 'pipe', 'ignore'] });
      RUNNING[pane] = child;
      tracker.regChild(child.pid);

      lineReader(child, (line) => {
        let d;
        try { d = JSON.parse(line); } catch { return; }
        const t = d.type;
        if (t === 'stream_event') {
          const e = d.event || {};
          const et = e.type;
          if (et === 'message_start') {
            streamed = false;
          } else if (et === 'content_block_start' && (e.content_block || {}).type === 'text') {
            emit({ engine: pane, k: 'textstart' });
          } else if (et === 'content_block_delta') {
            const dl = e.delta || {};
            if (dl.type === 'text_delta' && dl.text) {
              streamed = true;
              emit({ engine: pane, k: 'textdelta', t: dl.text });
            } else if (dl.type === 'thinking_delta') {
              emit({ engine: pane, k: 'think', est: dl.estimated_tokens || 0 });
            }
          } else if (et === 'message_delta') {
            const ot = ((e.usage || {}).output_tokens) || 0;
            if (ot) { runOut += ot; emit({ engine: pane, k: 'usage', tot: runOut }); }
          }
        } else if (t === 'assistant') {
          for (const b of (d.message || {}).content || []) {
            if (b.type === 'text' && b.text) {
              if (!streamed) emit({ engine: pane, k: 'text', t: b.text });
            } else if (b.type === 'tool_use') {
              const nm = b.name || '';
              if (['Task', 'Agent'].includes(nm)) agentTuids.add(b.id);
              else emit({ engine: pane, k: 'tool', t: fmtTool(nm, b.input) });
            }
          }
        } else if (t === 'user') {
          for (const b of ((d.message || {}).content || [])) {
            if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
            if (agentTuids.has(b.tool_use_id)) continue;
            let con = b.content || '';
            if (Array.isArray(con)) con = con.map(x => (x && x.text) || '').join(' ');
            con = String(con).trim();
            if (con) emit({ engine: pane, k: 'toolout', t: con });
          }
        } else if (t === 'system') {
          const st = d.subtype || '';
          if (['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(st)) {
            emit({
              engine: pane, k: 'agent', id: d.task_id || '', st,
              name: d.subagent_type || '', desc: d.description || '',
              status: d.status || (d.patch || {}).status || '',
              sum: String(d.summary || ''), usage: d.usage || {},
            });
          } else if (st === 'compact_boundary') {
            const meta = d.compactMetadata || {};
            emit({ engine: pane, k: 'compact', pre: meta.preTokens || 0, trigger: meta.trigger || 'auto' });
          } else if (d.content && !['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(st)) {
            emit({ engine: pane, k: 'sysnote', t: String(d.content) });
          }
        } else if (t === 'result') {
          final = d.result || final;
          newsid = d.session_id;
          const rot = (d.usage || {}).output_tokens || 0;
          if (rot) emit({ engine: pane, k: 'usage', tot: rot });
        }
      });

      child.on('error', (e) => { emit({ engine: pane, k: 'text', t: `[error] ${e.message}` }); });
      child.on('close', (code) => {
        if (remote && !newsid && !final && code !== 0) {
          emit({ engine: pane, k: 'need_login', remote });
        }
        delete RUNNING[pane];
        tracker.unregChild(child.pid);
        resolve();
      });
    });

    if (newsid) { STATE[pane].id = newsid; saveState(); }
    return final;
  }

  async function runStreamCodex(pane, text, emit) {
    if (!CODEX_BIN) { emit({ engine: pane, k: 'text', t: '[codex CLI not found]' }); return ''; }
    const { id: tid, cwd } = STATE[pane];
    const cfg = { ...AGENT_CFG[pane] };
    const mode = cfg.mode || 'read-only';
    const flags = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode=${mode}`];
    if (ctx.WRITABLE.has(mode)) flags.push('-c', 'approval_policy=never');
    if (cfg.model) flags.push('-m', cfg.model);
    if (cfg.effort) flags.push('-c', `model_reasoning_effort=${cfg.effort}`);
    const args = tid ? ['exec', 'resume', tid, ...flags, text] : ['exec', ...flags, text];

    let final = '', newtid = null, runOut = 0;

    await new Promise((resolve) => {
      const child = spawn(CODEX_BIN, args, { cwd: cwd || HERE, stdio: ['ignore', 'pipe', 'ignore'] });
      RUNNING[pane] = child;
      tracker.regChild(child.pid);

      lineReader(child, (line) => {
        let d;
        try { d = JSON.parse(line); } catch { return; }
        if (d.type === 'thread.started') newtid = d.thread_id;
        if (d.type === 'turn.completed') {
          const u = d.usage || {};
          runOut += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
          emit({ engine: pane, k: 'usage', tot: runOut });
        }
        if (d.type === 'item.completed') {
          const it = (d.item && typeof d.item === 'object') ? d.item : {};
          const ty = it.type;
          if (ty === 'agent_message') {
            final = it.text || final;
            emit({ engine: pane, k: 'text', t: it.text || '' });
          } else if (ty === 'command_execution') {
            emit({ engine: pane, k: 'tool', t: '⌘ ' + String(it.command || '').slice(0, 120) });
          } else if (ty === 'file_change') {
            emit({ engine: pane, k: 'tool', t: '✎ ' + String(it.path || JSON.stringify(it.changes) || '').slice(0, 120) });
          }
        }
      });

      child.on('error', (e) => { emit({ engine: pane, k: 'text', t: `[error] ${e.message}` }); });
      child.on('close', () => {
        delete RUNNING[pane];
        tracker.unregChild(child.pid);
        resolve();
      });
    });

    if (newtid) { STATE[pane].id = newtid; saveState(); }
    return final;
  }

  return { runStreamClaude, runStreamCodex };
}
