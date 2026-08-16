/**
 * 两 half 集成测试:guard(死循环拦截)与 continue(自动继续)在完整
 * plugin apply 下的协同——guard 中断不得被 continue 误推、continue 的
 * followup 新 turn 若死循环必须被 guard 拦下、正常"想完就停"必须
 * 被 guard 放行并由 continue 接住。
 * @module dsh-run-guard/test/integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig } from '../lib/index.js';
import { REASONING_GUARD_CODE } from '../lib/guard.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (type, data) => ({ type, data });
const msg = (types) => ({ role: 'assistant', content: types.map((t) => ({ type: t, text: 'x' })) });
const session = { id: 's1' };

/** 死循环 reasoning 流。 */
const DEAD_PHRASE =
  '正在等待构建结果,当前状态没有任何变化,继续轮询检查流水线执行状态,没有新的输出信息,重复执行相同检查步骤。';
async function* deadLoopStream(count) {
  for (let i = 0; i < count; i++) {
    yield { type: 'reasoning-delta', index: 0, text: DEAD_PHRASE };
  }
}
/** 正常推理流(字符级唯一)。 */
async function* normalStream(count) {
  for (let i = 0; i < count; i++) {
    let state = (i + 1) >>> 0;
    let s = '';
    while (s.length < 60) {
      state = (state * 1664525 + 1013904223) >>> 0;
      s += state.toString(36);
    }
    yield { type: 'reasoning-delta', index: 0, text: s };
  }
}

/** 完整 ctx:同时服务 guard(llm/stream + logger)与 continue(全部服务)。 */
function createFullCtx() {
  const listeners = new Map();
  const followups = [];
  const appended = [];
  const logs = [];
  const ctx = {
    logger: { warn: (...a) => logs.push(['warn', ...a]), info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context: () => {} },
    tools: { register: () => {} },
    agents: {
      get: (sessionId) => ({
        followup(message) {
          followups.push({ sessionId, text: message.content[0].text });
        },
      }),
    },
    sessions: { get: () => ({ append: (type, data) => appended.push({ type, data }) }) },
    sessionPersistence: { readFrom: async () => ({ events: [] }) },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _followups: followups,
    _appended: appended,
    _logs: logs,
  };
  return ctx;
}

async function collect(iterable) {
  const out = [];
  for await (const c of iterable) out.push(c);
  return out;
}

test('协同:死循环被 guard 中断 → turn error → continue 不误推', async () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  const streamListener = ctx._listeners('llm/stream')[0];
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // 模型推理死循环 → guard 拦截,流以 REASONING_GUARD finish 终止
  const chunks = await collect(streamListener({}, () => deadLoopStream(500)));
  const finish = chunks.find((c) => c.type === 'finish');
  assert.ok(finish, 'guard 应中断死循环流');
  assert.equal(finish.reason.failure.code, REASONING_GUARD_CODE);

  // agent-loop 语义:finish error → turn 以 error 终结
  emit(session, ev('turn/start', { turn: 1 }));
  emit(session, ev('assistant/message', { turn: 1, step: 1, message: msg(['reasoning']) }));
  emit(session, ev('turn/end', { turn: 1, reason: { kind: 'error' } }));
  await sleep(20);
  assert.equal(ctx._followups.length, 0, 'guard 中断的 error turn 不应被 continue 自动继续');
});

test('协同:continue 注入 followup 后,新 turn 死循环被 guard 拦截', async () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  const streamListener = ctx._listeners('llm/stream')[0];
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // turn 1:有 todo + 想完就停 → continue 注入 followup
  emit(session, ev('todo/write', { todos: [{ content: '任务A', status: 'pending' }] }));
  emit(session, ev('turn/start', { turn: 1 }));
  emit(session, ev('assistant/message', { turn: 1, step: 1, message: msg(['reasoning']) }));
  emit(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(ctx._followups.length, 1, 'continue 应注入 followup');

  // 自动继续的新 turn:模型推理死循环 → guard 拦截
  emit(session, ev('turn/start', { turn: 2 }));
  emit(session, ev('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'plugin', plugin: 'dsh-run-guard' } }));
  const chunks = await collect(streamListener({}, () => deadLoopStream(500)));
  const finish = chunks.find((c) => c.type === 'finish');
  assert.ok(finish && finish.reason.failure.code === REASONING_GUARD_CODE, 'followup 新 turn 的死循环应被 guard 拦截');
  emit(session, ev('turn/end', { turn: 2, reason: { kind: 'error' } }));
  await sleep(20);
  assert.equal(ctx._followups.length, 1, 'guard 中断后 continue 不再注入(计数不被无产出污染)');
});

test('协同:正常"想完就停"被 guard 放行,无 todo 时 continue 接住', async () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  const streamListener = ctx._listeners('llm/stream')[0];
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // 正常推理流(不重复)→ guard 放行,无 error finish 注入,全部透传
  const chunks = await collect(streamListener({}, () => normalStream(50)));
  assert.ok(!chunks.some((c) => c.type === 'finish' && c.reason?.kind === 'error'), '正常推理不应被 guard 拦截');
  assert.equal(chunks.length, 50, '全部块应原样透传');

  // 无 todo + 想完就停 → continue 触发,注入无 todo 文案
  emit(session, ev('turn/start', { turn: 3 }));
  emit(session, ev('assistant/message', { turn: 3, step: 1, message: msg(['reasoning']) }));
  emit(session, ev('turn/end', { turn: 3, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(ctx._followups.length, 1, 'guard 放行后 continue 应接住想完就停');
  assert.ok(!/todo/i.test(ctx._followups[0].text), '无 todo 文案');
});

test('协同:有产出(正文)的 turn 不被 guard 误拦、不被 continue 误推', async () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  const streamListener = ctx._listeners('llm/stream')[0];
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // 正常推理流 + 有正文 → guard 放行
  const chunks = await collect(streamListener({}, () => normalStream(30)));
  assert.ok(!chunks.some((c) => c.type === 'finish' && c.reason?.kind === 'error'));

  // 无 todo + 最后消息含正文 → continue 不触发
  emit(session, ev('turn/start', { turn: 4 }));
  emit(session, ev('assistant/message', { turn: 4, step: 1, message: msg(['reasoning', 'text']) }));
  emit(session, ev('turn/end', { turn: 4, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(ctx._followups.length, 0, '有正文产出时 continue 不应触发');
});
