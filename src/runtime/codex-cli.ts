// Codex CLI runtime adapter — thin wrapper around the universal CLI adapter.
// All substantive logic lives in cli-adapter.ts + strategies/codex-strategy.ts.

import type { RuntimeAdapter } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { createCodexStrategy } from './strategies/codex-strategy.js';

/** SIGKILL all tracked Codex subprocesses (e.g. on SIGTERM). */
export function killActiveCodexSubprocesses(): void {
  killAllSubprocesses();
}

export type CodexCliRuntimeOpts = {
  codexBin: string;
  defaultModel: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  disableSessions?: boolean;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
};

export function createCodexCliRuntime(opts: CodexCliRuntimeOpts): RuntimeAdapter {
  return createCliRuntime(createCodexStrategy(opts.defaultModel), {
    binary: opts.codexBin,
    dangerouslySkipPermissions: opts.dangerouslyBypassApprovalsAndSandbox,
    disableSessions: opts.disableSessions,
    log: opts.log,
  });
}
