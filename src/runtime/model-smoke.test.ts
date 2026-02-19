/**
 * Model smoke tests — end-to-end validation of each configured runtime.
 *
 * Opt-in per runtime via environment variables (all skipped by default so
 * normal `pnpm test` runs are not slowed down):
 *
 *   SMOKE_CLAUDE=1          Run Claude Code smoke tests (both fast + capable tiers)
 *   SMOKE_OPENAI=1          Run OpenAI-compat smoke tests (OPENAI_API_KEY must also be set)
 *   SMOKE_CODEX=1           Run Codex CLI smoke tests
 *
 * Catches: bad API keys, wrong tier mappings, malformed system prompts,
 * missing binaries — all surfaces as error events or empty text.
 */

import { describe, expect, it } from 'vitest';
import { SMOKE_PROMPTS, collectAndValidate, runtimeFromEnv } from './model-smoke-helpers.js';

/** Working directory passed to every invocation. */
const CWD = '/tmp';

/** Per-test timeout — real model calls can take up to 60 s. */
const TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Claude Code — fast tier (haiku)
// ---------------------------------------------------------------------------

const CLAUDE_ENABLED = process.env.SMOKE_CLAUDE === '1';

describe.skipIf(!CLAUDE_ENABLED)('claude_code / fast (haiku)', () => {
  const rt = runtimeFromEnv('claude_code');

  it.each(SMOKE_PROMPTS)('$category', async ({ prompt, validate }) => {
    const result = await collectAndValidate(
      rt!.invoke({ prompt, model: 'haiku', cwd: CWD }),
    );
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    if (validate) {
      expect(
        validate(result.text),
        `validation failed for text: ${JSON.stringify(result.text)}`,
      ).toBe(true);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Claude Code — capable tier (opus)
// ---------------------------------------------------------------------------

describe.skipIf(!CLAUDE_ENABLED)('claude_code / capable (opus)', () => {
  const rt = runtimeFromEnv('claude_code');

  it.each(SMOKE_PROMPTS)('$category', async ({ prompt, validate }) => {
    const result = await collectAndValidate(
      rt!.invoke({ prompt, model: 'opus', cwd: CWD }),
    );
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    if (validate) {
      expect(
        validate(result.text),
        `validation failed for text: ${JSON.stringify(result.text)}`,
      ).toBe(true);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// OpenAI-compat — adapter-default model
// ---------------------------------------------------------------------------

/**
 * Opt-in guard: set SMOKE_OPENAI=1 to run OpenAI-compat smoke tests.
 * OPENAI_API_KEY must also be present (the factory requires it).
 */
const OPENAI_ENABLED =
  process.env.SMOKE_OPENAI === '1' && Boolean(process.env.OPENAI_API_KEY?.trim());

describe.skipIf(!OPENAI_ENABLED)('openai / default model', () => {
  const rt = runtimeFromEnv('openai');

  it.each(SMOKE_PROMPTS)('$category', async ({ prompt, validate }) => {
    const result = await collectAndValidate(
      rt!.invoke({ prompt, model: '', cwd: CWD }),
    );
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    if (validate) {
      expect(
        validate(result.text),
        `validation failed for text: ${JSON.stringify(result.text)}`,
      ).toBe(true);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Codex CLI — adapter-default model
// ---------------------------------------------------------------------------

const CODEX_ENABLED = process.env.SMOKE_CODEX === '1';

describe.skipIf(!CODEX_ENABLED)('codex / default model', () => {
  const rt = runtimeFromEnv('codex');

  it.each(SMOKE_PROMPTS)('$category', async ({ prompt, validate }) => {
    const result = await collectAndValidate(
      rt!.invoke({ prompt, model: '', cwd: CWD }),
    );
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    if (validate) {
      expect(
        validate(result.text),
        `validation failed for text: ${JSON.stringify(result.text)}`,
      ).toBe(true);
    }
  }, TIMEOUT);
});
