// Codex CLI adapter strategy.
// Provides model-specific logic for the universal CLI adapter factory.

import type { RuntimeCapability } from '../types.js';
import type { CliAdapterStrategy, CliInvokeContext, UniversalCliOpts, ParsedLineResult } from '../cli-strategy.js';

/** Max chars for error messages exposed outside the adapter. Prevents prompt/session leaks. */
const MAX_ERROR_LENGTH = 200;

const CODEX_NOISY_LINE_PATTERNS = [
  /^warning:/i,
  /^openai codex v/i,
  /^-+$/,
  /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i,
  /^user$/i,
  /^mcp startup:/i,
  /^reconnecting\.\.\./i,
];

const CODEX_DIAGNOSTIC_LINE_PATTERN =
  /\berror\b|\bfailed\b|timed out|timeout|not found|permission denied|invalid|denied|unauthorized|forbidden|expired|rate limit|disconnected/i;
const CODEX_PREVIEW_TEXT_MAX = 400;

function isNoisyCodexLine(line: string): boolean {
  return CODEX_NOISY_LINE_PATTERNS.some((re) => re.test(line));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactText(value: string, max = CODEX_PREVIEW_TEXT_MAX): string {
  const oneLine = value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '\u2026';
}

/**
 * Strip prompt content and internal details from error messages.
 * Codex CLI can include the full prompt, session paths, and auth details in stderr on failure.
 */
function sanitizeCodexError(raw: string): string {
  if (!raw) return 'codex failed (no details)';
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'codex failed';

  // Known Codex state DB corruption mode: stale/missing rollout paths in session index.
  if (lines.some((l) => /state db (missing|returned stale) rollout path/i.test(l))) {
    return 'codex session state appears corrupted (rollout path missing). Set CODEX_HOME to a clean directory and retry.'
      .slice(0, MAX_ERROR_LENGTH);
  }

  const meaningful = lines.filter((l) => !isNoisyCodexLine(l));
  const diagnostic = [...meaningful].reverse().find((l) => CODEX_DIAGNOSTIC_LINE_PATTERN.test(l));
  if (diagnostic) return diagnostic.slice(0, MAX_ERROR_LENGTH);

  // Avoid leaking prompt content when stderr only contains non-diagnostic chatter.
  return 'codex failed (no details)';
}

/**
 * Create a Codex CLI adapter strategy.
 * Factory function because defaultModel varies per runtime instance.
 */
export function createCodexStrategy(defaultModel: string): CliAdapterStrategy {
  return {
    id: 'codex',
    binaryDefault: 'codex',
    defaultModel,
    capabilities: [
      'streaming_text',
      'tools_fs',
      'tools_exec',
      'tools_web',
      'sessions',
    ] satisfies readonly RuntimeCapability[],

    multiTurnMode: 'session-resume',

    getOutputMode(ctx: CliInvokeContext, _opts: UniversalCliOpts): 'text' | 'jsonl' {
      const wantSession = ctx.sessionMap != null && Boolean(ctx.params.sessionKey);
      return wantSession ? 'jsonl' : 'text';
    },

    buildArgs(ctx: CliInvokeContext, opts: UniversalCliOpts): string[] {
      const { params, useStdin } = ctx;
      const wantSession = ctx.sessionMap != null && Boolean(params.sessionKey);
      const existingThreadId = params.sessionKey ? ctx.sessionMap?.get(params.sessionKey) : undefined;
      const dangerousBypass = Boolean(opts.dangerouslySkipPermissions);

      // When resuming, use `codex exec resume <thread_id>`.
      // The resume subcommand does NOT support -s/--sandbox (inherits from original session).
      // When starting a new session (or ephemeral), use `codex exec`.
      const args: string[] = existingThreadId
        ? ['exec', 'resume', existingThreadId, '-m', params.model, '--skip-git-repo-check']
        : ['exec', '-m', params.model, '--skip-git-repo-check', ...(wantSession ? [] : ['--ephemeral'])];

      if (dangerousBypass) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else if (!existingThreadId) {
        args.push('-s', 'read-only');
      }

      // When session tracking is active, use --json so we can capture the thread_id
      // from the `thread.started` event.
      if (wantSession) {
        args.push('--json');
      }

      // Pass --add-dir flags for additional directories.
      // The resume subcommand does NOT support --add-dir (inherits from original session).
      if (!existingThreadId && params.addDirs && params.addDirs.length > 0) {
        for (const dir of params.addDirs) {
          args.push('--add-dir', dir);
        }
      }

      // `--` terminates option parsing so prompts like "--- SOUL.md ---" are
      // always treated as positional input rather than CLI flags.
      args.push('--');
      if (useStdin) {
        // Use `-` to signal stdin reading.
        args.push('-');
      } else {
        args.push(params.prompt);
      }

      return args;
    },

    buildStdinPayload(ctx: CliInvokeContext): string | null {
      if (!ctx.useStdin) return null;
      // Codex uses raw text stdin (not JSON-wrapped like Claude).
      return ctx.params.prompt;
    },

    parseLine(evt: unknown, ctx: CliInvokeContext): ParsedLineResult | null {
      const anyEvt = evt as Record<string, unknown>;

      // Capture thread_id for session resume on subsequent calls.
      if (anyEvt.type === 'thread.started' && anyEvt.thread_id && ctx.params.sessionKey && ctx.sessionMap) {
        ctx.sessionMap.set(ctx.params.sessionKey, String(anyEvt.thread_id));
        return {}; // Handled — no text to emit.
      }

      // Emit usage for streaming preview.
      if (anyEvt.type === 'turn.completed') {
        const usage = asObject(anyEvt.usage);
        if (!usage) return { activity: true };
        const inputTokens = asFiniteNumber(usage.input_tokens ?? usage.inputTokens);
        const outputTokens = asFiniteNumber(usage.output_tokens ?? usage.outputTokens);
        const totalTokens = asFiniteNumber(usage.total_tokens ?? usage.totalTokens);
        const costUsd = asFiniteNumber(usage.cost_usd ?? usage.costUsd);
        return {
          activity: true,
          extraEvents: [{
            type: 'usage',
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          }],
        };
      }

      // Extract text from completed items.
      if (anyEvt.type === 'item.started' || anyEvt.type === 'item.completed') {
        const item = asObject(anyEvt.item);
        if (!item) return { activity: true };

        // Surface command execution progress as tool events so Discord
        // streaming doesn't look idle during long tool-heavy runs.
        if (item.type === 'command_execution') {
          const commandRaw = typeof item.command === 'string' ? item.command : 'command_execution';
          const command = compactText(commandRaw);
          if (anyEvt.type === 'item.started') {
            return {
              activity: true,
              extraEvents: [{ type: 'tool_start', name: 'command_execution', input: { command } }],
            };
          }
          const exitCode = asFiniteNumber(item.exit_code ?? item.exitCode);
          const outputRaw = typeof item.aggregated_output === 'string'
            ? compactText(item.aggregated_output)
            : undefined;
          return {
            activity: true,
            extraEvents: [{
              type: 'tool_end',
              name: 'command_execution',
              ok: exitCode === undefined ? true : exitCode === 0,
              output: {
                command,
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(outputRaw ? { output: outputRaw } : {}),
              },
            }],
          };
        }

        if (anyEvt.type !== 'item.completed') return { activity: true };

        // Reasoning items: stream as text_delta for the preview, but do not set
        // resultText so the final reply remains answer-only.
        if (item.type === 'reasoning') {
          const summary = item.summary;
          const text = item.text;
          const reasoningText =
            typeof summary === 'string' ? summary :
            typeof text === 'string' ? text :
            null;
          if (reasoningText) return { text: reasoningText };
          return {};
        }

        // Agent message: stream as text_delta and lock in resultText so that
        // text_final uses the answer only and never falls back to merged
        // (which now includes reasoning text).
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          return { text: item.text, resultText: item.text };
        }
      }

      // Other JSONL events (turn.completed, etc.) — not handled by Codex strategy.
      return null;
    },

    sanitizeError(raw: string): string {
      return sanitizeCodexError(raw);
    },

    handleSpawnError(err: unknown, binary: string): string | null {
      // Let the universal adapter handle timeouts.
      if ((err as { timedOut?: boolean } | undefined)?.timedOut) return null;

      // Use fixed messages to prevent prompt/session leaks.
      // execa's shortMessage/originalMessage can contain the full command line.
      const e = err as { code?: unknown; errno?: unknown; originalMessage?: unknown };
      const code = e.code || e.errno || '';
      const isNotFound = code === 'ENOENT' || String(e.originalMessage || '').includes('ENOENT');
      if (isNotFound) return `codex binary not found (${binary}). Check CODEX_BIN or PATH.`;
      return `codex process failed unexpectedly${code ? ` (${code})` : ''}`;
    },
  };
}
