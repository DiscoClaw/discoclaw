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

function isNoisyCodexLine(line: string): boolean {
  return CODEX_NOISY_LINE_PATTERNS.some((re) => re.test(line));
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

      // Extract text from agent_message items.
      if (anyEvt.type === 'item.completed') {
        const item = anyEvt.item as Record<string, unknown> | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          return { text: item.text };
        }
      }

      // Other JSONL events (turn.completed, etc.) — not handled by Codex strategy.
      return null;
    },

    sanitizeError(raw: string): string {
      return sanitizeCodexError(raw);
    },

    handleSpawnError(err: any, binary: string): string | null {
      // Let the universal adapter handle timeouts.
      if (err?.timedOut) return null;

      // Use fixed messages to prevent prompt/session leaks.
      // execa's shortMessage/originalMessage can contain the full command line.
      const code = err?.code || err?.errno || '';
      const isNotFound = code === 'ENOENT' || String(err?.originalMessage || '').includes('ENOENT');
      if (isNotFound) return `codex binary not found (${binary}). Check CODEX_BIN or PATH.`;
      return `codex process failed unexpectedly${code ? ` (${code})` : ''}`;
    },
  };
}
