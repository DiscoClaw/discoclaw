/**
 * Resolves a PRIMARY_RUNTIME name against the registry, producing actionable
 * migration hints when the configured name is stale or removed.
 *
 * This centralises the startup lookup so callers get a structured result
 * instead of scattering migration-hint logic across the codebase.
 */

import type { RuntimeRegistry } from './registry.js';
import type { RuntimeAdapter } from './types.js';
import { getMigrationHint, type MigrationHint } from './migration-hints.js';

export type ResolveSuccess = {
  ok: true;
  adapter: RuntimeAdapter;
  hint: null;
};

export type ResolveFailure = {
  ok: false;
  adapter: null;
  hint: MigrationHint;
  /** A human-readable message suitable for logging. */
  message: string;
  /** Names currently registered (for diagnostics). */
  available: string[];
};

export type ResolveResult = ResolveSuccess | ResolveFailure;

/**
 * Look up `runtimeName` in `registry`. On miss, consult the migration-hints
 * maps so the caller can log specific guidance (renamed → new name, removed →
 * reason, unknown → list available).
 */
export function resolvePrimaryRuntime(
  runtimeName: string,
  registry: RuntimeRegistry,
): ResolveResult {
  const adapter = registry.get(runtimeName);
  if (adapter) {
    return { ok: true, adapter, hint: null };
  }

  const hint = getMigrationHint(runtimeName);
  const available = registry.list();

  let message: string;
  if (hint) {
    message = `PRIMARY_RUNTIME is not available. ${hint.message}`;
  } else {
    const names = available.length > 0
      ? available.join(', ')
      : '(none)';
    message =
      `PRIMARY_RUNTIME "${runtimeName}" is not recognised and has no migration path. ` +
      `Available runtimes: ${names}. ` +
      `Check your .env file and update PRIMARY_RUNTIME to a supported value.`;
  }

  return { ok: false, adapter: null, hint, message, available };
}
