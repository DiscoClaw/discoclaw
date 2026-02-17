// Template strategy for adding a new CLI-based runtime adapter.
//
// To add a new model:
// 1. Copy this file and rename (e.g. gemini-strategy.ts).
// 2. Implement the required hooks below.
// 3. Create a thin wrapper in src/runtime/<model>-cli.ts:
//
//    import { createCliRuntime } from './cli-adapter.js';
//    import { myStrategy } from './strategies/my-strategy.js';
//
//    export function createMyCliRuntime(opts: MyOpts): RuntimeAdapter {
//      return createCliRuntime(myStrategy, { binary: opts.bin, ... });
//    }
//
// 4. Register in src/runtime/registry.ts and src/index.ts.
//
// The universal adapter (cli-adapter.ts) provides:
// - Subprocess tracking + kill-all shutdown
// - Process pool (multi-turn, process-pool mode)
// - Session resume map (session-resume mode)
// - Stream stall detection
// - Session file scanning (Claude-specific, opt-in via opts)
// - JSONL line parsing + image dedup
// - Error handling with strategy delegation
// - Event queue (push/wait/wake async generator pattern)

import type { RuntimeCapability } from '../types.js';
import type {
  CliAdapterStrategy,
  CliInvokeContext,
  UniversalCliOpts,
  ParsedLineResult,
} from '../cli-strategy.js';

export const templateStrategy: CliAdapterStrategy = {
  // --- Required: identity ---

  id: 'template' as any, // Replace with your RuntimeId (add to types.ts first).
  binaryDefault: 'my-cli', // Default binary name (overridden by opts.binary).
  defaultModel: 'my-model', // Used when params.model is empty.
  capabilities: [
    'streaming_text',
    // Add capabilities your model supports:
    // 'sessions', 'workspace_instructions', 'tools_exec', 'tools_fs', 'tools_web', 'mcp'
  ] satisfies readonly RuntimeCapability[],

  // --- Required: output mode ---

  getOutputMode(_ctx: CliInvokeContext, _opts: UniversalCliOpts): 'text' | 'jsonl' {
    // Return 'text' for plain stdout, 'jsonl' for line-delimited JSON.
    // Can vary per invocation (e.g. Codex switches based on session state).
    return 'text';
  },

  // --- Required: arg building ---

  buildArgs(ctx: CliInvokeContext, _opts: UniversalCliOpts): string[] {
    // Build the CLI argument array. The universal adapter calls:
    //   execa(binary, args, { cwd, timeout, ... })
    //
    // ctx.params contains: model, prompt, cwd, sessionKey, addDirs, tools, images, etc.
    // ctx.useStdin is true when the prompt is too large for a positional arg.
    // ctx.hasImages is true when image content blocks are present.
    // ctx.sessionMap is available for session-resume mode strategies.
    const args = ['--model', ctx.params.model];

    if (!ctx.useStdin) {
      args.push('--', ctx.params.prompt);
    }

    return args;
  },

  // --- Optional: stdin payload ---

  buildStdinPayload(ctx: CliInvokeContext): string | null {
    if (!ctx.useStdin) return null;
    // Return raw text or JSON-formatted stdin payload.
    // The universal adapter writes this to subprocess.stdin and closes it.
    return ctx.params.prompt;
  },

  // --- Optional: JSONL line parsing ---
  // Only needed if getOutputMode returns 'jsonl'.
  // Return null to fall through to the default Claude-compatible parser.

  // parseLine(evt: unknown, ctx: CliInvokeContext): ParsedLineResult | null {
  //   const anyEvt = evt as Record<string, unknown>;
  //   if (anyEvt.type === 'message' && typeof anyEvt.text === 'string') {
  //     return { text: anyEvt.text };
  //   }
  //   return null;
  // },

  // --- Optional: multi-turn mode ---
  // 'process-pool': keeps long-running subprocesses alive (like Claude).
  // 'session-resume': resumes sessions by ID (like Codex).
  // 'none' or omit: one-shot only.

  // multiTurnMode: 'none',

  // --- Optional: error handling ---
  // Return a user-facing message, or null to use default handling.

  // sanitizeError(raw: string, binary: string): string { return raw; },
  // handleSpawnError(err: any, binary: string): string | null { return null; },
  // handleExitError(exitCode: number, stderr: string, stdout: string): string | null { return null; },
};
