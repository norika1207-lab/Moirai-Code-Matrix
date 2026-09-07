// 一次性批次工具:幫 title 為空的舊 session 用 AI 生成有意義的標題,寫進 Code-Matrix 自己的
// 覆寫層(duo_overrides.json),不碰官方 CLI 的 session 檔案。
// 用法: node scripts/backfill-titles.mjs [claude|codex] [--dry-run]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { discover } from '../src/discover.js';
import { makeState } from '../src/state.js';
import { makeMetaCache, makeClaudeGroups, makeSessions } from '../src/sessions.js';
import { makeOverrides } from '../src/overrides.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.join(__dirname, '..');

const engine = process.argv[2] === 'codex' ? 'codex' : 'claude';
const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const discovered = discover();
discovered.HERE = HERE;
const ctx = makeState(HERE);
ctx.loadState();
const metaCache = makeMetaCache(HERE);
const claudeGroups = makeClaudeGroups(HERE);
const sessionsApi = makeSessions(discovered, metaCache, claudeGroups, ctx);
const overrides = makeOverrides(HERE);

function transcriptDigest(msgs, maxChars = 2200) {
  // 只取前幾則往來就夠 AI 判斷這段在幹嘛,不用整份逐字稿(有些很長,浪費 token)
  let out = '';
  for (const m of msgs.slice(0, 8)) {
    const line = `[${m.role === 'user' ? '使用者' : 'AI'}] ${m.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

async function genTitle(digest) {
  const prompt = '下面是一段 AI 對話紀錄的開頭幾則往來,請用不超過 18 個中文字幫它取一個看得懂在做什麼的標題,'
    + '不要加引號、不要加句號、不要解釋,只回傳標題本身一行:\n\n' + digest;
  const bin = discovered.claudeBin;
  if (!bin) throw new Error('claude CLI not found');
  // --no-session-persistence:這只是問一句話取標題,不該在 ~/.claude/projects 底下留下一筆新 session
  // (踩過的坑:沒加這個旗標時,每呼叫一次就自己生一筆空標題 session,回填 47 筆舊資料反而多製造 47 筆新垃圾)
  const { stdout } = await execFileAsync(bin, ['-p', prompt, '--output-format', 'json', '--no-session-persistence'], { maxBuffer: 10 * 1024 * 1024 });
  const d = JSON.parse(stdout);
  let title = (d.result || '').trim().replace(/^["「『]|["」』]$/g, '').replace(/\n/g, ' ').slice(0, 40);
  return title || null;
}

async function main() {
  const rows = sessionsApi.listSessions(engine, 1000);
  let empty = rows.filter(r => !(r.title || '').trim());
  const totalEmpty = empty.length;
  if (Number.isFinite(limit)) empty = empty.slice(0, limit);
  console.log(`[${engine}] title 為空: ${totalEmpty} 筆 / 總共 ${rows.length} 筆,本次處理 ${empty.length} 筆${dryRun ? '  (dry-run,不會真的寫入)' : ''}`);

  let ok = 0, fail = 0;
  for (const [i, r] of empty.entries()) {
    process.stdout.write(`(${i + 1}/${empty.length}) ${r.id.slice(0, 8)} ... `);
    try {
      const msgs = sessionsApi.readTranscript(engine, r.id);
      if (!msgs.length) { console.log('無逐字稿,跳過'); continue; }
      const digest = transcriptDigest(msgs);
      const title = await genTitle(digest);
      if (!title) { console.log('AI 沒給出標題,跳過'); fail++; continue; }
      console.log(title);
      if (!dryRun) overrides.patch(engine, r.id, { title });
      ok++;
    } catch (e) {
      console.log('失敗:', e.message);
      fail++;
    }
  }
  console.log(`\n完成: 成功 ${ok} 筆,失敗/跳過 ${fail} 筆`);
}

main().catch(e => { console.error(e); process.exit(1); });
