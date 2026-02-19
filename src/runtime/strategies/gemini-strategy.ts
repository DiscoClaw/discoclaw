// Gemini CLI adapter strategy.
// Phase 1: one-shot text output, no sessions.
// Provides model-specific logic for the universal CLI adapter factory.

import type { RuntimeCapability } from '../types.js';
import type { CliAdapterStrategy, CliInvokeContext, UniversalCliOpts } from '../cli-strategy.js';

/** Max chars for error messages exposed outside the adapter. Prevents prompt leaks. */
const MAX_ERROR_LENGTH = 200;

function sanitizeGeminiError(raw: string): string {
  if (!raw) return 'gemini failed (no details)';
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'gemini failed';
  // Return only the first meaningful line to avoid leaking prompt content.
  return lines[0]!.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Create a Gemini CLI adapter strategy.
 * Factory function because defaultModel varies per runtime instance.
 */
export function createGeminiStrategy(defaultModel: string): CliAdapterStrategy {
  return {
    id: 'gemini',
    binaryDefault: 'gemini',
    defaultModel,
    capabilities: ['streaming_text'] satisfies readonly RuntimeCapability[],

    getOutputMode(_ctx: CliInvokeContext, _opts: UniversalCliOpts): 'text' | 'jsonl' {
      return 'text';
    },

    buildArgs(ctx: CliInvokeContext, _opts: UniversalCliOpts): string[] {
      const { params, useStdin } = ctx;
      const args: string[] = ['--model', params.model];

      if (!useStdin) {
        // `--` terminates option parsing so prompts like "--- SOUL.md ---" are
        // always treated as positional input rather than CLI flags.
        args.push('--', params.prompt);
      }
      // When useStdin is true, no positional arg is added — the binary reads from stdin.

      return args;
    },

    buildStdinPayload(ctx: CliInvokeContext): string | null {
      if (!ctx.useStdin) return null;
      // Gemini CLI reads raw text from stdin when no positional prompt is given.
      return ctx.params.prompt;
    },

    sanitizeError(raw: string): string {
      return sanitizeGeminiError(raw);
    },

    handleSpawnError(err: any, binary: string): string | null {
      // Let the universal adapter handle timeouts.
      if (err?.timedOut) return null;

      // Use fixed messages to prevent prompt leaks.
      // execa's shortMessage/originalMessage can contain the full command line.
      const code = err?.code || err?.errno || '';
      const isNotFound = code === 'ENOENT' || String(err?.originalMessage || '').includes('ENOENT');
      if (isNotFound) return `gemini binary not found (${binary}). Check GEMINI_BIN or PATH.`;
      return `gemini process failed unexpectedly${code ? ` (${code})` : ''}`;
    },
  };
}
