// Claude Code CLI adapter strategy.
// Provides model-specific logic for the universal CLI adapter factory.

import type { RuntimeCapability } from '../types.js';
import type { CliAdapterStrategy, CliInvokeContext, ParsedLineResult, UniversalCliOpts } from '../cli-strategy.js';
import { extractResultText, extractResultContentBlocks } from '../cli-output-parsers.js';

export const claudeStrategy: CliAdapterStrategy = {
  id: 'claude_code',
  binaryDefault: 'claude',
  defaultModel: 'opus',
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

  parseLine(evt: unknown, _ctx: CliInvokeContext): ParsedLineResult | null {
    if (!evt || typeof evt !== 'object') return null;
    const obj = evt as Record<string, unknown>;

    // --- stream_event wrapper (Anthropic API events) ---
    if (obj.type === 'stream_event' && obj.event && typeof obj.event === 'object') {
      const inner = obj.event as Record<string, unknown>;

      // content_block_delta — the only event type that carries streaming text.
      // Only extract text from text_delta; skip thinking_delta, input_json_delta, etc.
      if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
        const delta = inner.delta as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          return { text: delta.text };
        }
        // thinking_delta, input_json_delta, signature_delta, etc. — consumed, no text.
        return {};
      }

      // All other stream_event types (message_start, content_block_start,
      // content_block_stop, message_delta, message_stop) — consumed, no text.
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
