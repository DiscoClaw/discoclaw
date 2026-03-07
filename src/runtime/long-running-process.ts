import crypto from 'node:crypto';
import { execa, type ResultPromise } from 'execa';
import { MAX_IMAGES_PER_INVOCATION, type EngineEvent, type ImageData, type RuntimeTelemetryEvent } from './types.js';
import { tryParseJsonLine, cliExecaEnv } from './cli-shared.js';
import {
  extractTextFromUnknownEvent,
  extractResultText,
  extractImageFromUnknownEvent,
  extractResultContentBlocks,
  imageDedupeKey,
  stripToolUseBlocks,
} from './cli-output-parsers.js';
import { SessionFileScanner } from './session-scanner.js';

export type LongRunningProcessState = 'starting' | 'idle' | 'busy' | 'dead';

export type LongRunningProcessOpts = {
  claudeBin: string;
  model: string;
  cwd: string;
  envOverrides?: Record<string, string | undefined>;
  dangerouslySkipPermissions?: boolean;
  strictMcpConfig?: boolean;
  fallbackModel?: string;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  tools?: string[];
  addDirs?: string[];
  hangTimeoutMs?: number;
  idleTimeoutMs?: number;
  verbose?: boolean;
  sessionScanning?: boolean;
  log?: { info(...args: unknown[]): void; debug(...args: unknown[]): void };
};

/**
 * Manages a single long-running Claude Code subprocess using `--input-format stream-json`.
 * Prompts are sent via stdin as NDJSON; responses stream back on stdout.
 */
export class LongRunningProcess {
  private subprocess: ResultPromise | null = null;
  private _state: LongRunningProcessState = 'starting';
  private readonly opts: Required<Pick<LongRunningProcessOpts, 'hangTimeoutMs' | 'idleTimeoutMs'>> & LongRunningProcessOpts;
  private readonly sessionId: string;

  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killAfterTimer: ReturnType<typeof setTimeout> | null = null;

  private cleanupCalled = false;
  private turnActive = false;
  private turnEnded = false;

  private stdoutOnData: ((chunk: Buffer | string) => void) | null = null;
  private stderrOnData: ((chunk: Buffer | string) => void) | null = null;
  private turnScanner: SessionFileScanner | null = null;

  // For active turn: the queue + notify mechanism (same pattern as one-shot).
  private turnQueue: EngineEvent[] = [];
  private turnNotify: (() => void) | null = null;
  private stdoutBuffer = '';

  // Track accumulated text for the current turn.
  private turnMerged = '';
  private turnResultText = '';
  private turnInToolUse = false;
  private turnActiveTools = new Map<number, string>();
  private turnToolInputBufs = new Map<number, string>();
  private turnSeenImages = new Set<string>();
  private turnImageCount = 0;
  private lastThinkingPreviewAt = 0;
  private thinkingBuf = '';
  private turnEmittedReasoningStart = false;
  private spawnedAtMs: number | null = null;
  private turnStartedAtMs: number | null = null;
  private firstTurnByteAtMs: number | null = null;
  private firstTurnStdoutByteAtMs: number | null = null;
  private firstTurnStderrByteAtMs: number | null = null;
  private firstTurnEventAtMs: number | null = null;
  private firstTurnEventType: EngineEvent['type'] | null = null;
  private firstTurnEventSource: 'stdout_parser' | 'session_scanner' | null = null;
  private turnTelemetrySink?: (evt: RuntimeTelemetryEvent) => void;

  /** Called when this process is added to / removed from an external tracking set. */
  onCleanup?: () => void;

  constructor(opts: LongRunningProcessOpts) {
    this.opts = {
      hangTimeoutMs: 60_000,
      idleTimeoutMs: 300_000,
      ...opts,
    };
    this.sessionId = crypto.randomUUID();
  }

  get state(): LongRunningProcessState {
    return this._state;
  }

  get isAlive(): boolean {
    return this._state === 'idle' || this._state === 'busy';
  }

  get envOverrides(): Record<string, string | undefined> | undefined {
    return this.opts.envOverrides;
  }

  /**
   * Spawn the Claude Code subprocess. Must be called once after construction.
   * Returns false if spawn fails.
   */
  spawn(): boolean {
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--model', this.opts.model,
      '--session-id', this.sessionId,
    ];

    if (this.opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (this.opts.strictMcpConfig) {
      args.push('--strict-mcp-config');
    }
    if (this.opts.fallbackModel) {
      args.push('--fallback-model', this.opts.fallbackModel);
    }
    if (this.opts.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(this.opts.maxBudgetUsd));
    }
    if (this.opts.appendSystemPrompt) {
      args.push('--append-system-prompt', this.opts.appendSystemPrompt);
    }
    if (this.opts.verbose) {
      args.push('--verbose');
    }
    if (this.opts.tools) {
      if (this.opts.tools.length > 0) {
        args.push('--tools', this.opts.tools.join(','));
      } else {
        args.push('--tools=');
      }
    }
    if (this.opts.addDirs) {
      for (const dir of this.opts.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    this.opts.log?.debug({ args }, 'long-running: spawning');

    try {
      this.subprocess = execa(this.opts.claudeBin, args, {
        cwd: this.opts.cwd,
        reject: false,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: cliExecaEnv(this.opts.envOverrides),
      });
    } catch (err) {
      this.opts.log?.info({ err }, 'long-running: spawn failed');
      this._state = 'dead';
      return false;
    }

    this.spawnedAtMs = Date.now();
    this.opts.log?.info?.({
      sessionId: this.sessionId,
      pid: this.subprocess.pid ?? null,
      spawnedAtMs: this.spawnedAtMs,
    }, 'long-running: subprocess spawned');

    // Handle process exit.
    this.subprocess.then(() => {
      this.handleExit();
    }).catch(() => {
      this.handleExit();
    });

    this._state = 'idle';
    this.startIdleTimer();
    return true;
  }

  /**
   * Send a user turn to the long-running process and yield EngineEvents.
   * Caller must ensure state is `idle` before calling.
   */
  async *sendTurn(
    prompt: string,
    images?: ImageData[],
    onTelemetry?: (evt: RuntimeTelemetryEvent) => void,
  ): AsyncGenerator<EngineEvent> {
    if (this._state !== 'idle') {
      yield { type: 'error', message: `long-running: cannot send turn in state ${this._state}` };
      yield { type: 'done' };
      return;
    }

    this._state = 'busy';
    this.clearIdleTimer();
    this.turnActive = true;
    this.turnEnded = false;

    // Reset per-turn state.
    this.turnQueue = [];
    this.turnNotify = null;
    this.turnStartedAtMs = Date.now();
    this.turnMerged = '';
    this.turnResultText = '';
    this.turnInToolUse = false;
    this.turnActiveTools = new Map();
    this.turnToolInputBufs = new Map();
    this.turnSeenImages = new Set<string>();
    this.turnImageCount = 0;
    this.lastThinkingPreviewAt = 0;
    this.thinkingBuf = '';
    this.turnEmittedReasoningStart = false;
    this.firstTurnByteAtMs = null;
    this.firstTurnStdoutByteAtMs = null;
    this.firstTurnStderrByteAtMs = null;
    this.firstTurnEventAtMs = null;
    this.firstTurnEventType = null;
    this.firstTurnEventSource = null;
    this.turnTelemetrySink = onTelemetry;
    this.stdoutBuffer = '';
    this.opts.log?.info?.({
      sessionId: this.sessionId,
      pid: this.subprocess?.pid ?? null,
      processSpawnedAtMs: this.spawnedAtMs,
      turnStartedAtMs: this.turnStartedAtMs,
    }, 'long-running: turn started');

    // Wire up stdout parsing for this turn.
    const onData = (chunk: Buffer | string) => {
      this.resetHangTimer();
      this.recordFirstTurnByte('stdout');
      this.parseStdoutChunk(String(chunk));
    };
    this.stdoutOnData = onData;
    this.subprocess!.stdout!.on('data', onData);

    const onStderrData = (_chunk: Buffer | string) => {
      this.recordFirstTurnByte('stderr');
    };
    this.stderrOnData = onStderrData;
    this.subprocess!.stderr!.on('data', onStderrData);

    // Start session file scanner for real-time tool/thinking events.
    if (this.opts.sessionScanning) {
      this.turnScanner = new SessionFileScanner(
        { sessionId: this.sessionId, cwd: this.opts.cwd, log: this.opts.log },
        { onEvent: (evt) => this.pushParsedTurnEvent(evt, 'session_scanner') },
      );
      this.turnScanner.start().catch((err) =>
        this.opts.log?.debug({ err }, 'session-scanner: start failed (LRP)'),
      );
    }

    // Start hang detection.
    this.startHangTimer();

    // Write the user message to stdin (Claude CLI stream-json expects API-shaped messages).
    // When images are present, build a content-block array; otherwise plain string.
    const content = images && images.length > 0
      ? [
          { type: 'text', text: prompt },
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          })),
        ]
      : prompt;
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    try {
      this.subprocess!.stdin!.write(msg);
    } catch (err) {
      // Treat as a fatal termination for this turn: unblock the consumer.
      this.terminate({
        reason: 'stdin_write_failed',
        signal: 'SIGKILL',
        emitTurnError: true,
        errorMessage: `long-running: stdin write failed: ${err}`,
      });
      // Drain the events we just enqueued.
      while (this.turnQueue.length > 0) {
        yield this.turnQueue.shift()!;
      }
      return;
    }

    // Yield events as they arrive.
    try {
      let done = false;
      while (!done) {
        if (this.turnQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this.turnNotify = resolve;
          });
        }
        while (this.turnQueue.length > 0) {
          const evt = this.turnQueue.shift()!;
          yield evt;
          if (evt.type === 'done') {
            done = true;
            break;
          }
        }
      }
    } finally {
      if (this.stdoutOnData) {
        this.subprocess?.stdout?.off('data', this.stdoutOnData);
        this.stdoutOnData = null;
      }
      if (this.stderrOnData) {
        this.subprocess?.stderr?.off('data', this.stderrOnData);
        this.stderrOnData = null;
      }
      this.turnScanner?.stop();
      this.turnScanner = null;
      this.turnTelemetrySink = undefined;
      this.clearHangTimer();
      this.turnActive = false;
      if (this._state === 'busy') {
        this._state = 'idle';
        this.startIdleTimer();
      }
    }
  }

  /** Gracefully kill the subprocess. */
  kill(): void {
    this.terminate({
      reason: 'kill',
      signal: 'SIGTERM',
      forceKillAfterMs: 5000,
      emitTurnError: true,
      // Avoid triggering one-shot fallback heuristics ("long-running:" / "hang detected").
      errorMessage: 'multi-turn: terminated',
    });
  }

  /** Force-kill the subprocess. */
  forceKill(): void {
    this.terminate({
      reason: 'force_kill',
      signal: 'SIGKILL',
      emitTurnError: true,
      // Avoid triggering one-shot fallback heuristics ("long-running:" / "hang detected").
      errorMessage: 'multi-turn: terminated',
    });
  }

  /** Get the underlying subprocess for external tracking (e.g. activeSubprocesses set). */
  getSubprocess(): ResultPromise | null {
    return this.subprocess;
  }

  // --- Internal ---

  private pushEvent(evt: EngineEvent): void {
    this.turnQueue.push(evt);
    if (this.turnNotify) {
      const n = this.turnNotify;
      this.turnNotify = null;
      n();
    }
  }

  private recordFirstTurnByte(stream: 'stdout' | 'stderr'): void {
    const now = Date.now();
    if (this.firstTurnByteAtMs == null) this.firstTurnByteAtMs = now;
    if (stream === 'stdout') {
      if (this.firstTurnStdoutByteAtMs != null) return;
      this.firstTurnStdoutByteAtMs = now;
    } else {
      if (this.firstTurnStderrByteAtMs != null) return;
      this.firstTurnStderrByteAtMs = now;
    }
    this.turnTelemetrySink?.({ type: 'first_byte', stream, atMs: now });
    this.opts.log?.info?.({
      sessionId: this.sessionId,
      turnStartedAtMs: this.turnStartedAtMs,
      stream,
      firstByteAtMs: now,
      turnToFirstByteMs: this.turnStartedAtMs == null ? null : now - this.turnStartedAtMs,
    }, `long-running: first ${stream} byte for turn`);
  }

  private recordFirstParsedTurnEvent(
    evt: EngineEvent,
    source: 'stdout_parser' | 'session_scanner',
  ): void {
    if (this.firstTurnEventAtMs != null) return;
    const now = Date.now();
    this.firstTurnEventAtMs = now;
    this.firstTurnEventType = evt.type;
    this.firstTurnEventSource = source;
    this.opts.log?.info?.({
      sessionId: this.sessionId,
      turnStartedAtMs: this.turnStartedAtMs,
      eventSource: source,
      eventType: evt.type,
      firstParsedEventAtMs: now,
      turnToFirstParsedEventMs: this.turnStartedAtMs == null ? null : now - this.turnStartedAtMs,
    }, 'long-running: first parsed runtime event for turn');
  }

  private pushParsedTurnEvent(evt: EngineEvent, source: 'stdout_parser' | 'session_scanner' = 'stdout_parser'): void {
    this.recordFirstParsedTurnEvent(evt, source);
    this.pushEvent(evt);
  }

  private parseStdoutChunk(s: string): void {
    this.stdoutBuffer += s;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const evt = tryParseJsonLine(trimmed);
      if (!evt) continue;

      const anyEvt = evt as Record<string, unknown>;

      // Handle assistant partial messages (from --include-partial-messages).
      // Claude Code CLI emits these as content snapshots — NOT stream_event wrappers.
      // Extract thinking text for preview.
      if (anyEvt.type === 'assistant') {
        let thinkingText = '';
        const msg = anyEvt.message;
        if (msg && typeof msg === 'object') {
          const content = (msg as Record<string, unknown>).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === 'object') {
                const b = block as Record<string, unknown>;
                if (b.type === 'thinking' && typeof b.thinking === 'string') {
                  thinkingText = b.thinking;
                }
              }
            }
          }
        }
        if (thinkingText) {
          this.emitReasoningStartPreviewIfNeeded();
          const now = Date.now();
          if (this.lastThinkingPreviewAt === 0 || now - this.lastThinkingPreviewAt >= 3_000) {
            this.lastThinkingPreviewAt = now;
            const preview = thinkingText.length > 200 ? thinkingText.slice(-200) : thinkingText;
            this.pushParsedTurnEvent({ type: 'thinking_delta', text: preview });
          }
        }
        continue;
      }

      // Detect end-of-turn: a `result` event signals Claude finished this turn.
      if (anyEvt.type === 'result') {
        const usageEvt = this.extractUsageEvent(anyEvt.usage);
        if (usageEvt) this.pushParsedTurnEvent(usageEvt);

        const rt = extractResultText(evt);
        if (rt) this.turnResultText = rt;

        // Extract images from result content block arrays.
        const blocks = extractResultContentBlocks(evt);
        if (blocks) {
          if (blocks.text) this.turnResultText = blocks.text;
          for (const img of blocks.images) {
            this.pushImageIfNew(img);
          }
        }

        this.finalizeTurn();
        return;
      }

      // Claude stream_event wrappers include structured tool + usage metadata.
      if (anyEvt.type === 'stream_event' && anyEvt.event && typeof anyEvt.event === 'object') {
        const inner = anyEvt.event as Record<string, unknown>;
        const idx = typeof inner.index === 'number' ? inner.index : null;

        if (inner.type === 'content_block_start' && idx !== null && inner.content_block && typeof inner.content_block === 'object') {
          const block = inner.content_block as Record<string, unknown>;
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            this.turnActiveTools.set(idx, block.name);
            this.turnToolInputBufs.set(idx, '');
          } else if (block.type === 'thinking') {
            this.emitReasoningStartPreviewIfNeeded();
          }
          continue;
        }

        if (inner.type === 'content_block_delta' && idx !== null && inner.delta && typeof inner.delta === 'object') {
          const delta = inner.delta as Record<string, unknown>;
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const existing = this.turnToolInputBufs.get(idx);
            if (existing !== undefined) this.turnToolInputBufs.set(idx, existing + delta.partial_json);
            continue;
          }
          // thinking_delta — accumulate reasoning text and emit periodic previews.
          if (delta.type === 'thinking_delta') {
            this.emitReasoningStartPreviewIfNeeded();
            if (typeof delta.thinking === 'string') this.thinkingBuf += delta.thinking;
            const now = Date.now();
            if (now - this.lastThinkingPreviewAt >= 3_000) {
              this.lastThinkingPreviewAt = now;
              const buf = this.thinkingBuf;
              const preview = buf.length > 200 ? buf.slice(-200) : buf;
              this.pushParsedTurnEvent({ type: 'thinking_delta', text: preview || 'reasoning...' });
            }
            continue;
          }
        }

        if (inner.type === 'content_block_stop' && idx !== null) {
          const name = this.turnActiveTools.get(idx);
          if (name) {
            let input: unknown;
            const buf = this.turnToolInputBufs.get(idx);
            if (buf) {
              try { input = JSON.parse(buf); } catch { /* partial/invalid JSON */ }
            }
            this.turnActiveTools.delete(idx);
            this.turnToolInputBufs.delete(idx);
            this.pushParsedTurnEvent({ type: 'tool_start', name, ...(input ? { input } : {}) });
            this.pushParsedTurnEvent({ type: 'tool_end', name, ok: true });
          }
          continue;
        }

        const usageEvt = this.extractUsageEvent(inner.usage)
          ?? this.extractUsageEvent((inner.message && typeof inner.message === 'object')
            ? (inner.message as Record<string, unknown>).usage
            : undefined);
        if (usageEvt) {
          this.pushParsedTurnEvent(usageEvt);
          continue;
        }
      }

      // Extract streaming text.
      const text = extractTextFromUnknownEvent(evt);
      if (text) {
        this.turnMerged += text;
        const hasToolOpen = text.includes('<tool_use>') || text.includes('<tool_calls>') || text.includes('<tool_call>') || text.includes('<tool_results>') || text.includes('<tool_result>');
        const hasToolClose = text.includes('</tool_use>') || text.includes('</tool_calls>') || text.includes('</tool_call>') || text.includes('</tool_results>') || text.includes('</tool_result>');
        if (hasToolOpen) this.turnInToolUse = true;
        if (!this.turnInToolUse) this.pushParsedTurnEvent({ type: 'text_delta', text });
        if (hasToolClose) this.turnInToolUse = false;
      } else {
        // Try extracting a single image from streaming content blocks.
        const img = extractImageFromUnknownEvent(evt);
        if (img) this.pushImageIfNew(img);
      }
    }
  }

  private extractUsageEvent(raw: unknown): Extract<EngineEvent, { type: 'usage' }> | null {
    if (!raw || typeof raw !== 'object') return null;
    const usage = raw as Record<string, unknown>;
    const asNumber = (value: unknown): number | undefined => (
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    );
    const inputTokens = asNumber(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = asNumber(usage.output_tokens ?? usage.outputTokens);
    const totalTokens = asNumber(usage.total_tokens ?? usage.totalTokens);
    const costUsd = asNumber(usage.cost_usd ?? usage.costUsd);
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      totalTokens === undefined &&
      costUsd === undefined
    ) {
      return null;
    }
    return { type: 'usage', inputTokens, outputTokens, totalTokens, costUsd };
  }

  private emitReasoningStartPreviewIfNeeded(): void {
    if (this.turnEmittedReasoningStart) return;
    this.turnEmittedReasoningStart = true;
    this.pushParsedTurnEvent({
      type: 'preview_debug',
      source: 'claude',
      phase: 'started',
      itemType: 'reasoning',
      label: 'Hypothesis: reasoning in progress.',
    });
  }

  private isContextOverflow(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('prompt is too long') ||
      lower.includes('context length exceeded') ||
      lower.includes('context_length_exceeded')
    );
  }

  private finalizeTurn(): void {
    const raw = this.turnResultText.trim() || (this.turnMerged.trim() ? this.turnMerged.trimEnd() : '');
    const final = stripToolUseBlocks(raw);
    if (final) {
      if (this.isContextOverflow(final)) {
        this.pushParsedTurnEvent({ type: 'error', message: 'long-running: context overflow' });
      } else {
        this.pushParsedTurnEvent({ type: 'text_final', text: final });
      }
    }
    this.pushDoneOnce();
  }

  private handleExit(): void {
    const hadActiveTurn = this.turnActive && !this.turnEnded;
    this._state = 'dead';
    this.clearHangTimer();
    this.clearIdleTimer();
    this.clearKillAfterTimer();

    if (hadActiveTurn) {
      this.pushEvent({ type: 'error', message: 'long-running: process exited unexpectedly' });
      this.pushDoneOnce();
    }
    this.cleanupOnce();
  }

  private startHangTimer(): void {
    this.clearHangTimer();
    this.hangTimer = setTimeout(() => {
      this.opts.log?.info('long-running: hang detected, killing process');
      this.terminate({
        reason: 'hang',
        signal: 'SIGKILL',
        emitTurnError: true,
        errorMessage: 'multi-turn: hang detected',
      });
    }, this.opts.hangTimeoutMs);
  }

  private resetHangTimer(): void {
    if (this._state !== 'busy') return;
    this.startHangTimer();
  }

  private clearHangTimer(): void {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.opts.log?.info('long-running: idle timeout, killing process');
      // Idle kill is not a "turn failure" and should not affect consumers.
      this.terminate({
        reason: 'idle_timeout',
        signal: 'SIGTERM',
        forceKillAfterMs: 5000,
        emitTurnError: false,
      });
    }, this.opts.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearKillAfterTimer(): void {
    if (this.killAfterTimer) {
      clearTimeout(this.killAfterTimer);
      this.killAfterTimer = null;
    }
  }

  private cleanupOnce(): void {
    if (this.cleanupCalled) return;
    this.cleanupCalled = true;
    this.onCleanup?.();
  }

  private pushImageIfNew(img: ImageData): void {
    if (this.turnImageCount >= MAX_IMAGES_PER_INVOCATION) return;
    const key = imageDedupeKey(img);
    if (this.turnSeenImages.has(key)) return;
    this.turnSeenImages.add(key);
    this.turnImageCount++;
    this.pushParsedTurnEvent({ type: 'image_data', image: img });
  }

  private pushDoneOnce(): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    const startedAtMs = this.turnStartedAtMs;
    const doneAtMs = Date.now();
    const toTurnDelta = (ts: number | null): number | null => (
      startedAtMs == null || ts == null ? null : ts - startedAtMs
    );
    this.opts.log?.info?.({
      turnToFirstByteMs: toTurnDelta(this.firstTurnByteAtMs),
      turnToFirstStdoutByteMs: toTurnDelta(this.firstTurnStdoutByteAtMs),
      turnToFirstStderrByteMs: toTurnDelta(this.firstTurnStderrByteAtMs),
      turnToFirstEventMs: toTurnDelta(this.firstTurnEventAtMs),
      processSpawnedAtMs: this.spawnedAtMs,
      turnStartedAtMs: startedAtMs,
      firstTurnStdoutByteAtMs: this.firstTurnStdoutByteAtMs,
      firstTurnStderrByteAtMs: this.firstTurnStderrByteAtMs,
      firstTurnEventAtMs: this.firstTurnEventAtMs,
      firstTurnEventType: this.firstTurnEventType,
      firstTurnEventSource: this.firstTurnEventSource,
      totalMs: startedAtMs == null ? null : doneAtMs - startedAtMs,
      sessionId: this.sessionId,
    }, 'long-running: turn timing summary');
    this.pushEvent({ type: 'done' });
  }

  private terminate(opts: {
    reason: 'hang' | 'idle_timeout' | 'kill' | 'force_kill' | 'exit' | 'stdin_write_failed';
    signal: 'SIGTERM' | 'SIGKILL';
    forceKillAfterMs?: number;
    emitTurnError: boolean;
    errorMessage?: string;
  }): void {
    // Idempotent: once dead and the active turn is ended, there's nothing left to do.
    if (this._state === 'dead' && (!this.turnActive || this.turnEnded)) {
      this.cleanupOnce();
      return;
    }

    this.clearHangTimer();
    this.clearIdleTimer();
    this.clearKillAfterTimer();

    if (this.stdoutOnData) {
      this.subprocess?.stdout?.off('data', this.stdoutOnData);
      this.stdoutOnData = null;
    }
    if (this.stderrOnData) {
      this.subprocess?.stderr?.off('data', this.stderrOnData);
      this.stderrOnData = null;
    }
    this.turnScanner?.stop();
    this.turnScanner = null;

    this._state = 'dead';

    // If a consumer is blocked waiting for events, guarantee we unblock it.
    if (this.turnActive && !this.turnEnded) {
      if (opts.emitTurnError && opts.errorMessage) {
        this.pushEvent({ type: 'error', message: opts.errorMessage });
      }
      this.pushDoneOnce();
    }

    try {
      this.subprocess?.kill(opts.signal);
    } catch { /* ignore */ }

    if (opts.signal === 'SIGTERM' && opts.forceKillAfterMs && opts.forceKillAfterMs > 0) {
      this.killAfterTimer = setTimeout(() => {
        try {
          this.subprocess?.kill('SIGKILL');
        } catch { /* ignore */ }
      }, opts.forceKillAfterMs);
    }

    this.cleanupOnce();
  }
}
