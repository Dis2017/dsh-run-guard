/**
 * 诊断日志:同时输出到文件(/tmp/dsh-run-guard.log)与终端(ctx.logger)。
 * 文件输出便于 agent 直接读取定位运行时问题。
 * @module dsh-run-guard/debug
 */
import { appendFileSync } from 'node:fs';

export const DEBUG_LOG_PATH = '/tmp/dsh-run-guard.log';

/** 写一条诊断日志(失败静默,不影响插件功能)。 */
export function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志失败不影响功能 */
  }
}
