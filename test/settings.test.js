/**
 * Settings-namespace registration tests: `apply` prefers the `settings`
 * service when present (real DSH host), falls back to the Cordis config
 * argument otherwise, and degrades on registration failure.
 * @module dsh-run-guard/test/settings
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig, SETTINGS_NAMESPACE } from '../lib/index.js';

/** Full Cordis-like context with an injectable settings service. */
function createCtx({ settingsValue, registerThrows = false } = {}) {
  const listeners = new Map();
  const contextDefs = [];
  const tools = [];
  const registered = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context: (def) => contextDefs.push(def) },
    tools: { register: (def) => tools.push(def) },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: { readFrom: async () => ({ events: [] }) },
    inject(deps, callback) {
      if (deps.includes('settings')) callback(this);
    },
    settings: {
      register(ns, schema) {
        if (registerThrows) throw new Error('namespace already registered');
        registered.push({ ns, schema });
        return {
          get: () => settingsValue ?? {},
          watch: () => () => {},
          update: async () => {},
          replace: async () => {},
        };
      },
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _registered: registered,
    _tools: tools,
  };
  return ctx;
}

test('有 settings 服务时:注册 run-guard 命名空间并从 settings 值挂载', () => {
  const ctx = createCtx({ settingsValue: { guard: { maxGuardRetries: 5 } } });
  apply(ctx, resolveConfig({ guard: { maxGuardRetries: 1 } }));
  assert.equal(ctx._registered.length, 1, '应注册 settings 命名空间');
  assert.equal(ctx._registered[0].ns, SETTINGS_NAMESPACE);
  assert.ok(ctx._listeners('llm/stream').length >= 1, 'guard 应挂载');
  assert.ok(ctx._listeners('agent/request-error').length >= 1, 'recovery 应挂载');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 应挂载');
});

test('settings 值是配置源(覆盖 config 参数)', async () => {
  const ctx = createCtx({ settingsValue: { guard: { maxGuardRetries: 5 } } });
  apply(ctx, resolveConfig({ guard: { maxGuardRetries: 1 } }));
  // settings 值 maxGuardRetries=5 生效 → recovery listener 前 5 次都 retry
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const payload = () => ({
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    failure: { message: 'x', code: 'REASONING_GUARD' },
    signal: new AbortController().signal,
  });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await listener(payload(), next), { kind: 'retry' }, `第 ${i + 1} 次应重试`);
  }
  assert.equal(await listener(payload(), next), undefined, '第 6 次超限');
});

test('settings 注册抛错:退化为 config 参数', async () => {
  const ctx = createCtx({ registerThrows: true });
  apply(ctx, resolveConfig({ guard: { maxGuardRetries: 3 } }));
  assert.ok(ctx._listeners('llm/stream').length >= 1, '仍应挂载');
  // config 的 maxGuardRetries=3 生效
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const payload = () => ({
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    failure: { message: 'x', code: 'REASONING_GUARD' },
    signal: new AbortController().signal,
  });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await listener(payload(), next), { kind: 'retry' });
  }
  assert.equal(await listener(payload(), next), undefined);
});

test('无 inject 方法:直接使用 config 参数', () => {
  const listeners = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context: () => {} },
    tools: { register: () => {} },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: { readFrom: async () => ({ events: [] }) },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
  };
  apply(ctx, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 0, 'guard 关闭不挂载');
  assert.ok(ctx._listeners('session/event').length >= 1, 'continue 仍挂载');
});
