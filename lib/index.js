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
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { applyGuard, applyGuardRecovery, probeAgentScopedEvents, selfCheckRecovery } from './guard.js';
import { applyContinue } from './continue.js';
import { debugLog } from './debug.js';

/** Settings namespace exposed to the DSH Settings shell (client section id). */
export const SETTINGS_NAMESPACE = 'run-guard';

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
    autoRetryErrors: z.array(z.string()).default(['PI_AI_ERROR']),
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
      autoRetryErrors: guard.autoRetryErrors ?? ['PI_AI_ERROR'],
    },
    continue: {
      enabled: cont.enabled ?? true,
      maxAutoFollowups: cont.maxAutoFollowups ?? 3,
    },
  };
}

/**
 * Cordis plugin entry: mount both halves.
 *
 * Configuration source: when the `settings` service is available (real DSH
 * host), the plugin registers its settings namespace and reads the resolved
 * value (edited through the GUI Settings shell, persisted in the settings
 * document). Without a settings service (tests, minimal hosts) the Cordis
 * `config` argument is used as before.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - validated plugin config (fallback source).
 */
export function apply(ctx, config) {
  /** Mount both halves under one resolved config. */
  const mount = (resolved) => {
    if (!resolved.enabled) {
      debugLog('plugin disabled by config');
      return;
    }
    // 子开关在挂载层生效:关闭的 half 完全不注册监听/工具
    if (resolved.guard.enabled) {
      applyGuard(ctx, resolved.guard);
      applyGuardRecovery(ctx, resolved.guard);
    }
    if (resolved.continue.enabled) applyContinue(ctx, resolved.continue);
    ctx.logger?.info(
      `[dsh-run-guard] plugin loaded: guard=${resolved.guard.enabled} continue=${resolved.continue.enabled} maxGuardRetries=${resolved.guard.maxGuardRetries}`
    );
    debugLog(`plugin loaded guard=${resolved.guard.enabled} continue=${resolved.continue.enabled} maxGuardRetries=${resolved.guard.maxGuardRetries}`);
    if (resolved.guard.enabled) {
      probeAgentScopedEvents(ctx);
      void selfCheckRecovery(ctx);
    }
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        const scope = settingsCtx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), Config);
        mount(resolveConfig(scope.get()));
      } catch (error) {
        // 命名空间已注册或 settings 异常:退化为 Cordis 配置源
        ctx.logger?.warn?.(`[dsh-run-guard] settings 注册失败,使用插件配置: ${error?.message}`);
        mount(resolveConfig(config));
      }
    });
  } else {
    mount(resolveConfig(config));
  }
}
