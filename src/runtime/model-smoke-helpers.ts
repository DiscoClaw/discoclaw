/**
 * Smoke-test helpers: prompt definitions, response validation, and env-driven
 * runtime factories.  Used by model-smoke.test.ts to exercise each configured
 * model tier through the full RuntimeAdapter.invoke() → EngineEvent pipeline.
 *
 * Runtime factories:
 *   buildSmokeRuntime        — Claude Code CLI (CLAUDE_BIN, CLAUDE_OUTPUT_FORMAT, …)
 *   buildGeminiSmokeRuntime  — Gemini CLI      (GEMINI_BIN, GEMINI_MODEL)
 *   buildOpenAISmokeRuntime  — OpenAI API      (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL)
 *   buildCodexSmokeRuntime   — Codex CLI       (CODEX_BIN, CODEX_MODEL)
 */

import type { EngineEvent, RuntimeAdapter } from './types.js';
import { createClaudeCliRuntime } from './claude-code-cli.js';
import { createGeminiCliRuntime } from './gemini-cli.js';
import { createOpenAICompatRuntime } from './openai-compat.js';
import { createCodexCliRuntime } from './codex-cli.js';

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

export type PromptCategory = {
  readonly name: string;
  /** Prompt text sent verbatim to the model. */
  readonly prompt: string;
  /**
   * Optional content validator called with the accumulated response text.
   * Return true if the response is acceptable for this category.
   */
  readonly validate?: (responseText: string) => boolean;
};

export const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  {
    name: 'greeting',
    prompt: 'Say hello in exactly one sentence. Output only that sentence.',
    // Non-empty text is sufficient for greeting.
  },
  {
    name: 'code_block',
    prompt:
      'Write a JavaScript function called add that takes two numbers and returns their sum. Wrap your answer in a fenced code block.',
    validate: (text) => text.includes('```'),
  },
  {
    name: 'structured_markdown',
    prompt: 'List the three primary colors of light as a markdown bullet list. Output only the list.',
    validate: (text) => text.includes('-') || text.includes('*'),
  },
  {
    name: 'cron_style',
    prompt:
      'What cron expression runs a job every day at midnight? Output only the cron expression, nothing else.',
    validate: (text) => /\d/.test(text) && text.includes('*'),
  },
  {
    name: 'unicode',
    prompt: 'Echo back this emoji exactly: 🎉 Output only the emoji.',
    validate: (text) => text.includes('🎉'),
  },
  {
    name: 'empty_input',
    prompt: '   ',
    // No strict validate; model should respond without crashing.
  },
] as const;

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

export type SmokeResult = {
  ok: boolean;
  text: string;
  errorMessage?: string;
  events: EngineEvent[];
};

/**
 * Validate a pre-collected EngineEvent array and return a diagnostic result.
 *
 * Fails if:
 * - an `error` event appears in the stream
 * - the stream ends without a `done` event
 * - the accumulated response text is empty (except for `empty_input` category)
 *
 * Tier and category labels are included in all diagnostic messages.
 */
export function validateSmokeResponse(
  events: EngineEvent[],
  tierLabel: string,
  categoryName: string,
): SmokeResult {
  const label = `[${tierLabel}/${categoryName}]`;

  const errorEvt = events.find(
    (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
  );
  if (errorEvt) {
    return {
      ok: false,
      text: '',
      errorMessage: `${label} error event: ${errorEvt.message}`,
      events,
    };
  }

  if (!events.some((e) => e.type === 'done')) {
    return {
      ok: false,
      text: '',
      errorMessage: `${label} stream ended without done event`,
      events,
    };
  }

  // Prefer text_final; fall back to concatenated text_delta events.
  const finalEvt = events.find(
    (e): e is Extract<EngineEvent, { type: 'text_final' }> => e.type === 'text_final',
  );
  const text = finalEvt
    ? finalEvt.text
    : events
        .filter((e): e is Extract<EngineEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.text)
        .join('');

  // For empty_input category, an empty response is acceptable.
  if (!text.trim() && categoryName !== 'empty_input') {
    return { ok: false, text, errorMessage: `${label} response text is empty`, events };
  }

  return { ok: true, text, events };
}

// ---------------------------------------------------------------------------
// Env-driven runtime factory
// ---------------------------------------------------------------------------

export type SmokeRuntime = {
  runtime: RuntimeAdapter;
  /** Resolved binary path/name, for beforeAll availability checks. */
  claudeBin: string;
};

export type GeminiSmokeRuntime = {
  runtime: RuntimeAdapter;
  /** Resolved binary path/name, for beforeAll availability checks. */
  geminiBin: string;
};

/**
 * Build a RuntimeAdapter from env vars, applying the same normalization rules
 * as `parseConfig` in src/config.ts:
 * - `CLAUDE_OUTPUT_FORMAT` validated as `text` | `stream-json`
 * - verbose suppressed when outputFormat is `text`
 * - `RUNTIME_MAX_BUDGET_USD` validated as a positive finite number
 *
 * Returns both the adapter and the resolved binary path so callers can run a
 * binary availability check before invoking.
 */
export function buildSmokeRuntime(env: NodeJS.ProcessEnv = process.env): SmokeRuntime {
  const claudeBin = env.CLAUDE_BIN?.trim() || 'claude';

  const outputFormatRaw = env.CLAUDE_OUTPUT_FORMAT?.trim();
  if (outputFormatRaw && outputFormatRaw !== 'text' && outputFormatRaw !== 'stream-json') {
    throw new Error(
      `CLAUDE_OUTPUT_FORMAT must be "text" or "stream-json", got "${outputFormatRaw}"`,
    );
  }
  const outputFormat: 'text' | 'stream-json' =
    outputFormatRaw === 'stream-json' ? 'stream-json' : 'text';

  const rawVerbose = env.CLAUDE_VERBOSE === '1';
  const verbose = rawVerbose && outputFormat !== 'text';

  const dangerouslySkipPermissions = env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === '1';

  let maxBudgetUsd: number | undefined;
  const budgetRaw = env.RUNTIME_MAX_BUDGET_USD?.trim();
  if (budgetRaw) {
    const parsed = Number(budgetRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`RUNTIME_MAX_BUDGET_USD must be a positive number, got "${budgetRaw}"`);
    }
    maxBudgetUsd = parsed;
  }

  const runtime = createClaudeCliRuntime({
    claudeBin,
    dangerouslySkipPermissions,
    outputFormat,
    verbose,
    maxBudgetUsd,
  });

  return { runtime, claudeBin };
}

/**
 * Build a Gemini RuntimeAdapter from env vars.
 * Reads `GEMINI_BIN` (default: `gemini`) and `GEMINI_MODEL` (default: `gemini-2.5-flash`).
 */
export function buildGeminiSmokeRuntime(env: NodeJS.ProcessEnv = process.env): GeminiSmokeRuntime {
  const geminiBin = env.GEMINI_BIN?.trim() || 'gemini';
  const defaultModel = env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

  const runtime = createGeminiCliRuntime({ geminiBin, defaultModel });

  return { runtime, geminiBin };
}

/**
 * Build an OpenAI RuntimeAdapter from env vars.
 * Reads `OPENAI_API_KEY`, `OPENAI_BASE_URL` (default: `https://api.openai.com/v1`),
 * and `OPENAI_MODEL` (default: `gpt-4o`).
 */
export function buildOpenAISmokeRuntime(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim() || '';
  const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const defaultModel = env.OPENAI_MODEL?.trim() || 'gpt-4o';

  const runtime = createOpenAICompatRuntime({ auth: 'api_key', apiKey, baseUrl, defaultModel });

  return { runtime, apiKey };
}

/**
 * Build a Codex CLI RuntimeAdapter from env vars.
 * Reads `CODEX_BIN` (default: `codex`) and `CODEX_MODEL` (default: `gpt-5.3-codex`).
 */
export function buildCodexSmokeRuntime(env: NodeJS.ProcessEnv = process.env) {
  const codexBin = env.CODEX_BIN?.trim() || 'codex';
  const defaultModel = env.CODEX_MODEL?.trim() || 'gpt-5.3-codex';

  const runtime = createCodexCliRuntime({ codexBin, defaultModel });

  return { runtime, codexBin };
}
