import { execa, type ResultPromise } from 'execa';
import { MAX_IMAGES_PER_INVOCATION, type EngineEvent, type ImageData, type RuntimeAdapter, type RuntimeInvokeParams } from './types.js';
import { SessionFileScanner } from './session-scanner.js';
import { ProcessPool } from './process-pool.js';
import {
  STDIN_THRESHOLD,
  tryParseJsonLine as _tryParseJsonLine,
  createEventQueue,
  SubprocessTracker,
  cliExecaEnv,
  LineBuffer,
} from './cli-shared.js';
import {
  extractTextFromUnknownEvent as _extractTextFromUnknownEvent,
  extractResultText as _extractResultText,
  extractImageFromUnknownEvent as _extractImageFromUnknownEvent,
  extractResultContentBlocks as _extractResultContentBlocks,
  imageDedupeKey as _imageDedupeKey,
  stripToolUseBlocks as _stripToolUseBlocks,
} from './cli-output-parsers.js';

// Re-export output parsers for backward compatibility (tests import from here).
export const extractTextFromUnknownEvent = _extractTextFromUnknownEvent;
export const extractResultText = _extractResultText;
export const extractImageFromUnknownEvent = _extractImageFromUnknownEvent;
export const extractResultContentBlocks = _extractResultContentBlocks;
export const imageDedupeKey = _imageDedupeKey;
export const stripToolUseBlocks = _stripToolUseBlocks;
export const tryParseJsonLine = _tryParseJsonLine;

// Re-export for backward compatibility (now defined in types.ts).
export { MAX_IMAGES_PER_INVOCATION } from './types.js';

// Shared subprocess tracker for Claude processes.
const tracker = new SubprocessTracker();

/** SIGKILL all tracked Claude subprocesses (e.g. on SIGTERM). */
export function killActiveSubprocesses(): void {
  tracker.killAll();
}

export type ClaudeCliRuntimeOpts = {
  claudeBin: string;
  dangerouslySkipPermissions: boolean;
  outputFormat: 'text' | 'stream-json';
  // Echo raw CLI output for debugging / "terminal-like" Discord output.
  echoStdio?: boolean;
  // If true, pass `--verbose` to Claude CLI for increased output detail.
  // Automatically disabled when outputFormat='text' to prevent metadata leaking into responses.
  verbose?: boolean;
  // If set, pass `--debug-file` to Claude CLI. Keep local; may contain sensitive info.
  debugFile?: string | null;
  // If true, pass `--strict-mcp-config` to skip slow MCP plugin init in headless contexts.
  strictMcpConfig?: boolean;
  // Auto-fallback model when primary is overloaded.
  fallbackModel?: string;
  // Max USD spend per CLI process.
  maxBudgetUsd?: number;
  // Append to Claude's system prompt.
  appendSystemPrompt?: string;
  // Optional logger for pre-invocation debug output.
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
  // If true, scan Claude Code's JSONL session file to emit tool_start/tool_end events.
  sessionScanning?: boolean;
  // Multi-turn: keep long-running Claude Code processes alive per session key.
  multiTurn?: boolean;
  multiTurnHangTimeoutMs?: number;
  multiTurnIdleTimeoutMs?: number;
  multiTurnMaxProcesses?: number;
  // One-shot: kill process if no stdout/stderr for this long (ms). 0 = disabled.
  streamStallTimeoutMs?: number;
};

export function createClaudeCliRuntime(opts: ClaudeCliRuntimeOpts): RuntimeAdapter {
  const capabilities = new Set([
    'streaming_text',
    'sessions',
    'workspace_instructions',
    'tools_exec',
    'tools_fs',
    'tools_web',
    'mcp',
  ] as const);
  if (opts.multiTurn) (capabilities as Set<string>).add('multi_turn');

  // Multi-turn process pool (only created when feature is enabled).
  let pool: ProcessPool | null = null;
  if (opts.multiTurn) {
    const logForPool = opts.log && typeof (opts.log as any).info === 'function'
      ? opts.log as { info(...a: unknown[]): void; debug(...a: unknown[]): void }
      : undefined;
    pool = new ProcessPool({
      maxProcesses: opts.multiTurnMaxProcesses ?? 5,
      log: logForPool,
    });
    tracker.addPool(pool);
  }

  async function* invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    // Multi-turn path: try the long-running process first.
    if (pool && params.sessionKey) {
      try {
        const proc = pool.getOrSpawn(params.sessionKey, {
          claudeBin: opts.claudeBin,
          model: params.model,
          cwd: params.cwd,
          dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
          strictMcpConfig: opts.strictMcpConfig,
          fallbackModel: opts.fallbackModel,
          maxBudgetUsd: opts.maxBudgetUsd,
          appendSystemPrompt: opts.appendSystemPrompt,
          verbose: opts.verbose,
          tools: params.tools,
          addDirs: params.addDirs,
          hangTimeoutMs: opts.multiTurnHangTimeoutMs,
          idleTimeoutMs: opts.multiTurnIdleTimeoutMs,
          log: pool && opts.log && typeof (opts.log as any).info === 'function'
            ? opts.log as { info(...a: unknown[]): void; debug(...a: unknown[]): void }
            : undefined,
        });
        if (proc?.isAlive) {
          // Track the subprocess for shutdown cleanup.
          const sub = proc.getSubprocess();
          if (sub) tracker.add(sub);

          let fallback = false;
          for await (const evt of proc.sendTurn(params.prompt, params.images)) {
            if (evt.type === 'error' && (evt.message.startsWith('long-running:') || evt.message.includes('hang detected'))) {
              // Process crashed/hung — suppress error, fall back to one-shot.
              pool.remove(params.sessionKey);
              fallback = true;
              break;
            }
            yield evt;
          }

          if (sub) tracker.delete(sub);
          if (!fallback) return; // success via long-running process
          (opts.log as any)?.info?.('multi-turn: process failed, falling back to one-shot');
          // Fall through to one-shot...
        }
      } catch (err) {
        (opts.log as any)?.info?.({ err }, 'multi-turn: error, falling back to one-shot');
      }
    }

    // One-shot path (existing behavior, unchanged).
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

    // Use stdin-based input when images are present OR when the prompt is too
    // large for a CLI positional argument (Linux E2BIG limit ~128 KB).
    const hasImages = params.images && params.images.length > 0;
    const promptTooLarge = Buffer.byteLength(params.prompt, 'utf-8') > STDIN_THRESHOLD;
    const useStdin = hasImages || promptTooLarge;
    // Images require stream-json for content block parsing; compute once before arg construction.
    const effectiveOutputFormat = useStdin ? 'stream-json' as const : opts.outputFormat;

    if (useStdin) {
      args.push('--input-format', 'stream-json');
    }

    if (effectiveOutputFormat) {
      args.push('--output-format', effectiveOutputFormat);
    }

    if (effectiveOutputFormat === 'stream-json') {
      args.push('--include-partial-messages');
    }

    // Tool flags are runtime-specific; keep optional and configurable.
    // Note: treat an explicit empty list as "disable all tools" (claude expects --tools "").
    if (params.tools) {
      if (params.tools.length > 0) {
        args.push('--tools', params.tools.join(','));
      } else {
        // Use `=` syntax so the empty value stays in one argv element,
        // preventing commander's variadic parser from consuming the prompt.
        args.push('--tools=');
      }
    }

    if (opts.log) {
      // Log args without the prompt to avoid leaking user content at debug level.
      opts.log.debug({ args, hasImages: Boolean(hasImages), promptTooLarge, useStdin }, 'claude-cli: constructed args');
    }

    // When using stdin, prompt is sent via pipe; otherwise as positional arg.
    if (!useStdin) {
      // POSIX `--` terminates option parsing, preventing variadic flags
      // (--tools, --add-dir) from consuming the positional prompt.
      args.push('--', params.prompt);
    }

    const subprocess = execa(opts.claudeBin, args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      reject: false,
      forceKillAfterDelay: 5000,
      // When using stdin (images or large prompts) we pipe; otherwise ignore to prevent auth hangs.
      stdin: useStdin ? 'pipe' : 'ignore',
      env: cliExecaEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // When using stdin, write the prompt (+ optional images) as NDJSON, then close.
    if (useStdin && subprocess.stdin) {
      try {
        const content: Array<Record<string, unknown>> = [
          { type: 'text', text: params.prompt },
        ];
        if (hasImages) {
          for (const img of params.images!) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
            });
          }
        }
        const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
        subprocess.stdin.write(stdinMsg);
        subprocess.stdin.end();
      } catch {
        // stdin write failed — process will run without input and exit with error.
        // The existing error/exit handling below will surface a message.
      }
    }

    tracker.add(subprocess);
    subprocess.then(() => tracker.delete(subprocess))
      .catch(() => tracker.delete(subprocess));

    if (!subprocess.stdout) {
      yield { type: 'error', message: 'claude: missing stdout stream' };
      yield { type: 'done' };
      return;
    }

    // Emit stdout/stderr as they arrive via a small async queue so we can
    // yield events from both streams without risking pipe backpressure deadlocks.
    const { q, push, wait, wake } = createEventQueue();

    // One-shot stream stall detection: kill process if no stdout/stderr for too long.
    let finished = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStallTimer = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    const resetStallTimer = () => {
      if (!opts.streamStallTimeoutMs) return;  // 0 or undefined = disabled
      clearStallTimer();
      stallTimer = setTimeout(() => {
        const ms = opts.streamStallTimeoutMs!;
        opts.log?.info?.(`one-shot: stream stall detected, killing process`);
        push({ type: 'error', message: `stream stall: no output for ${ms}ms` });
        push({ type: 'done' });
        finished = true;
        subprocess.kill('SIGTERM');
        wake();
      }, opts.streamStallTimeoutMs);
    };
    resetStallTimer();

    // Session file scanner: emit tool_start/tool_end from JSONL session log.
    let scanner: SessionFileScanner | null = null;
    if (opts.sessionScanning && params.sessionId) {
      scanner = new SessionFileScanner(
        { sessionId: params.sessionId, cwd: params.cwd, log: opts.log },
        { onEvent: push },
      );
      // Fire-and-forget: scanner degrades gracefully if file never appears.
      scanner.start().catch((err) => opts.log?.debug({ err }, 'session-scanner: start failed'));
    }

    let mergedStdout = '';
    let merged = '';
    let resultText = '';  // fallback from "result" event if no deltas were extracted
    let inToolUse = false;  // track whether we're inside a <tool_use> block
    const stdoutLineBuf = new LineBuffer();
    let stderrBuffered = '';
    let stderrForError = '';
    let stdoutEnded = false;
    let stderrEnded = subprocess.stderr == null;
    let procResult: any | null = null;
    const seenImages = new Set<string>();
    let imageCount = 0;

    subprocess.stdout.on('data', (chunk) => {
      resetStallTimer();
      const s = String(chunk);
      mergedStdout += s;
      if (effectiveOutputFormat === 'text') {
        push({ type: 'text_delta', text: s });
        return;
      }

      // stream-json: parse line-delimited JSON events.
      const lines = stdoutLineBuf.feed(s);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (opts.echoStdio) {
          // Echo raw stream-json lines so Discord can show "what the terminal shows"
          // even when no text fields are emitted yet.
          push({ type: 'log_line', stream: 'stdout', line: trimmed });
        }
        const evt = tryParseJsonLine(trimmed);
        const text = extractTextFromUnknownEvent(evt ?? trimmed);
        if (text) {
          merged += text;
          // Suppress tool-call blocks from streaming deltas.
          const hasToolOpen = text.includes('<tool_use>') || text.includes('<tool_calls>') || text.includes('<tool_call>') || text.includes('<tool_results>') || text.includes('<tool_result>');
          const hasToolClose = text.includes('</tool_use>') || text.includes('</tool_calls>') || text.includes('</tool_call>') || text.includes('</tool_results>') || text.includes('</tool_result>');
          if (hasToolOpen) inToolUse = true;
          if (!inToolUse) push({ type: 'text_delta', text });
          if (hasToolClose) inToolUse = false;
        } else if (evt) {
          // Capture result text as fallback (don't merge — avoids double-counting with deltas).
          const rt = extractResultText(evt);
          if (rt) resultText = rt;

          // Check for result events with content block arrays (text + images).
          const blocks = extractResultContentBlocks(evt);
          if (blocks) {
            if (blocks.text) resultText = blocks.text;
            for (const img of blocks.images) {
              if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
              const key = imageDedupeKey(img);
              if (!seenImages.has(key)) {
                seenImages.add(key);
                imageCount++;
                push({ type: 'image_data', image: img });
              }
            }
          }

          // Try extracting a single image from streaming content blocks.
          const img = extractImageFromUnknownEvent(evt);
          if (img && imageCount < MAX_IMAGES_PER_INVOCATION) {
            const key = imageDedupeKey(img);
            if (!seenImages.has(key)) {
              seenImages.add(key);
              imageCount++;
              push({ type: 'image_data', image: img });
            }
          }
        }
      }
    });

    subprocess.stderr?.on('data', (chunk) => {
      resetStallTimer();
      const s = String(chunk);
      stderrForError += s;
      if (!opts.echoStdio) return;
      stderrBuffered += s;
      const lines = stderrBuffered.split(/\r?\n/);
      stderrBuffered = lines.pop() ?? '';
      for (const line of lines) {
        push({ type: 'log_line', stream: 'stderr', line });
      }
    });

    subprocess.stdout.on('end', () => {
      stdoutEnded = true;
      // If the process resolved before the streams flushed (mocked tests, edge cases),
      // finalize once we know stdout is done.
      tryFinalize();
    });
    subprocess.stderr?.on('end', () => {
      stderrEnded = true;
      tryFinalize();
    });

    function tryFinalize() {
      if (finished) return;
      if (!procResult) return;
      if (!stdoutEnded) return;
      if (!stderrEnded) return;
      clearStallTimer();

      const exitCode = procResult.exitCode;
      const stdout = procResult.stdout ?? '';
      const stderr = procResult.stderr ?? '';

      if (procResult.timedOut) {
        const msg = (procResult.originalMessage || procResult.shortMessage || procResult.message || '').trim();
        push({
          type: 'error',
          message: `claude timed out after ${params.timeoutMs ?? 0}ms${msg ? `: ${msg}` : ''}`,
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (procResult.failed && exitCode == null) {
        const msg = (procResult.shortMessage || procResult.originalMessage || procResult.message || '').trim();
        push({
          type: 'error',
          message: msg || 'claude failed (no exit code)',
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Flush trailing stderr.
      const stderrTail = stderrBuffered.trimEnd();
      if (opts.echoStdio && stderrTail) {
        push({ type: 'log_line', stream: 'stderr', line: stderrTail });
      }

      if (effectiveOutputFormat === 'stream-json') {
        // Flush trailing stdout.
        const tail = stdoutLineBuf.flush().trim();
        if (tail) {
          const evt = tryParseJsonLine(tail);
          const text = extractTextFromUnknownEvent(evt ?? tail);
          if (text) {
            merged += text;
            push({ type: 'text_delta', text });
          }
          if (evt) {
            const img = extractImageFromUnknownEvent(evt);
            if (img && imageCount < MAX_IMAGES_PER_INVOCATION) {
              const key = imageDedupeKey(img);
              if (!seenImages.has(key)) {
                seenImages.add(key);
                imageCount++;
                push({ type: 'image_data', image: img });
              }
            }
          }
        }
      }

      if (exitCode !== 0) {
        const msg = (stderrForError || stderr || stdout || `claude exit ${exitCode}`).trim();
        push({ type: 'error', message: msg });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (effectiveOutputFormat === 'text') {
        const final = (stdout || mergedStdout).trimEnd();
        if (final) push({ type: 'text_final', text: final });
      } else {
        // Prefer clean result text; fall back to accumulated deltas.
        const raw = resultText.trim() || (merged.trim() ? merged.trimEnd() : '');
        // Strip tool_use XML blocks that leak into text content.
        const final = stripToolUseBlocks(raw);
        if (final) push({ type: 'text_final', text: final });
      }

      push({ type: 'done' });
      finished = true;
      wake();
    }

    // When the process completes, wait for streams to end too, then finalize.
    // Important: keep the full execa result so we preserve fields like `timedOut`
    // and `failed` (otherwise we end up with "claude exit undefined").
    subprocess.then((result) => {
      procResult = result;
      tryFinalize();
    }).catch((err: any) => {
      clearStallTimer();
      if (finished) return;
      // Timeouts/spawn errors reject the promise (even with `reject: false`).
      // Surface a stable message and include execa's short/original message when present.
      const timedOut = Boolean(err?.timedOut);
      const msg = String(
        (err?.originalMessage || err?.shortMessage || err?.message || err || '')
      ).trim();
      push({
        type: 'error',
        message: timedOut
          ? `claude timed out after ${params.timeoutMs ?? 0}ms${msg ? `: ${msg}` : ''}`
          : (msg || 'claude failed'),
      });
      push({ type: 'done' });
      finished = true;
      wake();
    });

    try {
      while (!finished || q.length > 0) {
        if (q.length === 0) await wait();
        while (q.length > 0) {
          yield q.shift()!;
        }
      }
    } finally {
      clearStallTimer();
      scanner?.stop();
      if (!finished) subprocess.kill('SIGKILL');
      tracker.delete(subprocess);
    }
  }

  return {
    id: 'claude_code',
    capabilities,
    invoke,
  };
}
