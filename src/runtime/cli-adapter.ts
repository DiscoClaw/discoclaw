// Universal CLI runtime adapter factory.
// Given a thin strategy (model-specific logic), creates a full RuntimeAdapter
// with all shared infrastructure: subprocess tracking, process pooling,
// stream stall detection, session scanning, JSONL parsing, image support, etc.

import fs from 'node:fs';
import path from 'node:path';
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

const CONTEXT_OVERFLOW_PHRASES = [
  'prompt is too long',
  'context length exceeded',
  'context_length_exceeded',
  'context overflow',
];

function isContextOverflowMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_PHRASES.some((phrase) => lower.includes(phrase));
}

type CliLogLike = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

function asCliLogLike(log: UniversalCliOpts['log']): CliLogLike | undefined {
  if (!log || typeof log !== 'object') return undefined;
  return log as CliLogLike;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return defaultValue;
}

const CODEX_LAUNCHER_STATE_ERROR_PATTERN = /state db (missing|returned stale) rollout path|rollout path missing/i;

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
  const cliLog = asCliLogLike(opts.log);
  if (opts.multiTurn && strategy.multiTurnMode === 'process-pool') {
    const logForPool = cliLog && typeof cliLog.info === 'function'
      ? cliLog as { info(...a: unknown[]): void; debug(...a: unknown[]): void }
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
        const poolCtx: CliInvokeContext = {
          params: { ...params, model },
          useStdin: true,
          hasImages: Boolean(params.images && params.images.length > 0),
        };
        const strategyEnvOverrides = strategy.buildEnv?.(poolCtx, opts);
        const proc = pool.getOrSpawn(params.sessionKey, {
          claudeBin: binary,
          model,
          cwd: params.cwd,
          envOverrides: strategyEnvOverrides,
          dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
          strictMcpConfig: opts.strictMcpConfig,
          fallbackModel: opts.fallbackModel,
          maxBudgetUsd: opts.maxBudgetUsd,
          appendSystemPrompt: opts.appendSystemPrompt,
          verbose: opts.verbose,
          sessionScanning: opts.sessionScanning,
          tools: params.tools,
          addDirs: params.addDirs,
          hangTimeoutMs: opts.multiTurnHangTimeoutMs,
          idleTimeoutMs: opts.multiTurnIdleTimeoutMs,
          log: pool && cliLog && typeof cliLog.info === 'function'
            ? cliLog as { info(...a: unknown[]): void; debug(...a: unknown[]): void }
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
          let contextOverflow = false;
          try {
            for await (const evt of proc.sendTurn(params.prompt, params.images, params.onTelemetry)) {
              if (evt.type === 'error' && (evt.message.startsWith('long-running:') || evt.message.includes('hang detected'))) {
                if (evt.message.includes('context overflow')) contextOverflow = true;
                pool.remove(params.sessionKey, contextOverflow ? 'context-overflow' : undefined);
                fallback = true;
                break;
              }
              if ((evt.type === 'text_delta' || evt.type === 'text_final') && isContextOverflowMessage(evt.text)) {
                pool.remove(params.sessionKey, 'context-overflow');
                contextOverflow = true;
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
          if (contextOverflow) {
            cliLog?.info?.({ sessionKey: params.sessionKey }, 'multi-turn: context overflow, resetting session and retrying');
            yield { type: 'text_delta', text: '*(Session reset — conversation context limit reached. Starting fresh.)*\n\n' };
          }
          cliLog?.info?.('multi-turn: process failed, falling back to one-shot');
        }
      } catch (err) {
        cliLog?.info?.({ err }, 'multi-turn: error, falling back to one-shot');
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

    // Write images to temp files if the strategy requires file-based delivery.
    let tempImagePaths: string[] | undefined;
    let imageCleanup: (() => Promise<void>) | undefined;
    if (hasImages && params.images && strategy.prepareImages) {
      const prepared = await strategy.prepareImages(params.images, opts.log);
      tempImagePaths = prepared.paths;
      imageCleanup = prepared.cleanup;
    }

    const promptTooLarge = Buffer.byteLength(params.prompt, 'utf-8') > STDIN_THRESHOLD;
    const useStdin = hasImages || promptTooLarge;
    const launcherStateHardeningEnabled = parseBooleanEnv(
      process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING,
      true,
    );
    const codexStableHome = (process.env.DISCOCLAW_CODEX_STABLE_HOME ?? '').trim();
    let launcherStateRetryUsed = false;
    let sessionResetNoticeEmitted = false;

    const { q, push, wait, wake } = createEventQueue();
    let finished = false;
    let activeSubprocess: { kill(signal?: NodeJS.Signals | number, error?: Error): boolean } | null = null;

    type AttemptResult =
      | { kind: 'complete' }
      | { kind: 'retry'; envOverrides: Record<string, string | undefined> };

    const maybeBuildLauncherStateRetryEnv = (
      rawError: string,
      emittedUserOutput: boolean,
    ): Record<string, string | undefined> | null => {
      if (!launcherStateHardeningEnabled || launcherStateRetryUsed || emittedUserOutput) return null;
      const trimmed = rawError.trim();
      if (!trimmed) return null;

      switch (strategy.id) {
        case 'gemini':
          // Explicit no-op: Gemini CLI is stateless for session persistence in this adapter.
          return null;
        case 'codex':
          if (!CODEX_LAUNCHER_STATE_ERROR_PATTERN.test(trimmed)) return null;
          break;
        default:
          // Explicit no-op for providers without a configured launcher-state home override.
          return null;
      }

      const stableHome = codexStableHome
        ? path.resolve(codexStableHome)
        : path.resolve(process.cwd(), '.codex-home-discoclaw');
      try {
        fs.mkdirSync(stableHome, { recursive: true });
      } catch (err) {
        opts.log?.info?.({ err, stableHome }, 'launcher-state: failed to prepare stable home; skipping retry');
        return null;
      }

      launcherStateRetryUsed = true;
      opts.log?.info?.(
        {
          provider: strategy.id,
          stableHome,
          previousHome: process.env.CODEX_HOME,
        },
        'launcher-state: detected stale/missing local state path; retrying once with stable home',
      );
      return { CODEX_HOME: stableHome };
    };

    const runOneShotAttempt = async (
      attempt: number,
      envOverrides?: Record<string, string | undefined>,
    ): Promise<AttemptResult> => new Promise<AttemptResult>((resolveAttempt) => {
      const ctx: CliInvokeContext = {
        params: { ...params, model },
        useStdin,
        hasImages,
        sessionMap: sessionMap ?? undefined,
        tempImagePaths,
      };
      const args = strategy.buildArgs(ctx, opts);
      const outputMode = strategy.getOutputMode(ctx, opts);
      const strategyEnvOverrides = strategy.buildEnv?.(ctx, opts);
      if (ctx.sessionResetReason && !sessionResetNoticeEmitted) {
        push({ type: 'text_delta', text: `*(Session reset — ${ctx.sessionResetReason})*\n\n` });
        sessionResetNoticeEmitted = true;
      }
      if (opts.log) {
        opts.log.debug({ args: args.slice(0, -1), hasImages, promptTooLarge, useStdin }, `${strategy.id}: constructed args`);
      }

      const subprocess = execa(binary, args, {
        cwd: params.cwd,
        timeout: params.timeoutMs,
        reject: false,
        forceKillAfterDelay: 5000,
        stdin: useStdin ? 'pipe' : 'ignore',
        env: cliExecaEnv({
          ...(strategyEnvOverrides ?? {}),
          ...(envOverrides ?? {}),
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const spawnedAtMs = Date.now();
      activeSubprocess = subprocess;
      const attemptLogBase = {
        strategyId: strategy.id,
        attempt,
        pid: subprocess.pid ?? null,
      };
      opts.log?.info?.(
        {
          ...attemptLogBase,
          spawnedAtMs,
          outputMode,
          useStdin,
        },
        'one-shot: subprocess spawned',
      );

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

      if (!subprocess.stdout) {
        push({ type: 'error', message: `${strategy.id}: missing stdout stream` });
        push({ type: 'done' });
        finished = true;
        wake();
        resolveAttempt({ kind: 'complete' });
        return;
      }

      let attemptSettled = false;
      let scanner: SessionFileScanner | null = null;
      let emittedUserOutput = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      let firstStdoutByteAtMs: number | null = null;
      let firstStderrByteAtMs: number | null = null;
      let firstParsedEventAtMs: number | null = null;
      let firstParsedEventType: EngineEvent['type'] | null = null;
      let firstParsedEventSource: 'session_scanner' | 'strategy_parser' | 'default_parser' | null = null;
      let timingSummaryLogged = false;
      const toSpawnDelta = (ts: number | null): number | null => (ts == null ? null : ts - spawnedAtMs);
      const emitTimingSummary = (completionReason: string): void => {
        if (timingSummaryLogged) return;
        timingSummaryLogged = true;
        const finalizeAtMs = Date.now();
        opts.log?.info?.({
          ...attemptLogBase,
          completionReason,
          spawnedAtMs,
          firstStdoutByteAtMs,
          firstStderrByteAtMs,
          firstParsedEventAtMs,
          firstParsedEventType,
          firstParsedEventSource,
          spawnToFirstStdoutMs: toSpawnDelta(firstStdoutByteAtMs),
          spawnToFirstStderrMs: toSpawnDelta(firstStderrByteAtMs),
          spawnToFirstEventMs: toSpawnDelta(firstParsedEventAtMs),
          totalMs: finalizeAtMs - spawnedAtMs,
        }, 'one-shot: timing summary');
      };
      const clearStallTimer = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
      const clearProgressTimer = () => { if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; } };

      const settleAttempt = (result: AttemptResult, completionReason: string): void => {
        if (attemptSettled) return;
        attemptSettled = true;
        emitTimingSummary(completionReason);
        clearStallTimer();
        clearProgressTimer();
        scanner?.stop();
        params.signal?.removeEventListener('abort', onAbort);
        resolveAttempt(result);
      };

      const pushUserText = (
        text: string,
        source?: 'session_scanner' | 'strategy_parser' | 'default_parser',
      ): void => {
        if (!text) return;
        emittedUserOutput = true;
        const evt: EngineEvent = { type: 'text_delta', text };
        if (source) {
          pushParsedEvent(evt, source);
          return;
        }
        push(evt);
      };

      const resetStallTimer = () => {
        if (!opts.streamStallTimeoutMs) return;
        clearStallTimer();
        stallTimer = setTimeout(() => {
          if (attemptSettled || finished) return;
          const ms = opts.streamStallTimeoutMs!;
          opts.log?.info?.(`one-shot: stream stall detected after ${ms}ms, killing process`);
          push({ type: 'error', message: `stream stall: no output for ${ms}ms — increase DISCOCLAW_STREAM_STALL_TIMEOUT_MS to allow longer gaps (current: ${ms}ms)` });
          push({ type: 'done' });
          finished = true;
          subprocess.kill('SIGTERM');
          wake();
          settleAttempt({ kind: 'complete' }, 'stream_stall');
        }, opts.streamStallTimeoutMs);
      };

      let progressResetCount = 0;
      const resetProgressTimer = () => {
        if (!opts.progressStallTimeoutMs) return;
        clearProgressTimer();
        progressResetCount++;
        if (progressResetCount === 1) {
          opts.log?.debug?.(`progress-timer: armed (${opts.progressStallTimeoutMs}ms)`);
        }
        progressTimer = setTimeout(() => {
          if (attemptSettled || finished) return;
          const ms = opts.progressStallTimeoutMs!;
          opts.log?.info?.(`one-shot: progress stall detected (no text_delta for ${ms}ms, resets=${progressResetCount}), killing process`);
          push({ type: 'error', message: `progress stall: no text output for ${ms}ms (possible thinking spiral)` });
          push({ type: 'done' });
          finished = true;
          subprocess.kill('SIGTERM');
          wake();
          settleAttempt({ kind: 'complete' }, 'progress_stall');
        }, opts.progressStallTimeoutMs);
      };

      const onAbort = () => {
        subprocess.kill('SIGKILL');
        if (attemptSettled || finished) return;
        push({ type: 'error', message: 'aborted' });
        push({ type: 'done' });
        finished = true;
        wake();
        settleAttempt({ kind: 'complete' }, 'aborted');
      };
      params.signal?.addEventListener('abort', onAbort, { once: true });

      resetStallTimer();
      resetProgressTimer();

      // --- Session file scanner (Claude-specific, but controlled by opts) ---
      if (opts.sessionScanning && params.sessionId) {
        scanner = new SessionFileScanner(
          { sessionId: params.sessionId, cwd: params.cwd, log: opts.log },
          { onEvent: (evt) => pushParsedEvent(evt, 'session_scanner') },
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
      let procResult: Awaited<typeof subprocess> | null = null;
      const seenImages = new Set<string>();
      let imageCount = 0;
      const recordFirstByte = (stream: 'stdout' | 'stderr'): void => {
        const now = Date.now();
        if (stream === 'stdout') {
          if (firstStdoutByteAtMs != null) return;
          firstStdoutByteAtMs = now;
        } else {
          if (firstStderrByteAtMs != null) return;
          firstStderrByteAtMs = now;
        }
        params.onTelemetry?.({ type: 'first_byte', stream, atMs: now });
        opts.log?.info?.(
          {
            ...attemptLogBase,
            stream,
            firstByteAtMs: now,
            spawnToFirstByteMs: now - spawnedAtMs,
          },
          `one-shot: first ${stream} byte`,
        );
      };

      const recordFirstParsedRuntimeEvent = (
        source: 'session_scanner' | 'strategy_parser' | 'default_parser',
        eventType: EngineEvent['type'],
      ): void => {
        if (firstParsedEventAtMs != null) return;
        const now = Date.now();
        firstParsedEventAtMs = now;
        firstParsedEventType = eventType;
        firstParsedEventSource = source;
        opts.log?.info?.(
          {
            ...attemptLogBase,
            eventSource: source,
            eventType,
            firstParsedEventAtMs: now,
            spawnToFirstParsedEventMs: now - spawnedAtMs,
          },
          'one-shot: first parsed runtime event',
        );
      };

      const pushParsedEvent = (
        evt: EngineEvent,
        source: 'session_scanner' | 'strategy_parser' | 'default_parser',
      ): void => {
        recordFirstParsedRuntimeEvent(source, evt.type);
        push(evt);
      };

      // --- Stdout handler ---
      subprocess.stdout.on('data', (chunk) => {
        resetStallTimer();
        recordFirstByte('stdout');
        const s = String(chunk);
        mergedStdout += s;

        if (outputMode === 'text') {
          pushUserText(s, 'default_parser');
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
                for (const e of parsed.extraEvents) pushParsedEvent(e, 'strategy_parser');
              }

              // Handle text.
              if (parsed.text) {
                recordFirstParsedRuntimeEvent('strategy_parser', 'text_delta');
                merged += parsed.text;
                if (parsed.inToolUse !== undefined) {
                  if (parsed.inToolUse) inToolUse = true;
                }
                if (!inToolUse) {
                  pushUserText(parsed.text, 'strategy_parser');
                  resetProgressTimer();
                }
                if (parsed.inToolUse === false) inToolUse = false;
              } else if (parsed.activity) {
                // Non-text activity (e.g. tool input generation) — reset the
                // progress stall timer so legitimate work isn't killed.
                resetProgressTimer();
              }

              // Handle result text.
              if ('resultText' in parsed) {
                if (typeof parsed.resultText === 'string') {
                  recordFirstParsedRuntimeEvent('strategy_parser', 'text_final');
                }
                resultText = typeof parsed.resultText === 'string' ? parsed.resultText : '';
              }

              // Handle images.
              if (parsed.image && imageCount < MAX_IMAGES_PER_INVOCATION) {
                recordFirstParsedRuntimeEvent('strategy_parser', 'image_data');
                const key = imageDedupeKey(parsed.image);
                if (!seenImages.has(key)) {
                  seenImages.add(key);
                  imageCount++;
                  pushParsedEvent({ type: 'image_data', image: parsed.image }, 'strategy_parser');
                }
              }
              if (parsed.resultImages) {
                if (parsed.resultImages.length > 0) {
                  recordFirstParsedRuntimeEvent('strategy_parser', 'image_data');
                }
                for (const img of parsed.resultImages) {
                  if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
                  const key = imageDedupeKey(img);
                  if (!seenImages.has(key)) {
                    seenImages.add(key);
                    imageCount++;
                    pushParsedEvent({ type: 'image_data', image: img }, 'strategy_parser');
                  }
                }
              }

              continue; // Strategy handled this line.
            }
          }

          // Default JSONL parsing (Claude-compatible fallback).
          const text = extractTextFromUnknownEvent(evt ?? trimmed);
          if (text) {
            recordFirstParsedRuntimeEvent('default_parser', 'text_delta');
            merged += text;
            const hasToolOpen = text.includes('<tool_use>') || text.includes('<tool_calls>') || text.includes('<tool_call>') || text.includes('<tool_results>') || text.includes('<tool_result>');
            const hasToolClose = text.includes('</tool_use>') || text.includes('</tool_calls>') || text.includes('</tool_call>') || text.includes('</tool_results>') || text.includes('</tool_result>');
            if (hasToolOpen) inToolUse = true;
            if (!inToolUse) {
              pushUserText(text, 'default_parser');
              resetProgressTimer();
            }
            if (hasToolClose) inToolUse = false;
          } else if (evt) {
            const rt = extractResultText(evt);
            if (rt !== null) {
              recordFirstParsedRuntimeEvent('default_parser', 'text_final');
              resultText = rt;
            }

            const blocks = extractResultContentBlocks(evt);
            if (blocks) {
              if (blocks.text) {
                recordFirstParsedRuntimeEvent('default_parser', 'text_final');
              } else if (blocks.images.length > 0) {
                recordFirstParsedRuntimeEvent('default_parser', 'image_data');
              }
              resultText = blocks.text;
              for (const img of blocks.images) {
                if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
                const key = imageDedupeKey(img);
                if (!seenImages.has(key)) {
                  seenImages.add(key);
                  imageCount++;
                  pushParsedEvent({ type: 'image_data', image: img }, 'default_parser');
                }
              }
            }

            const img = extractImageFromUnknownEvent(evt);
            if (img && imageCount < MAX_IMAGES_PER_INVOCATION) {
              recordFirstParsedRuntimeEvent('default_parser', 'image_data');
              const key = imageDedupeKey(img);
              if (!seenImages.has(key)) {
                seenImages.add(key);
                imageCount++;
                pushParsedEvent({ type: 'image_data', image: img }, 'default_parser');
              }
            }
          }
        }
      });

      // --- Stderr handler ---
      subprocess.stderr?.on('data', (chunk) => {
        resetStallTimer();
        recordFirstByte('stderr');
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
        if (attemptSettled || finished) return;
        if (!procResult) return;
        if (!stdoutEnded) return;
        if (!stderrEnded) return;

        const exitCode = procResult.exitCode;
        const stdout = procResult.stdout ?? '';
        const stderr = procResult.stderr ?? '';

        if (params.signal?.aborted) {
          push({ type: 'error', message: 'aborted' });
          push({ type: 'done' });
          finished = true;
          wake();
          settleAttempt({ kind: 'complete' }, 'aborted');
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
          settleAttempt({ kind: 'complete' }, 'timed_out');
          return;
        }

        // Spawn failure (no exit code).
        if (procResult.failed && exitCode == null) {
          const raw = String(procResult.shortMessage || procResult.originalMessage || procResult.message || '').trim();
          const retryEnv = maybeBuildLauncherStateRetryEnv(raw, emittedUserOutput);
          if (retryEnv) {
            if (!ctx.sessionResetReason && sessionMap && params.sessionKey) sessionMap.delete(params.sessionKey);
            settleAttempt({ kind: 'retry', envOverrides: retryEnv }, 'spawn_retry');
            return;
          }

          const spawnMsg = strategy.handleSpawnError?.(procResult, binary);
          if (spawnMsg) {
            push({ type: 'error', message: spawnMsg });
          } else {
            const sanitized = strategy.sanitizeError?.(raw, binary) ?? raw;
            push({ type: 'error', message: sanitized || `${strategy.id} failed (no exit code)` });
          }
          push({ type: 'done' });
          finished = true;
          wake();
          settleAttempt({ kind: 'complete' }, 'spawn_failed');
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
                if (parsed.extraEvents) {
                  for (const e of parsed.extraEvents) pushParsedEvent(e, 'strategy_parser');
                }
                if (parsed.text) {
                  recordFirstParsedRuntimeEvent('strategy_parser', 'text_delta');
                  merged += parsed.text;
                  pushUserText(parsed.text, 'strategy_parser');
                }
                if ('resultText' in parsed) {
                  if (typeof parsed.resultText === 'string') {
                    recordFirstParsedRuntimeEvent('strategy_parser', 'text_final');
                  }
                  resultText = typeof parsed.resultText === 'string' ? parsed.resultText : '';
                }
                if (parsed.image && imageCount < MAX_IMAGES_PER_INVOCATION) {
                  recordFirstParsedRuntimeEvent('strategy_parser', 'image_data');
                  const key = imageDedupeKey(parsed.image);
                  if (!seenImages.has(key)) {
                    seenImages.add(key);
                    imageCount++;
                    pushParsedEvent({ type: 'image_data', image: parsed.image }, 'strategy_parser');
                  }
                }
                if (parsed.resultImages) {
                  if (parsed.resultImages.length > 0) {
                    recordFirstParsedRuntimeEvent('strategy_parser', 'image_data');
                  }
                  for (const img of parsed.resultImages) {
                    if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
                    const key = imageDedupeKey(img);
                    if (!seenImages.has(key)) {
                      seenImages.add(key);
                      imageCount++;
                      pushParsedEvent({ type: 'image_data', image: img }, 'strategy_parser');
                    }
                  }
                }
              }
            } else {
              // Default trailing buffer parsing.
              const text = extractTextFromUnknownEvent(evt ?? tail);
              if (text) {
                recordFirstParsedRuntimeEvent('default_parser', 'text_delta');
                merged += text;
                pushUserText(text, 'default_parser');
              }
              if (evt) {
                const rt = extractResultText(evt);
                if (rt !== null) {
                  recordFirstParsedRuntimeEvent('default_parser', 'text_final');
                  resultText = rt;
                }
                const blocks = extractResultContentBlocks(evt);
                if (blocks) {
                  if (blocks.text) {
                    recordFirstParsedRuntimeEvent('default_parser', 'text_final');
                  } else if (blocks.images.length > 0) {
                    recordFirstParsedRuntimeEvent('default_parser', 'image_data');
                  }
                  resultText = blocks.text;
                  for (const blockImg of blocks.images) {
                    if (imageCount >= MAX_IMAGES_PER_INVOCATION) break;
                    const key = imageDedupeKey(blockImg);
                    if (!seenImages.has(key)) {
                      seenImages.add(key);
                      imageCount++;
                      pushParsedEvent({ type: 'image_data', image: blockImg }, 'default_parser');
                    }
                  }
                }
                const img = extractImageFromUnknownEvent(evt);
                if (img && imageCount < MAX_IMAGES_PER_INVOCATION) {
                  recordFirstParsedRuntimeEvent('default_parser', 'image_data');
                  const key = imageDedupeKey(img);
                  if (!seenImages.has(key)) {
                    seenImages.add(key);
                    imageCount++;
                    pushParsedEvent({ type: 'image_data', image: img }, 'default_parser');
                  }
                }
              }
            }
          }
        }

        // Non-zero exit.
        if (exitCode !== 0) {
          const raw = (stderrForError || stderr || stdout || `${strategy.id} exit ${exitCode}`).trim();
          const retryEnv = maybeBuildLauncherStateRetryEnv(raw, emittedUserOutput);
          if (retryEnv) {
            if (!ctx.sessionResetReason && sessionMap && params.sessionKey) sessionMap.delete(params.sessionKey);
            settleAttempt({ kind: 'retry', envOverrides: retryEnv }, 'exit_retry');
            return;
          }

          // Clear stale session on error (session-resume mode).
          if (sessionMap && params.sessionKey) sessionMap.delete(params.sessionKey);

          const exitMsg =
            typeof exitCode === 'number'
              ? strategy.handleExitError?.(exitCode, stderrForError || stderr, stdout)
              : null;
          if (exitMsg) {
            push({ type: 'error', message: exitMsg });
          } else {
            const sanitized = strategy.sanitizeError?.(raw, binary) ?? raw;
            push({ type: 'error', message: sanitized });
          }
          push({ type: 'done' });
          finished = true;
          wake();
          settleAttempt({ kind: 'complete' }, 'nonzero_exit');
          return;
        }

        // Success.
        if (outputMode === 'text') {
          const final = (stdout || mergedStdout).trimEnd();
          if (final) emittedUserOutput = true;
          push({ type: 'text_final', text: final });
        } else {
          const raw = resultText.trimEnd();
          // Claude stream-json can omit a terminal `result` event in some flows.
          // In that case, preserve previous behavior by finalizing from merged deltas.
          const fallback = strategy.id === 'claude_code' ? merged.trimEnd() : '';
          const final = stripToolUseBlocks(raw || fallback);
          if (final) emittedUserOutput = true;
          push({ type: 'text_final', text: final });
        }

        push({ type: 'done' });
        finished = true;
        wake();
        settleAttempt({ kind: 'complete' }, 'success');
      }

      // --- Process completion ---
      subprocess.then((result) => {
        procResult = result;
        tryFinalize();
      }).catch((err: unknown) => {
        if (attemptSettled || finished) return;

        // Check timeout first — use fixed message to avoid leaking prompt/command line.
        if ((err as { timedOut?: boolean } | undefined)?.timedOut) {
          push({
            type: 'error',
            message: `${strategy.id === 'claude_code' ? 'claude' : strategy.id} timed out after ${params.timeoutMs ?? 0}ms`,
          });
          push({ type: 'done' });
          finished = true;
          wake();
          settleAttempt({ kind: 'complete' }, 'timed_out');
          return;
        }

        const raw = String(
          (err as { originalMessage?: unknown; shortMessage?: unknown; message?: unknown }).originalMessage
          || (err as { originalMessage?: unknown; shortMessage?: unknown; message?: unknown }).shortMessage
          || (err as { originalMessage?: unknown; shortMessage?: unknown; message?: unknown }).message
          || err
          || ''
        ).trim();
        const retryEnv = maybeBuildLauncherStateRetryEnv(raw, emittedUserOutput);
        if (retryEnv) {
          if (!ctx.sessionResetReason && sessionMap && params.sessionKey) sessionMap.delete(params.sessionKey);
          settleAttempt({ kind: 'retry', envOverrides: retryEnv }, 'reject_retry');
          return;
        }

        const spawnMsg = strategy.handleSpawnError?.(err, binary);
        if (spawnMsg) {
          push({ type: 'error', message: spawnMsg });
        } else {
          const sanitized = strategy.sanitizeError?.(raw, binary) ?? raw;
          push({
            type: 'error',
            message: sanitized || `${strategy.id} failed`,
          });
        }
        push({ type: 'done' });
        finished = true;
        wake();
        settleAttempt({ kind: 'complete' }, 'process_rejected');
      });
    });

    void (async () => {
      let envOverrides: Record<string, string | undefined> | undefined;
      let attempt = 0;
      while (!finished) {
        attempt += 1;
        const result = await runOneShotAttempt(attempt, envOverrides);
        if (result.kind === 'retry') {
          envOverrides = result.envOverrides;
          continue;
        }
        return;
      }
    })().catch((err) => {
      if (finished) return;
      const msg = String((err as { message?: unknown })?.message || err || '').trim() || `${strategy.id} failed`;
      const sanitized = strategy.sanitizeError?.(msg, binary) ?? msg;
      push({ type: 'error', message: sanitized });
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
      if (!finished && activeSubprocess) {
        (activeSubprocess as unknown as { kill(signal: string): void }).kill('SIGKILL');
      }
      await imageCleanup?.().catch(() => {});
    }
  }

  return {
    id: strategy.id,
    capabilities,
    defaultModel: strategy.defaultModel,
    invoke,
  };
}
