/**
 * Smoke-test helpers: prompt definitions, response validation, and env-driven
 * runtime factory.  Used by model-smoke.test.ts to exercise each configured
 * model tier through the full RuntimeAdapter.invoke() → EngineEvent pipeline.
 */

import type { EngineEvent, RuntimeAdapter } from './types.js';
import { createClaudeCliRuntime } from './claude-code-cli.js';
import { createOpenAICompatRuntime } from './openai-compat.js';
import { createCodexCliRuntime } from './codex-cli.js';

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

export type SmokeCategory = 'greeting' | 'arithmetic' | 'json' | 'echo';

export type SmokePrompt = {
  readonly category: SmokeCategory;
  /** Prompt text sent verbatim to the model. */
  readonly prompt: string;
  /**
   * Optional content validator called with the accumulated response text.
   * Return true if the response is acceptable for this category.
   */
  readonly validate?: (responseText: string) => boolean;
};

export const SMOKE_PROMPTS: readonly SmokePrompt[] = [
  {
    category: 'greeting',
    prompt: 'Say hello in exactly one sentence. Output only that sentence.',
    // No strict predicate — non-empty text is sufficient for greeting.
  },
  {
    category: 'arithmetic',
    prompt: 'What is 6 multiplied by 7? Output only the number, nothing else.',
    validate: (text) => text.trim().includes('42'),
  },
  {
    category: 'json',
    prompt: 'Output only this exact JSON object and nothing else: {"status":"ok"}',
    validate: (text) => {
      const m = text.match(/\{[^}]+\}/);
      if (!m) return false;
      try {
        const parsed = JSON.parse(m[0]) as unknown;
        return (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as Record<string, unknown>).status === 'ok'
        );
      } catch {
        return false;
      }
    },
  },
  {
    category: 'echo',
    prompt: 'Echo back the word SMOKETEST verbatim. Output only that single word.',
    validate: (text) => text.toUpperCase().includes('SMOKETEST'),
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
 * Drain an EngineEvent stream and return a validated result.
 *
 * Fails if:
 * - an `error` event appears in the stream
 * - the stream ends without a `done` event
 * - the accumulated response text is empty
 */
export async function collectAndValidate(
  iter: AsyncIterable<EngineEvent>,
): Promise<SmokeResult> {
  const events: EngineEvent[] = [];
  for await (const evt of iter) {
    events.push(evt);
  }

  const errorEvt = events.find(
    (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
  );
  if (errorEvt) {
    return { ok: false, text: '', errorMessage: errorEvt.message, events };
  }

  if (!events.some((e) => e.type === 'done')) {
    return {
      ok: false,
      text: '',
      errorMessage: 'stream ended without done event',
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

  if (!text.trim()) {
    return { ok: false, text, errorMessage: 'response text is empty', events };
  }

  return { ok: true, text, events };
}

// ---------------------------------------------------------------------------
// Env-driven runtime factory
// ---------------------------------------------------------------------------

/**
 * Build a RuntimeAdapter from env vars for the given runtime ID.
 *
 * Returns `null` when required configuration is absent:
 * - `claude_code` — always returns an adapter; the binary check happens at
 *   invoke time so missing binaries surface as `error` events.
 * - `openai`       — returns null when `OPENAI_API_KEY` is unset.
 * - `codex`        — always returns an adapter; binary check at invoke time.
 */
export function runtimeFromEnv(
  runtimeId: 'claude_code' | 'openai' | 'codex',
  env: NodeJS.ProcessEnv = process.env,
): RuntimeAdapter | null {
  switch (runtimeId) {
    case 'claude_code': {
      const claudeBin = env.CLAUDE_BIN?.trim() || 'claude';
      const outputFormat: 'text' | 'stream-json' =
        env.CLAUDE_OUTPUT_FORMAT?.trim() === 'stream-json' ? 'stream-json' : 'text';
      const dangerouslySkipPermissions =
        env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === '1';
      return createClaudeCliRuntime({
        claudeBin,
        dangerouslySkipPermissions,
        outputFormat,
      });
    }

    case 'openai': {
      const apiKey = env.OPENAI_API_KEY?.trim();
      if (!apiKey) return null;
      const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
      const defaultModel = env.OPENAI_MODEL?.trim() || 'gpt-4o';
      return createOpenAICompatRuntime({ apiKey, baseUrl, defaultModel });
    }

    case 'codex': {
      const codexBin = env.CODEX_BIN?.trim() || 'codex';
      const defaultModel = env.CODEX_MODEL?.trim() || 'gpt-5.3-codex';
      return createCodexCliRuntime({ codexBin, defaultModel });
    }
  }
}
