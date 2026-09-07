// remote 白名單的驗收測試。
// 存在理由:remote 是位置參數交給 ssh,ssh 把 '-' 開頭當選項解析,
// 所以 -oProxyCommand=<指令> 等於本機任意指令執行。隔壁的 claudeArgs 有 shquote,
// remote 沒有,防護正好漏這一個。三個入口(POST pane-remote、GET remote-login、
// cli-driver 執行前)共用這一支判斷。
import { makeState } from '../src/state.js';
import assert from 'node:assert/strict';

const ctx = makeState('/tmp');
const HOSTS = ['gx10', 'macmini', 'sportverse', 'mbp'];
const A = (r) => ctx.allowedRemote(r, HOSTS);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  pass  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};

console.log('攻擊向量：ssh 參數注入');
t('-oProxyCommand=... 被擋', () => assert.equal(A('-oProxyCommand=touch /tmp/pwned').ok, false));
t('--option= 形式也被擋', () => assert.equal(A('--rcfile=/tmp/evil').ok, false));
t('-o 分寫也被擋', () => assert.equal(A('-o').ok, false));
t('單一減號被擋', () => assert.equal(A('-').ok, false));

console.log('白名單本身');
t('清單內的主機放行', () => assert.equal(A('gx10').value, 'gx10'));
t('清單外的主機被擋（即使長得像正常主機名）', () => assert.equal(A('evil.example.com').ok, false));
t('拼錯的主機被擋', () => assert.equal(A('gx11').ok, false));
t('空值代表用本機，合法', () => { const r = A(''); assert.equal(r.ok, true); assert.equal(r.value, null); });
t('null 代表用本機，合法', () => { const r = A(null); assert.equal(r.ok, true); assert.equal(r.value, null); });

console.log('型別與邊界');
t('非字串被擋', () => assert.equal(A({ toString: () => 'gx10' }).ok, false));
t('被擋時附得出理由', () => assert.match(A('-oProxyCommand=x').reason, /ssh|選項|清單/));
t('主機名前後不做 trim（避免 " gx10" 這種繞過想像空間）', () =>
  assert.equal(A(' gx10').ok, false));

console.log(`\n${pass} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
