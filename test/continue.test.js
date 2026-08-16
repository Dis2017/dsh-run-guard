/**
 * dsh-run-guard continue half 单元测试：mock Cordis 上下文 + 事件驱动，覆盖
 * 原有 todo 场景（计数/上限/暂停/UI 恢复/预防层）与新增的
 * "无 todo + 想完就停" 场景（无上限、注入内容无 todo 信息、判定只看最后一条消息）。
 * @module dsh-run-guard/test/continue
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyContinue } from '../lib/continue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 事件构造：session/event 监听器收到的 { type, data }。 */
const ev = (type, data) => ({ type, data });

/** assistant/message 的 message 构造。 */
const msg = (types) => ({
  role: 'assistant',
  content: types.map((t) => ({ type: t, text: 'x' })),
});

/**
 * Mock Cordis 上下文：
 * - 收集 session/event 监听器、systemPrompt.context 定义、pause_work 工具定义
 * - agents.get 返回记录 followup 的 mock agent
 * - sessions.get 返回记录 append 的 mock session
 * - sessionPersistence.readFrom 默认返回空日志
 */
function createHarness(options = {}) {
  const followups = []; // { sessionId, text }
  const appended = []; // { type, data }
  const listeners = new Map();
  const contextDefs = [];
  let pauseTool = null;

  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: {
      context: (def) => contextDefs.push(def),
    },
    tools: {
      register: (def) => {
        if (def.name === 'pause_work') pauseTool = def;
      },
    },
    agents: {
      get: (sessionId) =>
        options.noAgent
          ? undefined
          : {
              followup(message) {
                followups.push({ sessionId, text: message.content[0].text });
              },
            },
    },
    sessions: {
      get: () => ({
        append: (type, data) => appended.push({ type, data }),
      }),
    },
    sessionPersistence: {
      readFrom:
        options.readFromImpl ??
        (async () => ({ events: options.persistedEvents ?? [] })),
    },
  };

  return {
    ctx,
    followups,
    appended,
    contextDefs,
    get pauseTool() {
      return pauseTool;
    },
    emit(session, event) {
      for (const fn of listeners.get('session/event') ?? []) fn(session, event);
    },
  };
}

/** 通用：完成一个"想完就停"turn(有/无 todo 由 harness 前置事件决定)。 */
async function completeThinkStopTurn(h, session, turn) {
  h.emit(session, ev('turn/start', { turn }));
  h.emit(session, ev('assistant/message', { turn, step: 1, message: msg(['reasoning']) }));
  h.emit(session, ev('turn/end', { turn, reason: { kind: 'completed' } }));
  await sleep(20);
}

const session = { id: 's1' };

// ───────────────────────── 新增：无 todo + 想完就停 ─────────────────────────

test('无 todo + 想完就停 → 触发 followup,文案不含 todo 信息', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  await completeThinkStopTurn(h, session, 1);
  assert.equal(h.followups.length, 1);
  const text = h.followups[0].text;
  assert.ok(text.includes('仅输出推理'), '应说明触发原因');
  assert.ok(!/todo/i.test(text), '无 todo 场景文案不应含 todo 信息');
});

test('无 todo + 正常产出(正文) → 不触发', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('turn/start', { turn: 2 }));
  h.emit(session, ev('assistant/message', { turn: 2, step: 1, message: msg(['reasoning', 'text']) }));
  h.emit(session, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 0);
});

test('无 todo + 最后消息含 tool-call → 不触发', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('turn/start', { turn: 3 }));
  h.emit(session, ev('assistant/message', { turn: 3, step: 1, message: msg(['reasoning', 'tool-call']) }));
  h.emit(session, ev('turn/end', { turn: 3, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 0);
});

test('过程中有产出、最后只有推理 → 触发(判定只看最后一条消息)', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('turn/start', { turn: 4 }));
  h.emit(session, ev('tool/call', { turn: 4, step: 1 })); // 过程中有工具
  h.emit(session, ev('assistant/message', { turn: 4, step: 1, message: msg(['reasoning', 'text', 'tool-call']) }));
  h.emit(session, ev('assistant/message', { turn: 4, step: 2, message: msg(['reasoning']) })); // 最后只有推理
  h.emit(session, ev('turn/end', { turn: 4, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 1, '最后一条只有推理应触发');
});

test('无 todo + 想完就停 + pause_work → 不触发,新 turn 恢复', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  assert.ok(h.pauseTool, 'pause_work 工具应已注册');
  // turn 1:模型主动暂停
  h.emit(session, ev('turn/start', { turn: 5 }));
  h.emit(session, ev('assistant/message', { turn: 5, step: 1, message: msg(['reasoning']) }));
  await h.pauseTool.execute({}, { agent: { session } });
  h.emit(session, ev('turn/end', { turn: 5, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 0, 'pause_work 后不应自动继续');
  // turn 2:未暂停,恢复自动继续
  await completeThinkStopTurn(h, session, 6);
  assert.equal(h.followups.length, 1, '新 turn 应恢复自动继续');
});

test('无 todo + 想完就停 连续 5 次 → 全部触发(无上限)', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 }); // 上限 3 对无 todo 场景不生效
  for (let i = 0; i < 5; i++) {
    await completeThinkStopTurn(h, session, 10 + i);
  }
  assert.equal(h.followups.length, 5, '无 todo 场景应无上限');
});

// ───────────────────────── 原有：有 todo 场景 ─────────────────────────

test('有 todo + 想完就停 → 触发,文案含 todo 列表', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务A', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 20);
  assert.equal(h.followups.length, 1);
  assert.ok(h.followups[0].text.includes('任务A'), '文案应含 todo 列表');
  assert.ok(h.followups[0].text.includes('todo'), '有 todo 场景文案应含 todo 字样');
});

test('有 todo + 正常产出 → 触发(原逻辑保持)', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务B', status: 'pending' }] }));
  h.emit(session, ev('turn/start', { turn: 21 }));
  h.emit(session, ev('assistant/message', { turn: 21, step: 1, message: msg(['reasoning', 'text']) }));
  h.emit(session, ev('turn/end', { turn: 21, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 1);
});

test('有 todo + 连续无产出达到 maxAutoFollowups → 停止自动继续', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务C', status: 'pending' }] }));
  for (let i = 0; i < 4; i++) {
    await completeThinkStopTurn(h, session, 30 + i);
  }
  // 计数语义:第 1 次 count=1 触发、第 2 次 count=2 触发、第 3 次 count=3 停止
  assert.equal(h.followups.length, 2, '连续无产出第 3 次(count=3)起停止');
});

test('有 todo + 无产出后出现产出 → 计数重置,继续自动继续', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务D', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 40); // 无产出,count=1 触发
  await completeThinkStopTurn(h, session, 41); // 无产出,count=2 触发
  // 有产出 turn:调用工具 + 正文 → count 重置
  h.emit(session, ev('turn/start', { turn: 42 }));
  h.emit(session, ev('tool/call', { turn: 42, step: 1 }));
  h.emit(session, ev('assistant/message', { turn: 42, step: 1, message: msg(['reasoning', 'text']) }));
  h.emit(session, ev('turn/end', { turn: 42, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 3, '产出 turn 也应触发(有 todo)');
  // 再连续 4 次无产出:count 从头累计 → 1、2 触发,3、4 停止
  for (let i = 0; i < 4; i++) {
    await completeThinkStopTurn(h, session, 43 + i);
  }
  assert.equal(h.followups.length, 5, '重置后 count=1、2 触发,第 3 次起停止');
});

test('用户输入重置连续计数', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务E', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 50); // count=1 触发
  await completeThinkStopTurn(h, session, 51); // count=2 触发
  // 用户发消息(重置计数)+ 模型有产出(重置且触发)
  h.emit(session, ev('turn/start', { turn: 52 }));
  h.emit(session, ev('user/message', { content: [{ type: 'text', text: '继续做' }], source: { kind: 'user' } }));
  h.emit(session, ev('assistant/message', { turn: 52, step: 1, message: msg(['reasoning', 'text']) }));
  h.emit(session, ev('turn/end', { turn: 52, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(h.followups.length, 3);
  // 重置后连续 4 次无产出:count=1、2 触发,第 3 次起停止
  for (let i = 0; i < 4; i++) {
    await completeThinkStopTurn(h, session, 53 + i);
  }
  assert.equal(h.followups.length, 5, '用户输入后计数从 0 重新累计');
});

test('插件注入的 user/message 不重置计数', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务F', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 60); // count=1 触发
  // 自动继续新 turn:首条消息是插件注入(非 user source)→ 不重置计数
  h.emit(session, ev('turn/start', { turn: 61 }));
  h.emit(session, ev('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'plugin', plugin: 'dsh-run-guard' } }));
  await completeThinkStopTurn(h, session, 62); // count=2 触发
  await completeThinkStopTurn(h, session, 63); // count=3 停止
  await completeThinkStopTurn(h, session, 64); // 停止
  assert.equal(h.followups.length, 2, '插件注入不重置,计数连续累计');
});

// ───────────────────────── 边界与开关 ─────────────────────────

test('error / aborted turn → 不触发', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  for (const [turn, reason] of [[70, { kind: 'error' }], [71, { kind: 'aborted' }]]) {
    h.emit(session, ev('turn/start', { turn }));
    h.emit(session, ev('assistant/message', { turn, step: 1, message: msg(['reasoning']) }));
    h.emit(session, ev('turn/end', { turn, reason }));
    await sleep(20);
  }
  assert.equal(h.followups.length, 0);
});

test('enabled=false → 全部不触发', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: false, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务G', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 80);
  assert.equal(h.followups.length, 0);
});

test('重启恢复:无内存状态时从持久化日志重建 todo', async () => {
  const h = createHarness({
    persistedEvents: [
      { type: 'todo/write', data: { todos: [{ content: '持久化任务', status: 'pending' }] } },
    ],
  });
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  // 未 emit 过 todo/write,内存无状态 → turn/end 时 restore
  await completeThinkStopTurn(h, session, 90);
  assert.equal(h.followups.length, 1);
  assert.ok(h.followups[0].text.includes('持久化任务'), '应恢复持久化 todo 列表');
});

// ───────────────────────── 预防层与 UI 恢复 ─────────────────────────

test('预防层:有 todo 注入状态文本,无 todo 返回空', () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  const def = h.contextDefs.find((d) => d.name === 'dsh-run-guard:todo-status');
  assert.ok(def, '应注册 systemPrompt context');
  // 无 todo
  assert.equal(def.text({ agent: { session } }), '', '无 todo 不注入');
  // 有 todo
  h.emit(session, ev('todo/write', { todos: [{ content: '任务H', status: 'pending' }] }));
  const text = def.text({ agent: { session } });
  assert.ok(text.includes('任务H'), '有 todo 应注入列表');
  assert.ok(text.includes('pause_work'), '应含暂停引导');
});

test('UI 投影恢复:自动继续的新 turn 首条插件消息补写 todo/write', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务I', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 100); // 触发 followup,pendingRestore 标记
  assert.equal(h.followups.length, 1);
  // 自动继续的新 turn:首条消息为本插件注入
  h.emit(session, ev('turn/start', { turn: 101 }));
  h.emit(session, ev('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'plugin', plugin: 'dsh-run-guard' } }));
  await sleep(20);
  const write = h.appended.find((a) => a.type === 'todo/write');
  assert.ok(write, '应补写 todo/write 恢复 UI 投影');
  assert.equal(write.data.todos[0].content, '任务I');
});

test('UI 投影恢复:用户手动开的新 turn 不补写', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务J', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 110);
  assert.equal(h.followups.length, 1);
  // 新 turn 首条消息来自真实用户 → 放弃恢复
  h.emit(session, ev('turn/start', { turn: 111 }));
  h.emit(session, ev('user/message', { content: [{ type: 'text', text: '我自己来' }], source: { kind: 'user' } }));
  await sleep(20);
  assert.equal(h.appended.filter((a) => a.type === 'todo/write').length, 0, '用户 turn 不应补写');
});

// ───────────────────────── 补充：守卫与防御路径 ─────────────────────────

test('UI 投影恢复:模型已写新 todo 时不覆盖(modelWrote 守卫)', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '旧任务', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 120); // 触发 followup,pendingRestore 标记
  assert.equal(h.followups.length, 1);
  // 自动继续的新 turn:模型先写新 todo(声明新计划)→ modelWrote=true
  h.emit(session, ev('turn/start', { turn: 121 }));
  h.emit(session, ev('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'plugin', plugin: 'dsh-run-guard' } }));
  h.emit(session, ev('todo/write', { todos: [{ content: '模型新计划', status: 'pending' }] }));
  await sleep(20);
  // scheduleRestore 执行时发现 modelWrote=true → 不覆盖模型声明
  assert.equal(h.appended.filter((a) => a.type === 'todo/write').length, 0, '模型已写新列表时不覆盖');
});

test('todo 全部 completed 后想完就停 → 走无 todo 分支触发,文案无 todo', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '已完成任务', status: 'completed' }] }));
  await completeThinkStopTurn(h, session, 130);
  assert.equal(h.followups.length, 1, '全部完成后视为无未完成 todo,想完就停应触发');
  assert.ok(!/todo/i.test(h.followups[0].text), '文案按无 todo 语义,不含 todo 信息');
});

test('MAX_LISTED=5:超过 5 项 todo 显示省略', async () => {
  const h = createHarness();
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  const todos = Array.from({ length: 7 }, (_, i) => ({ content: `任务${i}`, status: 'pending' }));
  h.emit(session, ev('todo/write', { todos }));
  await completeThinkStopTurn(h, session, 140);
  const text = h.followups[0].text;
  assert.ok(text.includes('任务0') && text.includes('任务4'), '应列出前 5 项');
  assert.ok(!text.includes('任务5'), '第 6 项不应列出');
  assert.ok(text.includes('等 2 项'), '应显示省略提示');
});

test('agents.get 返回 undefined → followup 静默跳过,不崩溃', async () => {
  const h = createHarness({ noAgent: true });
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  h.emit(session, ev('todo/write', { todos: [{ content: '任务K', status: 'pending' }] }));
  await completeThinkStopTurn(h, session, 150);
  // 不抛错即可;无 followup 记录(agent 不存在)
  assert.equal(h.followups.length, 0);
});

test('restoreTodoState 失败(readFrom 抛错)不阻断 turn 处理', async () => {
  const h = createHarness({
    readFromImpl: async () => {
      throw new Error('storage broken');
    },
  });
  applyContinue(h.ctx, { enabled: true, maxAutoFollowups: 3 });
  // 内存无 todo 状态 + 持久化读取失败 → 视为无 todo,想完就停仍触发
  await completeThinkStopTurn(h, session, 160);
  assert.equal(h.followups.length, 1, '恢复失败不影响无 todo 自动继续');
});
