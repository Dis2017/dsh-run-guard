/**
 * Unit tests for the sliding-window reasoning guard detector.
 * @module dsh-run-guard/test/guard
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningGuard } from '../lib/guard.js';

/** Small config for fast tests (check every block). */
const cfg = (overrides = {}) => ({
  substrLen: 32,
  windowChars: 2000,
  repeatRatio: 0.7,
  checkEvery: 1,
  maxBlocks: 10000,
  maxChars: 500000,
  ...overrides,
});

/**
 * Dead-loop block: one long sentence repeated verbatim, mirroring the real
 * incident (the model emitted the same phrase over and over).
 */
const DEAD_PHRASE =
  '正在等待构建结果,当前状态没有任何变化,继续轮询检查流水线执行状态,没有新的输出信息,重复执行相同检查步骤。';

function* deadLoopBlocks(count) {
  for (let i = 0; i < count; i++) yield DEAD_PHRASE;
}

/**
 * Normal block: a character-level unique pseudo-random string, so neither
 * intra-block nor inter-block repetition exists (unlike real templates,
 * which would share 32-char substrings and pollute the repeat ratio).
 */
function pseudoRandomUnique(seed) {
  let state = seed >>> 0;
  let s = '';
  while (s.length < 60) {
    state = (state * 1664525 + 1013904223) >>> 0;
    s += state.toString(36);
  }
  return s;
}

function* normalBlocks(count) {
  for (let i = 0; i < count; i++) yield pseudoRandomUnique(i + 1);
}

test('死循环:重复短语触发 repeat 中断', () => {
  const guard = createReasoningGuard(cfg());
  let verdict = null;
  let i = 0;
  for (const text of deadLoopBlocks(500)) {
    i++;
    const v = guard.push(text);
    if (v?.triggered) { verdict = v; break; }
  }
  assert.ok(verdict, '死循环应在窗口预热后触发');
  assert.equal(verdict.reason, 'repeat');
  assert.ok(verdict.ratio >= 0.7, `ratio=${verdict.ratio} 应达到阈值`);
  assert.ok(i < 100, `触发块数 ${i} 应远小于死循环规模`);
});

test('正常推理:10 万块唯一文本不触发', () => {
  // 硬闸放大,本测试只验证重复检测路径不误伤
  const guard = createReasoningGuard(cfg({ maxBlocks: 1e9, maxChars: 1e9 }));
  let verdict = null;
  let blocks = 0;
  for (const text of normalBlocks(100000)) {
    blocks++;
    const v = guard.push(text);
    if (v?.triggered) { verdict = v; break; }
  }
  assert.equal(verdict, null, '正常流不应触发');
  assert.equal(blocks, 100000);
});

test('硬闸 blocks:超块数上限触发', () => {
  const guard = createReasoningGuard(cfg({ maxBlocks: 150 }));
  let verdict = null;
  let i = 0;
  for (const text of normalBlocks(1000)) {
    i++;
    const v = guard.push(text);
    if (v?.triggered) { verdict = v; break; }
  }
  assert.ok(verdict, '应触发');
  assert.equal(verdict.reason, 'blocks');
  assert.equal(verdict.blocks, 150);
});

test('硬闸 chars:超字符上限触发', () => {
  const guard = createReasoningGuard(cfg({ maxChars: 5000 }));
  let verdict = null;
  let i = 0;
  for (const text of normalBlocks(1000)) {
    i++;
    const v = guard.push(text);
    if (v?.triggered) { verdict = v; break; }
  }
  assert.ok(verdict, '应触发');
  assert.equal(verdict.reason, 'chars');
  assert.ok(verdict.chars >= 5000, `chars=${verdict.chars} 应达到上限`);
});

test('降频:checkEvery=50 时每 50 块检查一次', () => {
  const guard = createReasoningGuard(cfg({ checkEvery: 50 }));
  let checks = 0;
  for (const text of deadLoopBlocks(200)) {
    const v = guard.push(text);
    if (v !== null) checks++;
  }
  // 200 块 / 50 = 4 次检查
  assert.equal(checks, 4);
});

test('空文本与短文本:不产生子串但累计计数', () => {
  const guard = createReasoningGuard(cfg({ checkEvery: 1000000 }));
  assert.equal(guard.push(''), null);
  assert.equal(guard.push('短'), null); // 长度 < substrLen
  const s = guard.stats();
  assert.equal(s.blocks, 2);
  assert.equal(s.chars, 1); // '' 0 字符 + '短' 1 字符
  assert.equal(s.totalSubstrs, 0);
});

test('窗口滑动:过去的重复被滑出,不会永久抬高 ratio', () => {
  // checkEvery 极大:全程不自动检查,只通过 stats 观察窗口状态
  const guard = createReasoningGuard(cfg({ checkEvery: Number.MAX_SAFE_INTEGER, windowChars: 2000 }));
  for (const text of deadLoopBlocks(400)) guard.push(text);
  const afterDead = guard.stats();
  assert.ok(afterDead.totalSubstrs > 0, '死循环阶段窗口内应有子串');
  assert.ok(
    afterDead.unique / afterDead.totalSubstrs < 0.1,
    `死循环阶段唯一子串占比应极低,实际 ${afterDead.unique}/${afterDead.totalSubstrs}`
  );
  // 灌入正常文本,窗口滑出重复内容
  for (const text of normalBlocks(3000)) guard.push(text);
  const afterNormal = guard.stats();
  assert.ok(afterNormal.totalSubstrs <= 2000 - 32 + 1, '窗口大小有上限');
  assert.ok(
    afterNormal.unique / afterNormal.totalSubstrs > 0.95,
    `正常阶段唯一子串占比应接近 1,实际 ${afterNormal.unique}/${afterNormal.totalSubstrs}`
  );
});

test('短文本流(每块 < substrLen):碎片重复触发 repeat', () => {
  // 真实死循环的 reasoning 块只有 1-9 字符,重复碎片也应被窗口捕获
  const guard = createReasoningGuard(cfg());
  let verdict = null;
  for (let i = 0; i < 500; i++) {
    const v = guard.push('重复');
    if (v?.triggered) { verdict = v; break; }
  }
  assert.ok(verdict);
  assert.equal(verdict.reason, 'repeat');
});

test('短文本流:正常碎片(无重复)不触发 repeat,硬闸 blocks 兜底', () => {
  const guard = createReasoningGuard(cfg({ maxBlocks: 20 }));
  let verdict = null;
  let state = 1;
  for (let i = 0; i < 30; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const v = guard.push(state.toString(36).slice(0, 2));
    if (v?.triggered) { verdict = v; break; }
  }
  assert.ok(verdict);
  assert.equal(verdict.reason, 'blocks');
});

test('跨块边界子串计数精确:小块碎片累加后 totalSubstrs 精确', () => {
  // windowChars=100, substrLen=8:窗口内子串数应精确等于 len(window)-substrLen+1
  const guard = createReasoningGuard(cfg({ windowChars: 100, substrLen: 8, checkEvery: 1000000 }));
  // 每块 3 字符的碎片流,累计 120 字符 → 窗口裁剪到 100
  for (let i = 0; i < 40; i++) guard.push('abc');
  const s = guard.stats();
  assert.equal(s.totalSubstrs, 100 - 8 + 1, '窗口内子串数应精确为 len(window)-substrLen+1');
  // 'abc' 循环的 8 字符子串有 3 种形态(周期 3),全部重复出现
  assert.equal(s.unique, 3, `'abc' 循环的 8 字符子串应恰好 3 种,实际 ${s.unique}`);
  // 再灌入完全不同的碎片,窗口滑出旧内容
  let state = 7;
  for (let i = 0; i < 40; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    guard.push(state.toString(36).slice(0, 3));
  }
  const s2 = guard.stats();
  assert.equal(s2.totalSubstrs, 93, '窗口滑出后子串数仍精确');
  assert.ok(s2.unique / s2.totalSubstrs > 0.9, '新内容应基本唯一');
});

test('极端配置:windowChars < substrLen 不崩溃、不误报、无 NaN', () => {
  // Config 允许 windowChars>=64 与 substrLen<=128,存在 windowChars < substrLen 的合法组合
  const guard = createReasoningGuard(cfg({ windowChars: 64, substrLen: 128, checkEvery: 1 }));
  let verdict = null;
  for (let i = 0; i < 200; i++) {
    const v = guard.push(`第${i}块推理内容用于验证极端配置稳定性。`);
    if (v?.triggered) { verdict = v; break; }
  }
  // 窗口(64)小于子串(128)时无法形成完整子串 → 重复检测退化但不应误报/崩溃
  assert.equal(verdict, null, '极端配置下正常文本不应误报');
  const s = guard.stats();
  assert.equal(s.totalSubstrs, 0, '窗口小于子串长度时不产生子串');
  assert.ok(Number.isFinite(s.totalSubstrs) && Number.isFinite(s.unique), '计数不得为 NaN');
  assert.equal(s.blocks, 200, '计数仍正常累计');
});
