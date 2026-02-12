import process from 'node:process';
import { execa, type ResultPromise } from 'execa';
import { MAX_IMAGES_PER_INVOCATION, type EngineEvent, type ImageData } from './types.js';
import {
  extractTextFromUnknownEvent,
  extractResultText,
  extractImageFromUnknownEvent,
  extractResultContentBlocks,
  imageDedupeKey,
  stripToolUseBlocks,
  tryParseJsonLine,
} from './claude-code-cli.js';

export type LongRunningProcessState = 'starting' | 'idle' | 'busy' | 'dead';

export type LongRunningProcessOpts = {
  claudeBin: string;
  model: string;
  cwd: string;
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

  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killAfterTimer: ReturnType<typeof setTimeout> | null = null;

  private cleanupCalled = false;
  private turnActive = false;
  private turnEnded = false;

  private stdoutOnData: ((chunk: Buffer | string) => void) | null = null;

  // For active turn: the queue + notify mechanism (same pattern as one-shot).
  private turnQueue: EngineEvent[] = [];
  private turnNotify: (() => void) | null = null;
  private stdoutBuffer = '';

  // Track accumulated text for the current turn.
  private turnMerged = '';
  private turnResultText = '';
  private turnInToolUse = false;
  private turnSeenImages = new Set<string>();
  private turnImageCount = 0;

  /** Called when this process is added to / removed from an external tracking set. */
  onCleanup?: () => void;

  constructor(opts: LongRunningProcessOpts) {
    this.opts = {
      hangTimeoutMs: 60_000,
      idleTimeoutMs: 300_000,
      ...opts,
    };
  }

  get state(): LongRunningProcessState {
    return this._state;
  }

  get isAlive(): boolean {
    return this._state === 'idle' || this._state === 'busy';
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
        env: {
          ...process.env,
          NO_COLOR: process.env.NO_COLOR ?? '1',
          FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
          TERM: process.env.TERM ?? 'dumb',
        },
      });
    } catch (err) {
      this.opts.log?.info({ err }, 'long-running: spawn failed');
      this._state = 'dead';
      return false;
    }

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
  async *sendTurn(prompt: string, images?: ImageData[]): AsyncGenerator<EngineEvent> {
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
    this.turnMerged = '';
    this.turnResultText = '';
    this.turnInToolUse = false;
    this.turnSeenImages = new Set<string>();
    this.turnImageCount = 0;
    this.stdoutBuffer = '';

    // Wire up stdout parsing for this turn.
    const onData = (chunk: Buffer | string) => {
      this.resetHangTimer();
      this.parseStdoutChunk(String(chunk));
    };
    this.stdoutOnData = onData;
    this.subprocess!.stdout!.on('data', onData);

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

      // Detect end-of-turn: a `result` event signals Claude finished this turn.
      if (anyEvt.type === 'result') {
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

      // Extract streaming text.
      const text = extractTextFromUnknownEvent(evt);
      if (text) {
        this.turnMerged += text;
        const hasToolOpen = text.includes('<tool_use>') || text.includes('<tool_calls>') || text.includes('<tool_call>') || text.includes('<tool_results>') || text.includes('<tool_result>');
        const hasToolClose = text.includes('</tool_use>') || text.includes('</tool_calls>') || text.includes('</tool_call>') || text.includes('</tool_results>') || text.includes('</tool_result>');
        if (hasToolOpen) this.turnInToolUse = true;
        if (!this.turnInToolUse) this.pushEvent({ type: 'text_delta', text });
        if (hasToolClose) this.turnInToolUse = false;
      } else {
        // Try extracting a single image from streaming content blocks.
        const img = extractImageFromUnknownEvent(evt);
        if (img) this.pushImageIfNew(img);
      }
    }
  }

  private finalizeTurn(): void {
    const raw = this.turnResultText.trim() || (this.turnMerged.trim() ? this.turnMerged.trimEnd() : '');
    const final = stripToolUseBlocks(raw);
    if (final) this.pushEvent({ type: 'text_final', text: final });
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
    this.pushEvent({ type: 'image_data', image: img });
  }

  private pushDoneOnce(): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
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
