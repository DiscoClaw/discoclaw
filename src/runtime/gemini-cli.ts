// Gemini CLI runtime adapter — thin wrapper around the universal CLI adapter.
// Phase 1: one-shot text mode. Sessions, JSONL streaming, and preflight are Phase 2.
// Auth is resolved by the `gemini` binary itself (OAuth via ~/.gemini/oauth_creds.json
// or GEMINI_API_KEY env var). This adapter spawns the binary and does not manage auth.

import type { RuntimeAdapter } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { createGeminiStrategy } from './strategies/gemini-strategy.js';

/** SIGKILL all tracked Gemini subprocesses (e.g. on SIGTERM). */
export function killActiveGeminiSubprocesses(): void {
  killAllSubprocesses();
}

export type GeminiCliRuntimeOpts = {
  geminiBin: string;
  defaultModel: string;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
};

export function createGeminiCliRuntime(opts: GeminiCliRuntimeOpts): RuntimeAdapter {
  return createCliRuntime(createGeminiStrategy(opts.defaultModel), {
    binary: opts.geminiBin,
    log: opts.log,
  });
}
