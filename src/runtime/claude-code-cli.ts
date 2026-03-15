// Claude Code CLI runtime adapter — thin wrapper around the universal CLI adapter.
// All substantive logic lives in cli-adapter.ts + strategies/claude-strategy.ts.

import type { RuntimeAdapter } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { claudeStrategy } from './strategies/claude-strategy.js';

// Re-export output parsers for backward compatibility (tests import from here).
export {
  extractTextFromUnknownEvent,
  extractResultText,
  extractImageFromUnknownEvent,
  extractResultContentBlocks,
  imageDedupeKey,
  stripToolUseBlocks,
} from './cli-output-parsers.js';

export { tryParseJsonLine } from './cli-shared.js';

// Re-export for backward compatibility (now defined in types.ts).
export { MAX_IMAGES_PER_INVOCATION } from './types.js';

/** SIGKILL all tracked Claude subprocesses (e.g. on SIGTERM). */
export function killActiveSubprocesses(): void {
  killAllSubprocesses();
}

export type ClaudeCliRuntimeOpts = {
  claudeBin: string;
  dangerouslySkipPermissions: boolean;
  outputFormat: 'text' | 'stream-json';
  echoStdio?: boolean;
  verbose?: boolean;
  debugFile?: string | null;
  strictMcpConfig?: boolean;
  fallbackModel?: string;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
  sessionScanning?: boolean;
  multiTurn?: boolean;
  multiTurnHangTimeoutMs?: number;
  multiTurnIdleTimeoutMs?: number;
  multiTurnMaxProcesses?: number;
  streamStallTimeoutMs?: number;
  progressStallTimeoutMs?: number;
};

export function createClaudeCliRuntime(opts: ClaudeCliRuntimeOpts): RuntimeAdapter {
  return createCliRuntime(claudeStrategy, {
    binary: opts.claudeBin,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    outputFormat: opts.outputFormat,
    echoStdio: opts.echoStdio,
    verbose: opts.verbose,
    debugFile: opts.debugFile,
    strictMcpConfig: opts.strictMcpConfig,
    fallbackModel: opts.fallbackModel,
    maxBudgetUsd: opts.maxBudgetUsd,
    appendSystemPrompt: opts.appendSystemPrompt,
    log: opts.log,
    sessionScanning: opts.sessionScanning,
    multiTurn: opts.multiTurn,
    multiTurnHangTimeoutMs: opts.multiTurnHangTimeoutMs,
    multiTurnIdleTimeoutMs: opts.multiTurnIdleTimeoutMs,
    multiTurnMaxProcesses: opts.multiTurnMaxProcesses,
    streamStallTimeoutMs: opts.streamStallTimeoutMs,
    progressStallTimeoutMs: opts.progressStallTimeoutMs,
  });
}
