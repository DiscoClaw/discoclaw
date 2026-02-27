// Claude Code CLI adapter strategy.
// Provides model-specific logic for the universal CLI adapter factory.

import type { EngineEvent, RuntimeCapability } from '../types.js';
import type { CliAdapterStrategy, CliInvokeContext, ParsedLineResult, UniversalCliOpts } from '../cli-strategy.js';
import { extractResultText, extractResultContentBlocks } from '../cli-output-parsers.js';

/**
 * Compact safety reminder prepended to every forge and planRun phase prompt.
 * Mirrors the destructive patterns guarded by the tool-call gate so the model
 * receives an explicit boundary at each phase boundary.
 */
export const PHASE_SAFETY_REMINDER =
  'SAFETY (automated agent): Do not run rm -rf outside build artifact directories, ' +
  'git push --force, git branch -D, DROP TABLE, or chmod 777. ' +
  'Do not write to .env, root-policy.ts, ~/.ssh/, or ~/.claude/ paths. ' +
  'If a task requires any of these, report it instead of executing.';

// Per-invocation tool tracking state (keyed by ctx to avoid cross-invocation leaks).
type ToolTrackState = { activeTools: Map<number, string>; inputBufs: Map<number, string> };
const toolState = new WeakMap<CliInvokeContext, ToolTrackState>();
function getToolState(ctx: CliInvokeContext): ToolTrackState {
  let s = toolState.get(ctx);
  if (!s) { s = { activeTools: new Map(), inputBufs: new Map() }; toolState.set(ctx, s); }
  return s;
}

export const claudeStrategy: CliAdapterStrategy = {
  id: 'claude_code',
  binaryDefault: 'claude',
  defaultModel: 'sonnet',
  capabilities: [
    'streaming_text',
    'sessions',
    'workspace_instructions',
    'tools_exec',
    'tools_fs',
    'tools_web',
    'mcp',
  ] satisfies readonly RuntimeCapability[],

  multiTurnMode: 'process-pool',

  getOutputMode(ctx: CliInvokeContext, opts: UniversalCliOpts): 'text' | 'jsonl' {
    // Images require stream-json for content block parsing.
    if (ctx.useStdin) return 'jsonl';
    return opts.outputFormat === 'stream-json' ? 'jsonl' : 'text';
  },

  buildArgs(ctx: CliInvokeContext, opts: UniversalCliOpts): string[] {
    const { params, useStdin, hasImages } = ctx;
    const effectiveOutputFormat = useStdin ? 'stream-json' : (opts.outputFormat ?? 'text');
    const args: string[] = ['-p', '--model', params.model];

    if (opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.strictMcpConfig) {
      args.push('--strict-mcp-config');
    }

    if (opts.fallbackModel) {
      args.push('--fallback-model', opts.fallbackModel);
    }

    if (opts.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }

    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    if (opts.debugFile && opts.debugFile.trim()) {
      args.push('--debug-file', opts.debugFile.trim());
    }

    if (opts.verbose) {
      args.push('--verbose');
    }

    if (params.sessionId) {
      args.push('--session-id', params.sessionId);
    }

    if (params.addDirs && params.addDirs.length > 0) {
      for (const dir of params.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    if (useStdin) {
      args.push('--input-format', 'stream-json');
    }

    if (effectiveOutputFormat) {
      args.push('--output-format', effectiveOutputFormat);
    }

    if (effectiveOutputFormat === 'stream-json') {
      args.push('--include-partial-messages');
    }

    if (params.tools) {
      if (params.tools.length > 0) {
        args.push('--tools', params.tools.join(','));
      } else {
        args.push('--tools=');
      }
    }

    if (!useStdin) {
      args.push('--', params.prompt);
    }

    return args;
  },

  buildStdinPayload(ctx: CliInvokeContext): string | null {
    if (!ctx.useStdin) return null;
    const { params } = ctx;
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: params.prompt },
    ];
    if (ctx.hasImages && params.images) {
      for (const img of params.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        });
      }
    }
    return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  },

  parseLine(evt: unknown, ctx: CliInvokeContext): ParsedLineResult | null {
    if (!evt || typeof evt !== 'object') return null;
    const obj = evt as Record<string, unknown>;

    // --- stream_event wrapper (Anthropic API events) ---
    if (obj.type === 'stream_event' && obj.event && typeof obj.event === 'object') {
      const inner = obj.event as Record<string, unknown>;
      const idx = typeof inner.index === 'number' ? inner.index : -1;

      // content_block_start — detect tool_use blocks for activity labels.
      if (inner.type === 'content_block_start' && inner.content_block && typeof inner.content_block === 'object') {
        const cb = inner.content_block as Record<string, unknown>;
        if (cb.type === 'tool_use' && typeof cb.name === 'string') {
          const ts = getToolState(ctx);
          ts.activeTools.set(idx, cb.name);
          ts.inputBufs.set(idx, '');
        }
        return {};
      }

      // content_block_delta — text, thinking, tool input, etc.
      if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
        const delta = inner.delta as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          return { text: delta.text };
        }
        // Accumulate input_json_delta for tool input (used by tool_end to provide file paths).
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const ts = getToolState(ctx);
          const buf = ts.inputBufs.get(idx);
          if (buf !== undefined) ts.inputBufs.set(idx, buf + delta.partial_json);
          // Signal activity so the progress stall timer resets — tool input
          // generation is real work, not a thinking spiral.
          return { activity: true };
        }
        // thinking_delta, signature_delta, etc. — consumed, no text, no activity signal.
        // thinking_delta intentionally does NOT set activity: the spiral detector
        // is specifically designed to catch long thinking spans with no output.
        return {};
      }

      // content_block_stop — emit tool_start (with parsed input) + tool_end for activity labels.
      if (inner.type === 'content_block_stop') {
        const ts = getToolState(ctx);
        const name = ts.activeTools.get(idx);
        if (name) {
          let input: unknown;
          const buf = ts.inputBufs.get(idx);
          if (buf) { try { input = JSON.parse(buf); } catch { /* partial */ } }
          ts.activeTools.delete(idx);
          ts.inputBufs.delete(idx);
          // Emit tool_start with the full input (so toolActivityLabel gets file paths),
          // then tool_end to transition back. The ToolAwareQueue handles this sequence.
          const events: EngineEvent[] = [
            { type: 'tool_start', name, ...(input ? { input } : {}) },
            { type: 'tool_end', name, ok: true },
          ];
          return { extraEvents: events };
        }
        return {};
      }

      // All other stream_event types (message_start, message_delta, message_stop) — consumed, no text.
      return {};
    }

    // --- assistant partial messages (from --include-partial-messages) ---
    if (obj.type === 'assistant') return {};

    // --- result event ---
    if (obj.type === 'result') {
      const rt = extractResultText(evt);
      const blocks = extractResultContentBlocks(evt);
      if (rt || blocks) {
        return {
          resultText: rt ?? blocks?.text ?? null,
          resultImages: blocks?.images,
        };
      }
      return {};
    }

    // --- system init event ---
    if (obj.type === 'system') return {};

    // Unknown event — fall through to default parsing.
    return null;
  },
};
