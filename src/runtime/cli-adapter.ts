// Universal CLI runtime adapter factory.
// Given a thin strategy (model-specific logic), creates a full RuntimeAdapter
// with all shared infrastructure: subprocess tracking, process pooling,
// stream stall detection, session scanning, JSONL parsing, image support, etc.

import { execa } from 'execa';
import { MAX_IMAGES_PER_INVOCATION, type EngineEvent, type RuntimeAdapter, type RuntimeInvokeParams } from './types.js';
import { SessionFileScanner } from './session-scanner.js';
import { ProcessPool } from './process-pool.js';
import {
  STDIN_THRESHOLD,
  tryParseJsonLine,
  createEventQueue,
  SubprocessTracker,
  cliExecaEnv,
  LineBuffer,
} from './cli-shared.js';
import {
  extractTextFromUnknownEvent,
  extractResultText,
  extractImageFromUnknownEvent,
  extractResultContentBlocks,
  imageDedupeKey,
  stripToolUseBlocks,
} from './cli-output-parsers.js';
import type { CliAdapterStrategy, CliInvokeContext, UniversalCliOpts, ParsedLineResult } from './cli-strategy.js';

// Global subprocess tracker shared across all CLI adapters.
const globalTracker = new SubprocessTracker();

/** SIGKILL all tracked CLI subprocesses across all adapters (e.g. on SIGTERM). */
export function killAllSubprocesses(): void {
  globalTracker.killAll();
}

/**
 * Create a RuntimeAdapter from a strategy + universal options.
 * The strategy provides model-specific arg building, output parsing, and error handling.
 * The universal options control shared features (multi-turn, stall detection, etc.).
 */
export function createCliRuntime(strategy: CliAdapterStrategy, opts: UniversalCliOpts): RuntimeAdapter {
  const binary = opts.binary ?? strategy.binaryDefault;

  const capabilities = new Set(strategy.capabilities);
  if (opts.multiTurn && strategy.multiTurnMode === 'process-pool') {
    (capabilities as Set<string>).add('multi_turn');
  }
  if (!opts.disableSessions) {
    // Sessions are enabled by default for strategies that support them.
    // (strategies without session support simply don't list 'sessions' in capabilities)
  } else {
    capabilities.delete('sessions');
  }

  // Multi-turn process pool (only for process-pool mode).
  let pool: ProcessPool | null = null;
  if (opts.multiTurn && strategy.multiTurnMode === 'process-pool') {
    const logForPool = opts.log && typeof (opts.log as any).info === 'function'
      ? opts.log as { info(...a: unknown[]): void; debug(...a: unknown[]): void }
      : undefined;
    pool = new ProcessPool({
      maxProcesses: opts.multiTurnMaxProcesses ?? 5,
      log: logForPool,
    });
    globalTracker.addPool(pool);
  }

  // Session resume map (for session-resume mode like Codex).
  const sessionMap = (strategy.multiTurnMode === 'session-resume' && !opts.disableSessions)
    ? new Map<string, string>()
    : null;

  async function* invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    const model = params.model || strategy.defaultModel;

    // ---------------------------------------------------------------
    // Multi-turn: process pool path (Claude-style)
    // ---------------------------------------------------------------
    if (pool && params.sessionKey) {
      try {
        const proc = pool.getOrSpawn(params.sessionKey, {
          claudeBin: binary,
          model,
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
          const sub = proc.getSubprocess();
          if (sub) globalTracker.add(sub);

          // Abort the pool turn if the caller's signal fires.
          if (params.signal?.aborted) {
            pool.remove(params.sessionKey);
            if (sub) globalTracker.delete(sub);
            yield { type: 'error', message: 'aborted' };
            yield { type: 'done' };
            return;
          }
          const onPoolAbort = () => { proc.kill?.(); };
          params.signal?.addEventListener('abort', onPoolAbort, { once: true });

          let fallback = false;
          try {
            for await (const evt of proc.sendTurn(params.prompt, params.images)) {
              if (evt.type === 'error' && (evt.message.startsWith('long-running:') || evt.message.includes('hang detected'))) {
                pool.remove(params.sessionKey);
                fallback = true;
                break;
              }
              yield evt;
            }
          } finally {
            params.signal?.removeEventListener('abort', onPoolAbort);
          }

          if (sub) globalTracker.delete(sub);
          if (!fallback) return;
          (opts.log as any)?.info?.('multi-turn: process failed, falling back to one-shot');
        }
      } catch (err) {
        (opts.log as any)?.info?.({ err }, 'multi-turn: error, falling back to one-shot');
      }
    }

    // ---------------------------------------------------------------
    // One-shot path
    // ---------------------------------------------------------------
    if (params.signal?.aborted) {
      yield { type: 'error', message: 'aborted' };
      yield { type: 'done' };
      return;
    }

    const hasImages = Boolean(params.images && params.images.length > 0);
    const promptTooLarge = Buffer.byteLength(params.prompt, 'utf-8') > STDIN_THRESHOLD;
    const useStdin = hasImages || promptTooLarge;

    const ctx: CliInvokeContext = { params: { ...params, model }, useStdin, hasImages, sessionMap: sessionMap ?? undefined };
    const args = strategy.buildArgs(ctx, opts);

    const outputMode = strategy.getOutputMode(ctx, opts);

    if (opts.log) {
      opts.log.debug({ args: args.slice(0, -1), hasImages, promptTooLarge, useStdin }, `${strategy.id}: constructed args`);
    }

    const subprocess = execa(binary, args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      reject: false,
      forceKillAfterDelay: 5000,
      stdin: useStdin ? 'pipe' : 'ignore',
      env: cliExecaEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Write stdin payload if needed.
    if (useStdin && subprocess.stdin) {
      const payload = strategy.buildStdinPayload?.(ctx);
      if (payload) {
        try {
          subprocess.stdin.write(payload);
          subprocess.stdin.end();
        } catch {
          // stdin write failed — process will exit with error.
        }
      }
    }

    globalTracker.add(subprocess);
    subprocess.then(() => globalTracker.delete(subprocess))
      .catch(() => globalTracker.delete(subprocess));

    // Wire caller's AbortSignal to kill the subprocess.
    const onAbort = () => {
      subprocess.kill('SIGKILL');
      if (!finished) {
        push({ type: 'error', message: 'aborted' });
        push({ type: 'done' });
        finished = true;
        wake();
      }
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    if (!subprocess.stdout) {
      yield { type: 'error', message: `${strategy.id}: missing stdout stream` };
      yield { type: 'done' };
      return;
    }

    const { q, push, wait, wake } = createEventQueue();

    // --- Stream stall detection ---
    let finished = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStallTimer = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    const resetStallTimer = () => {
      if (!opts.streamStallTimeoutMs) return;
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

    // --- Progress stall detection (thinking spiral guard) ---
    // Unlike stallTimer which resets on any raw data chunk, progressTimer
    // resets only when a text_delta event is pushed — catching scenarios
    // where thinking tokens flow through stdout but no useful content appears.
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let progressResetCount = 0;
    const clearProgressTimer = () => { if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; } };
    const resetProgressTimer = () => {
      if (!opts.progressStallTimeoutMs) return;
      clearProgressTimer();
      progressResetCount++;
      if (progressResetCount === 1) {
        opts.log?.debug?.(`progress-timer: armed (${opts.progressStallTimeoutMs}ms)`);
      }
      progressTimer = setTimeout(() => {
        if (finished) return;
        const ms = opts.progressStallTimeoutMs!;
        opts.log?.info?.(`one-shot: progress stall detected (no text_delta for ${ms}ms, resets=${progressResetCount}), killing process`);
        push({ type: 'error', message: `progress stall: no text output for ${ms}ms (possible thinking spiral)` });
        push({ type: 'done' });
        finished = true;
        subprocess.kill('SIGTERM');
        wake();
      }, opts.progressStallTimeoutMs);
    };
    resetProgressTimer();

    // --- Session file scanner (Claude-specific, but controlled by opts) ---
    let scanner: SessionFileScanner | null = null;
    if (opts.sessionScanning && params.sessionId) {
      scanner = new SessionFileScanner(
        { sessionId: params.sessionId, cwd: params.cwd, log: opts.log },
        { onEvent: push },
      );
      scanner.start().catch((err) => opts.log?.debug({ err }, 'session-scanner: start failed'));
    }

    // --- State variables ---
    let mergedStdout = '';
    let merged = '';
    let resultText = '';
    let inToolUse = false;
    const stdoutLineBuf = new LineBuffer();
    let stderrBuffered = '';
    let stderrForError = '';
    let stdoutEnded = false;
    let stderrEnded = subprocess.stderr == null;
    let procResult: any | null = null;
    const seenImages = new Set<string>();
    let imageCount = 0;

    // --- Stdout handler ---
    subprocess.stdout.on('data', (chunk) => {
      resetStallTimer();
      const s = String(chunk);
      mergedStdout += s;

      if (outputMode === 'text') {
        push({ type: 'text_delta', text: s });
        resetProgressTimer();
        return;
      }

      // JSONL mode: parse line-delimited events.
      const lines = stdoutLineBuf.feed(s);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (opts.echoStdio) {
          push({ type: 'log_line', stream: 'stdout', line: trimmed });
        }

        const evt = tryParseJsonLine(trimmed);

        // Delegate to strategy parser first.
        if (strategy.parseLine && evt) {
          const parsed = strategy.parseLine(evt, ctx);
          if (parsed) {
            // Emit extra events (e.g. session mapping).
            if (parsed.extraEvents) {
              for (const e of parsed.extraEvents) push(e);
            }

            // Handle text.
            if (parsed.text) {
              merged += parsed.text;
              if (parsed.inToolUse !== undefined) {
                if (parsed.inToolUse) inToolUse = true;
              }
              if (!inToolUse) {
                push({ type: 'text_delta', text: parsed.text });
                resetProgressTimer();
              }
              if (parsed.inToolUse === false) inToolUse = false;
            } else if (parsed.activity) {
              // Non-text activity (e.g. tool input generation) — reset the
              // progress stall timer so legitimate work isn't killed.
              resetProgressTimer();
            }

            // Handle result text.
            if (parsed.resultText) resultText = parsed.resultText;

            // Handle images.
            if (parsed.image && imageCount < MAX_IMAGES_PER_INVOCATION) {
              const key = imageDedupeKey(parsed.image);
              if (!seenImages.has(key)) {
                seenImages.add(key);
                imageCount++;
                push({ type: 'image_data', image: parsed.image });
              }
            }
            if (parsed.resultImages) {
              for (const img of parsed.resultImages) {
                if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
                const key = imageDedupeKey(img);
                if (!seenImages.has(key)) {
                  seenImages.add(key);
                  imageCount++;
                  push({ type: 'image_data', image: img });
                }
              }
            }

            continue; // Strategy handled this line.
          }
        }

        // Default JSONL parsing (Claude-compatible fallback).
        const text = extractTextFromUnknownEvent(evt ?? trimmed);
        if (text) {
          merged += text;
          const hasToolOpen = text.includes('<tool_use>') || text.includes('<tool_calls>') || text.includes('<tool_call>') || text.includes('<tool_results>') || text.includes('<tool_result>');
          const hasToolClose = text.includes('</tool_use>') || text.includes('</tool_calls>') || text.includes('</tool_call>') || text.includes('</tool_results>') || text.includes('</tool_result>');
          if (hasToolOpen) inToolUse = true;
          if (!inToolUse) {
            push({ type: 'text_delta', text });
            resetProgressTimer();
          }
          if (hasToolClose) inToolUse = false;
        } else if (evt) {
          const rt = extractResultText(evt);
          if (rt) resultText = rt;

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

    // --- Stderr handler ---
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

    // --- Stream end handlers ---
    subprocess.stdout.on('end', () => {
      stdoutEnded = true;
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
      clearProgressTimer();

      const exitCode = procResult.exitCode;
      const stdout = procResult.stdout ?? '';
      const stderr = procResult.stderr ?? '';

      if (params.signal?.aborted) {
        push({ type: 'error', message: 'aborted' });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (procResult.timedOut) {
        // Use a fixed message — execa's originalMessage/shortMessage can contain the
        // full command line (including prompt text), so we never expose raw error strings.
        push({
          type: 'error',
          message: `${strategy.id === 'claude_code' ? 'claude' : strategy.id} timed out after ${params.timeoutMs ?? 0}ms`,
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Spawn failure (no exit code).
      if (procResult.failed && exitCode == null) {
        const spawnMsg = strategy.handleSpawnError?.(procResult, binary);
        if (spawnMsg) {
          push({ type: 'error', message: spawnMsg });
        } else {
          const msg = (procResult.shortMessage || procResult.originalMessage || procResult.message || '').trim();
          push({ type: 'error', message: msg || `${strategy.id} failed (no exit code)` });
        }
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

      // Flush trailing stdout buffer.
      if (outputMode === 'jsonl') {
        const tail = stdoutLineBuf.flush().trim();
        if (tail) {
          const evt = tryParseJsonLine(tail);

          // Let strategy parse trailing line.
          if (strategy.parseLine && evt) {
            const parsed = strategy.parseLine(evt, ctx);
            if (parsed) {
              if (parsed.text) {
                merged += parsed.text;
                push({ type: 'text_delta', text: parsed.text });
              }
              if (parsed.resultText) resultText = parsed.resultText;
              if (parsed.image && imageCount < MAX_IMAGES_PER_INVOCATION) {
                const key = imageDedupeKey(parsed.image);
                if (!seenImages.has(key)) {
                  seenImages.add(key);
                  imageCount++;
                  push({ type: 'image_data', image: parsed.image });
                }
              }
            }
          } else {
            // Default trailing buffer parsing.
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
      }

      // Non-zero exit.
      if (exitCode !== 0) {
        // Clear stale session on error (session-resume mode).
        if (sessionMap && params.sessionKey) sessionMap.delete(params.sessionKey);

        const exitMsg = strategy.handleExitError?.(exitCode, stderrForError || stderr, stdout);
        if (exitMsg) {
          push({ type: 'error', message: exitMsg });
        } else {
          const raw = (stderrForError || stderr || stdout || `${strategy.id} exit ${exitCode}`).trim();
          const sanitized = strategy.sanitizeError?.(raw, binary) ?? raw;
          push({ type: 'error', message: sanitized });
        }
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Success.
      if (outputMode === 'text') {
        const final = (stdout || mergedStdout).trimEnd();
        if (final) push({ type: 'text_final', text: final });
      } else {
        const raw = resultText.trim() || (merged.trim() ? merged.trimEnd() : '');
        const final = stripToolUseBlocks(raw);
        if (final) push({ type: 'text_final', text: final });
      }

      push({ type: 'done' });
      finished = true;
      wake();
    }

    // --- Process completion ---
    subprocess.then((result) => {
      procResult = result;
      tryFinalize();
    }).catch((err: any) => {
      clearStallTimer();
      if (finished) return;

      // Check timeout first — use fixed message to avoid leaking prompt/command line.
      if (err?.timedOut) {
        push({
          type: 'error',
          message: `${strategy.id === 'claude_code' ? 'claude' : strategy.id} timed out after ${params.timeoutMs ?? 0}ms`,
        });
      } else {
        const spawnMsg = strategy.handleSpawnError?.(err, binary);
        if (spawnMsg) {
          push({ type: 'error', message: spawnMsg });
        } else {
          const msg = String(
            (err?.originalMessage || err?.shortMessage || err?.message || err || '')
          ).trim();
          push({
            type: 'error',
            message: msg || `${strategy.id} failed`,
          });
        }
      }
      push({ type: 'done' });
      finished = true;
      wake();
    });

    // --- Yield events ---
    try {
      while (!finished || q.length > 0) {
        if (q.length === 0) await wait();
        while (q.length > 0) {
          yield q.shift()!;
        }
      }
    } finally {
      clearStallTimer();
      clearProgressTimer();
      scanner?.stop();
      params.signal?.removeEventListener('abort', onAbort);
      if (!finished) subprocess.kill('SIGKILL');
      globalTracker.delete(subprocess);
    }
  }

  return {
    id: strategy.id,
    capabilities,
    defaultModel: strategy.defaultModel,
    invoke,
  };
}
