// @deprecated — Gemini CLI runtime removed from the registry (TOS risk).
// Use "gemini-api" (REST adapter via gemini-rest.ts) instead.
//
// This module is retained temporarily for smoke-test helpers
// (model-smoke-helpers.ts) but is no longer registered at startup.
// Do not add new callers.
//
// Original: thin wrapper around the universal CLI adapter, one-shot text mode.
// Auth was resolved by the `gemini` binary itself (OAuth via
// ~/.gemini/oauth_creds.json or GEMINI_API_KEY env var).

import type { RuntimeAdapter } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { createGeminiStrategy } from './strategies/gemini-strategy.js';

/** @deprecated Gemini CLI runtime removed from registry. Use gemini-api instead. */
export function killActiveGeminiSubprocesses(): void {
  killAllSubprocesses();
}

/** @deprecated Gemini CLI runtime removed from registry. Use gemini-api instead. */
export type GeminiCliRuntimeOpts = {
  geminiBin: string;
  defaultModel: string;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
};

/** @deprecated Gemini CLI runtime removed from registry. Use gemini-api instead. */
export function createGeminiCliRuntime(opts: GeminiCliRuntimeOpts): RuntimeAdapter {
  return createCliRuntime(createGeminiStrategy(opts.defaultModel), {
    binary: opts.geminiBin,
    log: opts.log,
  });
}
