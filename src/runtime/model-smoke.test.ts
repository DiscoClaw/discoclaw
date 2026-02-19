/**
 * Model smoke tests — end-to-end validation of each configured runtime.
 *
 * Opt-in via SMOKE_TEST_TIERS (skipped by default so normal `pnpm test` runs
 * are not slowed down):
 *
 *   SMOKE_TEST_TIERS=fast,capable pnpm test
 *     Run Claude Code smoke tests for the fast and capable tiers.
 *
 *   SMOKE_TEST_TIERS=claude-sonnet-4-6 pnpm test
 *     Run against a specific model ID.
 *
 *   SMOKE_TEST_TIERS=fast SMOKE_TEST_TIMEOUT_MS=120000 pnpm test
 *     Override per-prompt timeout.
 *
 * Catches: bad API keys, wrong tier mappings, malformed system prompts,
 * missing binaries — all surfaces as error events or empty text.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { EngineEvent } from './types.js';
import {
  PROMPT_CATEGORIES,
  validateSmokeResponse,
  buildSmokeRuntime,
} from './model-smoke-helpers.js';
import { resolveModel } from './model-tiers.js';

/** Working directory passed to every invocation. */
const CWD = '/tmp';

/** Per-test timeout — configurable via SMOKE_TEST_TIMEOUT_MS (default 60 s). */
const rawTimeout = process.env.SMOKE_TEST_TIMEOUT_MS?.trim();
const TIMEOUT: number = (() => {
  if (!rawTimeout) return 60_000;
  const n = Number(rawTimeout);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SMOKE_TEST_TIMEOUT_MS must be a positive number, got "${rawTimeout}"`);
  }
  return n;
})();

/**
 * Comma-separated tier names or literal model IDs from SMOKE_TEST_TIERS.
 * Empty = all smoke tests skipped.
 */
const SMOKE_TIERS: string[] = process.env.SMOKE_TEST_TIERS?.trim()
  ? process.env.SMOKE_TEST_TIERS.trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

// Only build when opt-in is requested; avoids config-error noise in normal CI runs.
const smokeState = SMOKE_TIERS.length > 0 ? buildSmokeRuntime() : null;

// ---------------------------------------------------------------------------
// Claude Code — one describe block per requested tier
// ---------------------------------------------------------------------------

describe.each(SMOKE_TIERS)('claude_code / %s', (tierOrModel) => {
  const model = resolveModel(tierOrModel, 'claude_code');
  const { runtime, claudeBin } = smokeState!;

  beforeAll(() => {
    try {
      execFileSync('which', [claudeBin], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `Smoke test opt-in (SMOKE_TEST_TIERS="${process.env.SMOKE_TEST_TIERS}") ` +
          `requires binary "${claudeBin}" on PATH. ` +
          `Install the Claude CLI or set CLAUDE_BIN to the correct path.`,
      );
    }
  });

  it.each(PROMPT_CATEGORIES)('$name', async ({ prompt, validate, name }) => {
    const events: EngineEvent[] = [];
    for await (const evt of runtime.invoke({ prompt, model, cwd: CWD, tools: [] })) {
      events.push(evt);
    }
    const result = validateSmokeResponse(events, tierOrModel, name);
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    if (validate) {
      expect(
        validate(result.text),
        `[${tierOrModel}/${name}] validation failed for text: ${JSON.stringify(result.text)}`,
      ).toBe(true);
    }
  }, TIMEOUT);
});
