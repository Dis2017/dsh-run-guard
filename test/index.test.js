/**
 * Merge-entry smoke tests: `apply` mounts both halves (guard + continue)
 * under one config, and the master switch disables everything.
 * @module dsh-run-guard/test/index
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig, name } from '../lib/index.js';

/** Full Cordis-like context serving both halves. */
function createFullCtx() {
  const listeners = new Map();
  const contextDefs = [];
  const tools = [];
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
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _contextDefs: contextDefs,
    _tools: tools,
  };
  return ctx;
}

test('插件名称为 dsh-run-guard', () => {
  assert.equal(name, 'dsh-run-guard');
});

test('apply 挂载两个 half:llm/stream 监听 + pause_work 工具 + systemPrompt context', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  assert.equal(ctx._listeners('llm/stream').length, 1, 'guard 注册 llm/stream 监听');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 注册 pause_work 工具');
  assert.ok(ctx._contextDefs.some((d) => d.name === 'dsh-run-guard:todo-status'), 'continue 注册 systemPrompt context');
  assert.ok(ctx._listeners('session/event').length >= 1, 'continue 注册 session/event 监听');
});

test('enabled=false 时什么都不挂载', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ enabled: false }));
  assert.equal(ctx._listeners('llm/stream').length, 0);
  assert.equal(ctx._tools.length, 0);
  assert.equal(ctx._contextDefs.length, 0);
  assert.equal(ctx._listeners('session/event').length, 0);
});

test('子开关:guard.enabled=false 只挂 continue', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 0, 'guard 关闭时不注册流监听');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 仍挂载');
});

test('子开关:continue.enabled=false 只挂 guard', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ continue: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 1, 'guard 仍挂载');
  assert.equal(ctx._tools.length, 0, 'continue 关闭时不注册工具');
  assert.equal(ctx._contextDefs.length, 0);
});

test('resolveConfig 填充嵌套默认值', () => {
  const c = resolveConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.guard.repeatRatio, 0.7);
  assert.equal(c.guard.maxBlocks, 10000);
  assert.equal(c.continue.maxAutoFollowups, 3);
  // 部分覆盖
  const c2 = resolveConfig({ guard: { maxBlocks: 500 }, continue: { enabled: false } });
  assert.equal(c2.guard.maxBlocks, 500);
  assert.equal(c2.guard.windowChars, 2000, '未覆盖字段保持默认');
  assert.equal(c2.continue.enabled, false);
});
