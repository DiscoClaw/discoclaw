// Codex CLI adapter strategy.
// Provides model-specific logic for the universal CLI adapter factory.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageData, RuntimeCapability } from '../types.js';
import type { CliAdapterLogger, CliAdapterStrategy, CliInvokeContext, UniversalCliOpts, ParsedLineResult } from '../cli-strategy.js';

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

function extractItemId(item: Record<string, unknown>): string | undefined {
  const raw = item.id ?? item.item_id ?? item.itemId ?? item.call_id ?? item.callId;
  if (typeof raw !== 'string') return undefined;
  const id = compactText(raw, 120);
  return id || undefined;
}

function extractReasoningPreviewText(item: Record<string, unknown>, max = 260): string {
  const raw = typeof item.summary === 'string'
    ? item.summary
    : typeof item.text === 'string'
      ? item.text
      : '';
  return compactText(raw, max);
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
type CodexStrategyOptions = {
  verbosePreview?: boolean;
  itemTypeDebug?: boolean;
};

export function createCodexStrategy(
  defaultModel: string,
  strategyOpts: CodexStrategyOptions = {},
): CliAdapterStrategy {
  const verbosePreview = Boolean(strategyOpts.verbosePreview);
  const itemTypeDebug = Boolean(strategyOpts.itemTypeDebug);
  const forceReasoningSummaryAuto = verbosePreview || itemTypeDebug;

  function itemDebugEvent(phase: 'started' | 'completed', item: Record<string, unknown>) {
    const itemType = typeof item.type === 'string' ? item.type : 'item';
    if (itemType === 'agent_message') return null;
    const itemId = extractItemId(item);
    const status = typeof item.status === 'string' ? compactText(item.status, 80) : undefined;
    let label: string | undefined;

    // Preserve concise reasoning context in the guaranteed preview_debug lane.
    if (itemType === 'reasoning') {
      const compactSummary = extractReasoningPreviewText(item);
      if (phase === 'started') {
        label = 'Hypothesis: reasoning in progress.';
      } else {
        if (compactSummary) label = `Reasoning: ${compactSummary}`;
      }
    }

    return {
      type: 'preview_debug' as const,
      source: 'codex' as const,
      phase,
      itemType,
      ...(itemId ? { itemId } : {}),
      ...(status ? { status } : {}),
      ...(label ? { label } : {}),
    };
  }

  function itemPreviewLine(phase: 'started' | 'completed', item: Record<string, unknown>): string | null {
    const itemType = typeof item.type === 'string' ? item.type : 'item';
    const status = typeof item.status === 'string' ? item.status : undefined;
    const suffix = status ? ` (${compactText(status, 80)})` : '';

    if (itemType === 'agent_message') return null;

    if (itemType === 'reasoning') {
      const compactSummary = extractReasoningPreviewText(item);
      if (compactSummary) return `Reasoning ${phase}: ${compactSummary}`;
      return `Reasoning ${phase}${suffix}.`;
    }

    if (itemType === 'command_execution') {
      const command = typeof item.command === 'string'
        ? compactText(item.command, 260)
        : '';
      const exitCode = asFiniteNumber(item.exit_code ?? item.exitCode);
      if (phase === 'started') {
        return command
          ? `Command started: ${command}`
          : `Command started${suffix}.`;
      }
      const output = typeof item.aggregated_output === 'string'
        ? compactText(item.aggregated_output, 260)
        : '';
      if (output) return `Command output: ${output}`;
      if (exitCode !== undefined) return `Command completed (exit ${exitCode}).`;
      return `Command completed${suffix}.`;
    }

    const note = typeof item.note === 'string' ? compactText(item.note, 180) : '';
    if (note) return `${itemType} ${phase}: ${note}`;
    return `${itemType} ${phase}${suffix}.`;
  }

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
      'workspace_instructions',
      'mcp',
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

      // Keep reasoning summaries enabled whenever reasoning-aware preview/debug
      // is requested so preview_debug lanes can surface model-provided context.
      if (forceReasoningSummaryAuto) {
        args.push('-c', 'model_reasoning_summary="auto"');
      }

      // Map discoclaw model tier reasoning effort to Codex CLI config.
      // This overrides the global ~/.codex/config.toml setting per-invocation.
      if (ctx.params.reasoningEffort) {
        args.push('-c', `model_reasoning_effort="${ctx.params.reasoningEffort}"`);
      }

      // Map appendSystemPrompt → developer_instructions config override.
      // Equivalent to Claude's --append-system-prompt flag.
      if (opts.appendSystemPrompt) {
        args.push('-c', `developer_instructions="${opts.appendSystemPrompt.replace(/"/g, '\\"')}"`);
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

      // Add --image flags for temp image files (not supported on resume).
      if (!existingThreadId && ctx.tempImagePaths && ctx.tempImagePaths.length > 0) {
        for (const imgPath of ctx.tempImagePaths) {
          args.push('--image', imgPath);
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

    async prepareImages(images: ImageData[], log?: CliAdapterLogger): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-codex-img-'));
      const paths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const rawExt = img.mediaType.split('/')[1] || 'bin';
        const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
        const filePath = path.join(tmpDir, `image-${i}.${ext}`);
        await fs.writeFile(filePath, Buffer.from(img.base64, 'base64'));
        paths.push(filePath);
      }
      log?.debug?.({ count: paths.length, tmpDir }, 'codex: wrote temp image files');
      return {
        paths,
        cleanup: async () => {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        },
      };
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

      // Extract text from item lifecycle events.
      if (anyEvt.type === 'item.started' || anyEvt.type === 'item.completed') {
        const item = asObject(anyEvt.item);
        if (!item) return { activity: true };
        const phase: 'started' | 'completed' = anyEvt.type === 'item.started' ? 'started' : 'completed';
        const alwaysEmitReasoningStartDebug = phase === 'started' && item.type === 'reasoning';
        const debugEvent = alwaysEmitReasoningStartDebug || itemTypeDebug
          ? itemDebugEvent(phase, item)
          : null;
        const previewLine = verbosePreview ? itemPreviewLine(phase, item) : null;
        const previewEvents = [
          ...(debugEvent ? [debugEvent] : []),
          ...(previewLine ? [{ type: 'log_line' as const, stream: 'stdout' as const, line: previewLine }] : []),
        ];

        // Surface command execution progress as tool events so Discord
        // streaming doesn't look idle during long tool-heavy runs.
        if (item.type === 'command_execution') {
          const commandRaw = typeof item.command === 'string' ? item.command : 'command_execution';
          const command = compactText(commandRaw);
          if (anyEvt.type === 'item.started') {
            return {
              activity: true,
              extraEvents: [{ type: 'tool_start', name: 'command_execution', input: { command } }, ...previewEvents],
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
            }, ...previewEvents],
          };
        }

        if (anyEvt.type !== 'item.completed') {
          return previewEvents.length > 0
            ? { activity: true, extraEvents: previewEvents }
            : { activity: true };
        }

        // Reasoning items: stream as text_delta for the preview, but do not set
        // resultText so the final reply remains answer-only.
        if (item.type === 'reasoning') {
          const summary = item.summary;
          const text = item.text;
          const reasoningText =
            typeof summary === 'string' ? summary :
            typeof text === 'string' ? text :
            null;
          if (reasoningText) {
            return previewEvents.length > 0
              ? { text: reasoningText, extraEvents: previewEvents }
              : { text: reasoningText };
          }
          return previewEvents.length > 0 ? { extraEvents: previewEvents } : {};
        }

        // Agent message: stream as text_delta and lock in resultText so that
        // text_final uses the answer only and never falls back to merged
        // (which now includes reasoning text).
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          return previewEvents.length > 0
            ? { text: item.text, resultText: item.text, extraEvents: previewEvents }
            : { text: item.text, resultText: item.text };
        }

        if (previewEvents.length > 0) return { extraEvents: previewEvents };
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
