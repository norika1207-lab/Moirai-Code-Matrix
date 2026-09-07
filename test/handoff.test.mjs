// M2 交接規則放行判斷的驗收測試。
// 存在理由:roundtrip 的迴圈上限如果算錯,會多跑一輪、多燒一次 token,
// 而那個偏移只有實跑才看得出來。抽成純函式之後改用測試證明,不再燒 token。
import { handoffDecision } from '../src/server.js';
import assert from 'node:assert/strict';

const D = (kind, from, to, chain, running = false) => handoffDecision({
  edge: { to, kind }, fromPane: from, chain, isRunning: running,
  maxHops: 4, maxRoundtrips: 1,
});

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  pass  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

console.log('direct：一次都不准回頭');
t('w1→w2 首次放行', () => assert.equal(D('direct', 'w1', 'w2', ['w1']), 'allow'));
t('w2→w1 回頭被擋（w1 已在鏈上）', () => assert.equal(D('direct', 'w2', 'w1', ['w1', 'w2']), 'loop'));
t('w2→w3 前進放行', () => assert.equal(D('direct', 'w2', 'w3', ['w1', 'w2']), 'allow'));

console.log('roundtrip：只准來回一次');
t('w1→w2 首次放行', () => assert.equal(D('roundtrip', 'w1', 'w2', ['w1']), 'allow'));
t('w2→w1 退回放行（這就是那一次來回）', () => assert.equal(D('roundtrip', 'w2', 'w1', ['w1', 'w2']), 'allow'));
t('w1→w2 第二次被擋（舊寫法在這裡會放行，多燒一輪）', () =>
  assert.equal(D('roundtrip', 'w1', 'w2', ['w1', 'w2', 'w1']), 'loop'));

console.log('其他防線');
t('下游正在跑 → busy', () => assert.equal(D('direct', 'w1', 'w2', ['w1'], true), 'busy'));
t('鏈長達上限 → hops', () => assert.equal(D('direct', 'w1', 'w2', ['a', 'b', 'c', 'd']), 'hops'));
t('busy 優先於 loop', () => assert.equal(D('direct', 'w2', 'w1', ['w1', 'w2'], true), 'busy'));

console.log(`\n${pass} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
