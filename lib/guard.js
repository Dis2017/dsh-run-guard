/**
 * Reasoning dead-loop detector: exact sliding-window repeat-ratio analysis
 * over a stream of reasoning text deltas, plus hard per-call caps.
 *
 * Pure logic, zero runtime dependencies — unit-testable in isolation.
 *
 * @module dsh-run-guard/guard
 */

/**
 * Create one detector instance. Each detector owns one streaming model call
 * (one `llm/stream` dispatch), so counters are per-call by construction.
 *
 * @param {object} config - resolved guard configuration.
 * @param {number} config.substrLen - fixed substring length used for repeat
 *   analysis (characters).
 * @param {number} config.windowChars - sliding window size in characters; the
 *   window keeps only the most recent text, so a past burst of repetition
 *   cannot keep the ratio elevated forever.
 * @param {number} config.repeatRatio - trigger threshold in [0, 1]; the
 *   detector fires when the share of non-unique substrings inside the window
 *   reaches this value.
 * @param {number} config.checkEvery - run the ratio check once per N pushed
 *   blocks (de-rate limiting; the check is O(window) so it must not run on
 *   the per-delta hot path).
 * @param {number} config.maxBlocks - hard cap: total reasoning blocks in one
 *   call. Fires regardless of repetition.
 * @param {number} config.maxChars - hard cap: total reasoning characters in
 *   one call. Fires regardless of repetition.
 * @returns {object} detector with `push(text)` and `stats()`.
 */
export function createReasoningGuard(config) {
  const { substrLen, windowChars, repeatRatio, checkEvery, maxBlocks, maxChars } = config;

  /** Current window text (length <= windowChars). */
  let window = '';
  /** Substring -> occurrence count inside the window (multiset). */
  const freq = new Map();
  /** Total substrings inside the window. */
  let totalSubstrs = 0;
  /** Cumulative reasoning blocks pushed into this detector. */
  let blocks = 0;
  /** Cumulative reasoning characters pushed into this detector. */
  let chars = 0;
  /** Blocks since the last ratio check. */
  let sinceCheck = 0;

  /**
   * Append `text` to the window and register every newly completed substring
   * of length `substrLen`.
   */
  function addSubstrs(text) {
    const combined = window + text;
    // New substring starts: everything past the last substring already fully
    // inside the old window (window.length - substrLen), i.e. starts that
    // could not exist before `text` was appended.
    const start = Math.max(0, window.length - substrLen + 1);
    for (let i = start; i + substrLen <= combined.length; i++) {
      const s = combined.slice(i, i + substrLen);
      freq.set(s, (freq.get(s) ?? 0) + 1);
      totalSubstrs++;
    }
    window = combined;
  }

  /**
   * Drop characters from the window head until it fits `windowChars`.
   * Removing one head character removes exactly one substring (the one
   * starting at the removed position); every other substring shifts left by
   * one position without changing content, so the multiset stays exact.
   */
  function trimWindow() {
    while (window.length > windowChars) {
      // 窗口长度小于子串长度时(仅 windowChars < substrLen 的退化配置会出现),
      // 窗口内没有完整子串,无需维护 freq——否则 slice 会取出从未入表的子串,
      // freq.get() 返回 undefined 导致 NaN 污染计数。
      if (window.length >= substrLen) {
        const s = window.slice(0, substrLen);
        const next = freq.get(s) - 1;
        if (next <= 0) freq.delete(s);
        else freq.set(s, next);
        totalSubstrs--;
      }
      window = window.slice(1);
    }
  }

  /**
   * Evaluate the current state.
   * @returns {{triggered: boolean, reason?: string, ratio?: number, blocks: number, chars: number}}
   */
  function check() {
    const result = { triggered: false, blocks, chars };
    if (totalSubstrs >= substrLen * 2) {
      const ratio = 1 - freq.size / totalSubstrs;
      result.ratio = ratio;
      if (ratio >= repeatRatio) {
        return { ...result, triggered: true, reason: 'repeat' };
      }
    }
    if (blocks >= maxBlocks) {
      return { ...result, triggered: true, reason: 'blocks' };
    }
    if (chars >= maxChars) {
      return { ...result, triggered: true, reason: 'chars' };
    }
    return result;
  }

  return {
    /**
     * Push one reasoning delta.
     * @param {string} text - delta text (may be empty).
     * @returns {null | {triggered: boolean, reason?: string, ratio?: number, blocks: number, chars: number}}
     *   a check result on de-rate boundaries, otherwise null.
     */
    push(text) {
      blocks++;
      chars += text.length;
      // 无长度守卫:真实 reasoning 流可能切成 1-9 字符的碎片(SSE 分块),
      // 短块追加后仍会在窗口尾部形成跨边界子串,必须始终进入分析。
      addSubstrs(text);
      trimWindow();
      sinceCheck++;
      if (sinceCheck >= checkEvery) {
        sinceCheck = 0;
        return check();
      }
      return null;
    },

    /** Current diagnostic snapshot. */
    stats() {
      return { blocks, chars, totalSubstrs, unique: freq.size };
    },
  };
}

/**
 * Reasoning dead-loop guard plugin half: intercepts `llm/stream`, feeds
 * reasoning deltas into the detector, and terminates the stream with a
 * `REASONING_GUARD` error finish when the detector fires.
 */

/** Stable failure code carried by the terminating finish chunk. */
export const REASONING_GUARD_CODE = 'REASONING_GUARD';

/** Trigger-reason -> human-readable cause (shown in the GUI turn error). */
const REASON_TEXT = {
  repeat: '重复率异常:模型持续输出高度重复的推理内容(疑似推理死循环)',
  blocks: '单次调用推理块数超过上限',
  chars: '单次调用推理字符数超过上限',
};

/**
 * Build the user-facing failure message. This text is what the GUI shows on
 * the interrupted turn, so it explains why the guard fired and what to do.
 * @param {object} verdict - detector verdict (triggered/reason/ratio/blocks/chars).
 * @param {object} config - resolved guard config (thresholds for the message).
 * @returns {string} multi-line Chinese explanation.
 */
export function guardMessage(verdict, config) {
  const ratioText = verdict.ratio === undefined ? 'n/a' : verdict.ratio.toFixed(3);
  const lines = [
    `推理输出疑似死循环,已被推理护栏中断。`,
    `原因: ${REASON_TEXT[verdict.reason] ?? verdict.reason}`,
    `触发时状态: ${verdict.blocks} 个推理块 / ${verdict.chars} 字符` +
      (verdict.ratio === undefined ? '' : `,窗口重复率 ${ratioText}`),
    `这是保护性中断:模型在空转输出,继续会浪费时间和 token。可直接继续对话或重试。`,
  ];
  return lines.join('\n');
}

/**
 * Register the `llm/stream` waterfall listener. Every streaming model call
 * passes through it; when the detector fires, the stream is terminated with
 * an error finish chunk. The listener never breaks a healthy stream:
 * detector failures degrade it to pure passthrough, and non-reasoning chunks
 * are forwarded untouched.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - resolved guard configuration (guard.enabled etc.).
 */
export function applyGuard(ctx, config) {
  ctx.on('llm/stream', (options, next) => {
    if (!config.enabled) return next();
    const stream = next();
    /** Per-call detector; null once degraded (detector error) or fired. */
    let guard = createReasoningGuard(config);
    return (async function* () {
      for await (const chunk of stream) {
        if (guard !== null && chunk.type === 'reasoning-delta') {
          try {
            const verdict = guard.push(chunk.text);
            if (verdict?.triggered) {
              const ratio = verdict.ratio === undefined ? 'n/a' : verdict.ratio.toFixed(3);
              ctx.logger.warn(
                `[dsh-run-guard] ${verdict.reason} 触发中断: ` +
                `blocks=${verdict.blocks} chars=${verdict.chars} ratio=${ratio}`
              );
              yield {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: {
                    message: guardMessage(verdict, config),
                    code: REASONING_GUARD_CODE,
                  },
                },
              };
              guard = null;
              return;
            }
          } catch (error) {
            // Guard bugs must never break a healthy model stream.
            ctx.logger.warn(`[dsh-run-guard] 检测器异常,降级为透传: ${error?.message ?? error}`);
            guard = null;
          }
        }
        yield chunk;
      }
    })();
  });
}

/**
 * Register `agent/request-error` recovery: when the guard fired
 * (REASONING_GUARD), automatically retry the step instead of failing the
 * turn — a dead loop is usually a transient model state, and the retried
 * request rarely loops again. Bounded per-turn (config.maxGuardRetries);
 * once exceeded the turn fails visibly for the user.
 *
 * Non-guard errors are passed through untouched (llm-retry owns those).
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - resolved guard configuration.
 */
export function applyGuardRecovery(ctx, config) {
  /** sessionId -> turn -> consecutive guard-fire count for that turn. */
  const guardRetries = new Map();

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure?.code !== REASONING_GUARD_CODE) return next();
    const sessionId = payload.agent?.id;
    if (sessionId === void 0) return next();
    let byTurn = guardRetries.get(sessionId);
    if (byTurn === void 0) {
      byTurn = new Map();
      guardRetries.set(sessionId, byTurn);
    }
    const count = (byTurn.get(payload.turn) ?? 0) + 1;
    byTurn.set(payload.turn, count);
    if (count <= config.maxGuardRetries) {
      ctx.logger.warn(
        `[dsh-run-guard] 死循环中断,自动重试 ${count}/${config.maxGuardRetries} (turn ${payload.turn} step ${payload.step})`
      );
      return { kind: 'retry' };
    }
    // 超过上限:该 turn 不再自动重试,让错误可见(用户可手动继续)
    byTurn.delete(payload.turn);
    return undefined;
  });

  // turn 结束清理计数(新 turn 重新计数)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      guardRetries.get(session.id)?.delete(event.data.turn);
    }
  });
}
