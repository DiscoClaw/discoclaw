/**
 * Model smoke tests — end-to-end validation of each configured runtime.
 *
 * Opt-in via provider-specific env vars (all skipped by default so normal
 * `pnpm test` runs are not slowed down):
 *
 *   SMOKE_TEST_TIERS=fast,capable pnpm test
 *     Run Claude Code smoke tests for the fast and capable tiers.
 *
 *   GEMINI_SMOKE_TEST_TIERS=fast pnpm test
 *     Run Gemini smoke tests for the fast tier.
 *
 *   OPENAI_SMOKE_TEST_TIERS=fast pnpm test
 *     Run OpenAI smoke tests (requires OPENAI_API_KEY).
 *
 *   CODEX_SMOKE_TEST_TIERS=fast pnpm test
 *     Run Codex smoke tests (requires codex binary on PATH).
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
  buildGeminiSmokeRuntime,
  buildOpenAISmokeRuntime,
  buildCodexSmokeRuntime,
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

/**
 * Comma-separated tier names or literal model IDs from GEMINI_SMOKE_TEST_TIERS.
 * Empty = all Gemini smoke tests skipped.
 */
const GEMINI_SMOKE_TIERS: string[] = process.env.GEMINI_SMOKE_TEST_TIERS?.trim()
  ? process.env.GEMINI_SMOKE_TEST_TIERS.trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

/**
 * Comma-separated tier names or literal model IDs from OPENAI_SMOKE_TEST_TIERS.
 * Empty = all OpenAI smoke tests skipped.
 */
const OPENAI_SMOKE_TIERS: string[] = process.env.OPENAI_SMOKE_TEST_TIERS?.trim()
  ? process.env.OPENAI_SMOKE_TEST_TIERS.trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

/**
 * Comma-separated tier names or literal model IDs from CODEX_SMOKE_TEST_TIERS.
 * Empty = all Codex smoke tests skipped.
 */
const CODEX_SMOKE_TIERS: string[] = process.env.CODEX_SMOKE_TEST_TIERS?.trim()
  ? process.env.CODEX_SMOKE_TEST_TIERS.trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

// Only build when opt-in is requested; avoids config-error noise in normal CI runs.
const smokeState = SMOKE_TIERS.length > 0 ? buildSmokeRuntime() : null;
const geminiSmokeState = GEMINI_SMOKE_TIERS.length > 0 ? buildGeminiSmokeRuntime() : null;
const openaiSmokeState = OPENAI_SMOKE_TIERS.length > 0 ? buildOpenAISmokeRuntime() : null;
const codexSmokeState = CODEX_SMOKE_TIERS.length > 0 ? buildCodexSmokeRuntime() : null;

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

// ---------------------------------------------------------------------------
// Gemini CLI — one describe block per requested tier
// ---------------------------------------------------------------------------

describe.each(GEMINI_SMOKE_TIERS)('gemini / %s', (tierOrModel) => {
  const model = resolveModel(tierOrModel, 'gemini');
  const { runtime, geminiBin } = geminiSmokeState!;

  beforeAll(() => {
    try {
      execFileSync('which', [geminiBin], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `Smoke test opt-in (GEMINI_SMOKE_TEST_TIERS="${process.env.GEMINI_SMOKE_TEST_TIERS}") ` +
          `requires binary "${geminiBin}" on PATH. ` +
          `Install the Gemini CLI or set GEMINI_BIN to the correct path.`,
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

// ---------------------------------------------------------------------------
// OpenAI API — one describe block per requested tier
// ---------------------------------------------------------------------------

describe.each(OPENAI_SMOKE_TIERS)('openai / %s', (tierOrModel) => {
  const model = resolveModel(tierOrModel, 'openai');
  const { runtime, apiKey } = openaiSmokeState!;

  beforeAll(() => {
    if (!apiKey) {
      throw new Error(
        `Smoke test opt-in (OPENAI_SMOKE_TEST_TIERS="${process.env.OPENAI_SMOKE_TEST_TIERS}") ` +
          `requires OPENAI_API_KEY to be set.`,
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

// ---------------------------------------------------------------------------
// Codex CLI — one describe block per requested tier
// ---------------------------------------------------------------------------

describe.each(CODEX_SMOKE_TIERS)('codex / %s', (tierOrModel) => {
  const model = resolveModel(tierOrModel, 'codex');
  const { runtime, codexBin } = codexSmokeState!;

  beforeAll(() => {
    try {
      execFileSync('which', [codexBin], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `Smoke test opt-in (CODEX_SMOKE_TEST_TIERS="${process.env.CODEX_SMOKE_TEST_TIERS}") ` +
          `requires binary "${codexBin}" on PATH. ` +
          `Install the Codex CLI or set CODEX_BIN to the correct path.`,
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
