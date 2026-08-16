/**
 * Unit tests for the plugin stream wrapper (llm/stream listener).
 * @module dsh-run-guard/test/stream
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuard, guardMessage, REASONING_GUARD_CODE } from '../lib/guard.js';

/** 扁平 guard 配置(applyGuard 直接消费,不经合并入口)。 */
const GUARD_CFG = {
  enabled: true,
  windowChars: 2000,
  substrLen: 32,
  repeatRatio: 0.7,
  checkEvery: 50,
  maxBlocks: 10000,
  maxChars: 500000,
};

/** Minimal Cordis-like context capturing listeners and logs. */
function createFakeCtx() {
  const listeners = new Map();
  const logs = [];
  const ctx = {
    logger: {
      warn: (...args) => logs.push(['warn', ...args]),
      info: (...args) => logs.push(['info', ...args]),
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _logs: logs,
  };
  return ctx;
}

/** Collect all chunks of an async iterable into an array. */
async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

async function* chunkStream(blocks) {
  for (const b of blocks) yield b;
}

/** Dead-loop reasoning delta: same long sentence each block. */
const DEAD_PHRASE =
  '正在等待构建结果,当前状态没有任何变化,继续轮询检查流水线执行状态,没有新的输出信息,重复执行相同检查步骤。';
const deadDelta = () => ({ type: 'reasoning-delta', index: 0, text: DEAD_PHRASE });

/** Normal reasoning delta: character-level unique text. */
function normalDelta(i) {
  let state = (i + 1) >>> 0;
  let s = '';
  while (s.length < 60) {
    state = (state * 1664525 + 1013904223) >>> 0;
    s += state.toString(36);
  }
  return { type: 'reasoning-delta', index: 0, text: s };
}

test('注册 llm/stream 监听器', () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, GUARD_CFG);
  assert.equal(ctx._listeners('llm/stream').length, 1);
});

test('enabled=false:监听器直接返回 next() 原流', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, { ...GUARD_CFG, enabled: false });
  const listener = ctx._listeners('llm/stream')[0];
  const original = chunkStream([{ type: 'text-delta', index: 0, text: 'hi' }]);
  const result = listener({}, () => original);
  assert.equal(result, original, '应原样返回 next() 的流');
  const chunks = await collect(result);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'text-delta');
});

test('正常流:所有 chunk 原样透传,无 finish 注入', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, GUARD_CFG);
  const listener = ctx._listeners('llm/stream')[0];
  const blocks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    normalDelta(1),
    normalDelta(2),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '...' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  assert.deepEqual(chunks, blocks, '应原样透传全部 chunk');
});

test('死循环流:注入 finish error 并终止,后续块不再输出', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, GUARD_CFG);
  const listener = ctx._listeners('llm/stream')[0];
  // 500 块死循环 reasoning
  const blocks = Array.from({ length: 500 }, deadDelta);
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  // 应包含一个 finish error chunk,且它是最后一个(之后被 return 截断)
  const finish = chunks.find((c) => c.type === 'finish');
  assert.ok(finish, '应注入 finish chunk');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, REASONING_GUARD_CODE);
  assert.equal(chunks[chunks.length - 1], finish, 'finish 后不应有更多 chunk');
  // 死循环 500 块不应全部透传(触发后截断)
  assert.ok(chunks.length < 500, `应提前截断,实际透传 ${chunks.length} 块`);
  // 应有日志
  assert.ok(ctx._logs.some((l) => l[0] === 'warn' && l[1].includes('触发中断')), '应有中断日志');
});

test('非 reasoning chunk 不计入检测(死循环只在 reasoning 上触发)', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, GUARD_CFG);
  const listener = ctx._listeners('llm/stream')[0];
  // 大量重复的 text-delta(不是 reasoning-delta):不应触发
  const blocks = Array.from({ length: 2000 }, (_, i) => ({
    type: 'text-delta',
    index: 0,
    text: '同样的文本反复出现反复出现',
  }));
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  assert.ok(!chunks.some((c) => c.type === 'finish' && c.reason?.kind === 'error'), 'text-delta 重复不应触发护栏');
  assert.equal(chunks.length, 2000);
});

test('退化配置(windowChars<substrLen):检测器不炸流,完整透传', async () => {
  const ctx = createFakeCtx();
  // 该组合曾触发 trimWindow 的 NaN bug;守护"检测器缺陷不伤害正常流"的降级承诺
  applyGuard(ctx, { ...GUARD_CFG, windowChars: 64, substrLen: 128, checkEvery: 1 });
  const listener = ctx._listeners('llm/stream')[0];
  const blocks = [
    normalDelta(1),
    normalDelta(2),
    { type: 'text-delta', index: 0, text: '普通文本' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  // 流必须完整结束:最后一个 chunk 是原来的 finish
  assert.equal(chunks[chunks.length - 1].type, 'finish');
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop', '原 finish 不被替换');
  // 不得注入护栏的 REASONING_GUARD finish(降级=检测失效,但绝不伪造中断)
  assert.ok(
    !chunks.some((c) => c.type === 'finish' && c.reason?.failure?.code === REASONING_GUARD_CODE),
    '退化配置下不应注入护栏错误'
  );
  // 透传块保持原样
  assert.deepEqual(chunks.slice(0, 3), blocks.slice(0, 3), '全部块原样透传');
});

test('触发前透传块保持原顺序(截断不重排)', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, { ...GUARD_CFG, checkEvery: 1 });
  const listener = ctx._listeners('llm/stream')[0];
  // 开头一块正常推理(不触发),随后大量死循环块
  const blocks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    normalDelta(1),
    ...Array.from({ length: 30 }, deadDelta),
  ];
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  // 触发前已透传的块必须保持原样与顺序
  assert.deepEqual(chunks[0], blocks[0], 'block-start 原样');
  assert.deepEqual(chunks[1], blocks[1], '正常推理块原样');
  // 以护栏 finish error 结束,且不重排
  const finish = chunks[chunks.length - 1];
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.failure.code, REASONING_GUARD_CODE);
});

test('硬闸配置:maxBlocks 小值时触发 blocks 中断', async () => {
  const ctx = createFakeCtx();
  applyGuard(ctx, { ...GUARD_CFG, maxBlocks: 120, checkEvery: 1 });
  const listener = ctx._listeners('llm/stream')[0];
  const blocks = Array.from({ length: 500 }, (_, i) => normalDelta(i));
  const result = listener({}, () => chunkStream(blocks));
  const chunks = await collect(result);
  const finish = chunks.find((c) => c.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.reason.failure.code, REASONING_GUARD_CODE);
  // 用户可见的提示应说明原因(中文),并给出建议
  const msg = finish.reason.failure.message;
  assert.ok(msg.includes('推理护栏'), '消息应说明是护栏中断');
  assert.ok(msg.includes('推理块数超过上限'), '消息应说明触发原因(blocks)');
  assert.ok(msg.includes('保护性中断'), '消息应给出建议说明');
});

test('guardMessage:repeat 触发时说明重复率原因', () => {
  const cfg = GUARD_CFG;
  const msg = guardMessage(
    { triggered: true, reason: 'repeat', ratio: 0.805, blocks: 150, chars: 621 },
    cfg
  );
  assert.ok(msg.includes('重复率异常'), '应说明重复率原因');
  assert.ok(msg.includes('0.805'), '应包含触发时重复率');
  assert.ok(msg.includes('150'), '应包含触发时块数');
  assert.ok(msg.includes('保护性中断'), '应给出建议');
});

test('guardMessage:chars 触发时说明字符数原因', () => {
  const cfg = GUARD_CFG;
  const msg = guardMessage(
    { triggered: true, reason: 'chars', blocks: 8000, chars: 500052 },
    cfg
  );
  assert.ok(msg.includes('字符数超过上限'), '应说明字符数原因');
  assert.ok(msg.includes('500052'), '应包含触发时字符数');
  assert.ok(!msg.includes('重复率'), 'chars 触发不涉及重复率');
});
