/**
 * dsh-run-guard: agent run-rhythm guard for DeepSeek Harness.
 *
 * Merged from dsh-reasoning-guard + todo-continue:
 *  - guard: intercepts `llm/stream`, detects reasoning dead loops
 *    (sliding-window repeat ratio + hard per-call caps) and terminates the
 *    stream with a `REASONING_GUARD` error finish.
 *  - continue: after a turn ends, resumes execution — with pending todos it
 *    injects the todo status and guidance; without todos but a
 *    "thought-only stop" (last assistant/message has only reasoning) it
 *    injects a todo-free continuation, unbounded. `pause_work` suppresses it.
 *
 * @module dsh-run-guard
 */
import z from 'schemastery';
import { applyGuard, applyGuardRecovery } from './guard.js';
import { applyContinue } from './continue.js';

/** Plugin display name registered with the Cordis loader. */
export const name = 'dsh-run-guard';

/** Services consumed by the continue half (guard only needs ctx.on). */
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'sessionPersistence'];

/** Schemastery schema; the Cordis loader validates and default-fills it. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  guard: z.object({
    enabled: z.boolean().default(true),
    windowChars: z.number().step(1).min(64).max(1000000).default(2000),
    substrLen: z.number().step(1).min(8).max(128).default(32),
    repeatRatio: z.number().min(0).max(1).default(0.7),
    checkEvery: z.number().step(1).min(1).max(100000).default(50),
    maxBlocks: z.number().step(1).min(100).default(10000),
    maxChars: z.number().step(1).min(1000).default(500000),
    maxGuardRetries: z.number().step(1).min(0).max(10).default(2),
  }).default({}),
  continue: z.object({
    enabled: z.boolean().default(true),
    maxAutoFollowups: z.number().min(1).max(20).default(3),
  }).default({}),
});

/**
 * Resolve a possibly-partial config to complete values (mirrors the schema
 * defaults so direct callers — e.g. tests — can bypass the Loader).
 * @param {object | undefined} config - partial or complete config.
 * @returns {object} complete resolved config.
 */
export function resolveConfig(config) {
  const guard = config?.guard ?? {};
  const cont = config?.continue ?? {};
  return {
    enabled: config?.enabled ?? true,
    guard: {
      enabled: guard.enabled ?? true,
      windowChars: guard.windowChars ?? 2000,
      substrLen: guard.substrLen ?? 32,
      repeatRatio: guard.repeatRatio ?? 0.7,
      checkEvery: guard.checkEvery ?? 50,
      maxBlocks: guard.maxBlocks ?? 10000,
      maxChars: guard.maxChars ?? 500000,
      maxGuardRetries: guard.maxGuardRetries ?? 2,
    },
    continue: {
      enabled: cont.enabled ?? true,
      maxAutoFollowups: cont.maxAutoFollowups ?? 3,
    },
  };
}

/**
 * Cordis plugin entry: mount both halves.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - validated plugin config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;
  // 子开关在挂载层生效:关闭的 half 完全不注册监听/工具
  if (resolved.guard.enabled) {
    applyGuard(ctx, resolved.guard);
    applyGuardRecovery(ctx, resolved.guard);
  }
  if (resolved.continue.enabled) applyContinue(ctx, resolved.continue);
}
