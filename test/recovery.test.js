/**
 * Guard recovery tests: `agent/request-error` auto-retry after a guard fire.
 * @module dsh-run-guard/test/recovery
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuardRecovery, REASONING_GUARD_CODE } from '../lib/guard.js';
import { apply, resolveConfig } from '../lib/index.js';

const session = { id: 's1' };
const ev = (type, data) => ({ type, data });

function createCtx() {
  const listeners = new Map();
  const logs = [];
  const ctx = {
    logger: { warn: (...a) => logs.push(['warn', ...a]), info: () => {} },
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

/** 构造 request-error payload。 */
function errorPayload(overrides = {}) {
  return {
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    provider: 'opencode',
    failure: { message: 'x', code: REASONING_GUARD_CODE },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('REASONING_GUARD:前 maxGuardRetries 次返回 retry,超限返回 undefined', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined; // 模拟 llm-retry 不干预

  const r1 = await listener(errorPayload(), next);
  assert.deepEqual(r1, { kind: 'retry' }, '第 1 次应重试');
  const r2 = await listener(errorPayload(), next);
  assert.deepEqual(r2, { kind: 'retry' }, '第 2 次应重试');
  const r3 = await listener(errorPayload(), next);
  assert.equal(r3, undefined, '第 3 次(超限)不再重试');
  assert.ok(ctx._logs.some((l) => l[1].includes('自动重试 1/2')), '应记录重试日志');
});

test('非 REASONING_GUARD 错误:调用 next() 不干预', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  let nextCalled = 0;
  const next = async () => { nextCalled++; return undefined; };
  const r = await listener(errorPayload({ failure: { message: 'x', code: 'SERVER' } }), next);
  assert.equal(nextCalled, 1, '应把非 guard 错误交给下游');
  assert.equal(r, undefined);
});

test('turn/end 清理计数:新 turn 重新计数', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 1 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // turn 1:1 次重试后超限
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 1 }), next), undefined);
  // turn 1 结束清理
  emit(session, ev('turn/end', { turn: 1 }));
  // turn 2:重新计数
  assert.deepEqual(await listener(errorPayload({ turn: 2 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 2 }), next), undefined);
});

test('不同 turn 计数隔离', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  // turn 1 两次(超限)
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 1 }), next), undefined);
  // turn 2 不受影响
  assert.deepEqual(await listener(errorPayload({ turn: 2 }), next), { kind: 'retry' });
});

test('maxGuardRetries=0:禁用自动重试,立即 undefined', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 0 });
  const listener = ctx._listeners('agent/request-error')[0];
  const r = await listener(errorPayload(), async () => undefined);
  assert.equal(r, undefined, '0 表示不自动重试');
});

test('agent 缺失:不干预', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  let nextCalled = 0;
  const r = await listener(errorPayload({ agent: undefined }), async () => { nextCalled++; return undefined; });
  assert.equal(nextCalled, 1);
  assert.equal(r, undefined);
});

test('合并入口:apply 挂载 recovery(guard.enabled 时注册 agent/request-error)', () => {
  const ctx = createCtx();
  // 需要完整 ctx(apply 会调 applyContinue)
  ctx.systemPrompt = { context: () => {} };
  ctx.tools = { register: () => {} };
  ctx.agents = { get: () => undefined };
  ctx.sessions = { get: () => ({ append: () => {} }) };
  ctx.sessionPersistence = { readFrom: async () => ({ events: [] }) };
  apply(ctx, resolveConfig({}));
  assert.ok(ctx._listeners('agent/request-error').length >= 1, 'guard 开启时应注册 recovery');
  // guard.enabled=false 时不注册
  const ctx2 = createCtx();
  ctx2.systemPrompt = { context: () => {} };
  ctx2.tools = { register: () => {} };
  ctx2.agents = { get: () => undefined };
  ctx2.sessions = { get: () => ({ append: () => {} }) };
  ctx2.sessionPersistence = { readFrom: async () => ({ events: [] }) };
  apply(ctx2, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx2._listeners('agent/request-error').length, 0, 'guard 关闭时不注册 recovery');
});

test('resolveConfig 默认 maxGuardRetries=2,可覆盖', () => {
  const c = resolveConfig({});
  assert.equal(c.guard.maxGuardRetries, 2);
  const c2 = resolveConfig({ guard: { maxGuardRetries: 5 } });
  assert.equal(c2.guard.maxGuardRetries, 5);
});
