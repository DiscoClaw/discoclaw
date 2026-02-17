// Claude Code CLI adapter strategy.
// Provides model-specific logic for the universal CLI adapter factory.

import type { RuntimeCapability } from '../types.js';
import type { CliAdapterStrategy, CliInvokeContext, UniversalCliOpts } from '../cli-strategy.js';
import { STDIN_THRESHOLD } from '../cli-shared.js';

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

  // Claude uses default JSONL parsing from the factory (extractTextFromUnknownEvent, etc.)
  // so we don't need a custom parseLine.
};
