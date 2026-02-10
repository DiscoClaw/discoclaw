import process from 'node:process';
import { execa, type ResultPromise } from 'execa';
import type { EngineEvent } from './types.js';
import {
  extractTextFromUnknownEvent,
  extractResultText,
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
  tools?: string[];
  addDirs?: string[];
  hangTimeoutMs?: number;
  idleTimeoutMs?: number;
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

  // For active turn: the queue + notify mechanism (same pattern as one-shot).
  private turnQueue: EngineEvent[] = [];
  private turnNotify: (() => void) | null = null;
  private stdoutBuffer = '';

  // Track accumulated text for the current turn.
  private turnMerged = '';
  private turnResultText = '';
  private turnInToolUse = false;

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
  async *sendTurn(prompt: string): AsyncGenerator<EngineEvent> {
    if (this._state !== 'idle') {
      yield { type: 'error', message: `long-running: cannot send turn in state ${this._state}` };
      yield { type: 'done' };
      return;
    }

    this._state = 'busy';
    this.clearIdleTimer();

    // Reset per-turn state.
    this.turnQueue = [];
    this.turnNotify = null;
    this.turnMerged = '';
    this.turnResultText = '';
    this.turnInToolUse = false;
    this.stdoutBuffer = '';

    // Wire up stdout parsing for this turn.
    const onData = (chunk: Buffer | string) => {
      this.resetHangTimer();
      this.parseStdoutChunk(String(chunk));
    };
    this.subprocess!.stdout!.on('data', onData);

    // Start hang detection.
    this.startHangTimer();

    // Write the user message to stdin (Claude CLI stream-json expects API-shaped messages).
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
    try {
      this.subprocess!.stdin!.write(msg);
    } catch (err) {
      this.subprocess!.stdout!.off('data', onData);
      this.clearHangTimer();
      this._state = 'dead';
      yield { type: 'error', message: `long-running: stdin write failed: ${err}` };
      yield { type: 'done' };
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
      this.subprocess?.stdout?.off('data', onData);
      this.clearHangTimer();
      if (this._state === 'busy') {
        this._state = 'idle';
        this.startIdleTimer();
      }
    }
  }

  /** Gracefully kill the subprocess. */
  kill(): void {
    this.clearHangTimer();
    this.clearIdleTimer();
    this._state = 'dead';
    try {
      this.subprocess?.kill('SIGTERM');
    } catch { /* ignore */ }
    this.onCleanup?.();
  }

  /** Force-kill the subprocess. */
  forceKill(): void {
    this.clearHangTimer();
    this.clearIdleTimer();
    this._state = 'dead';
    try {
      this.subprocess?.kill('SIGKILL');
    } catch { /* ignore */ }
    this.onCleanup?.();
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
      }
    }
  }

  private finalizeTurn(): void {
    const raw = this.turnResultText.trim() || (this.turnMerged.trim() ? this.turnMerged.trimEnd() : '');
    const final = stripToolUseBlocks(raw);
    if (final) this.pushEvent({ type: 'text_final', text: final });
    this.pushEvent({ type: 'done' });
  }

  private handleExit(): void {
    if (this._state === 'dead') return;
    const wasBusy = this._state === 'busy';
    this._state = 'dead';
    this.clearHangTimer();
    this.clearIdleTimer();

    if (wasBusy) {
      this.pushEvent({ type: 'error', message: 'long-running: process exited unexpectedly' });
      this.pushEvent({ type: 'done' });
    }
    this.onCleanup?.();
  }

  private startHangTimer(): void {
    this.clearHangTimer();
    this.hangTimer = setTimeout(() => {
      this.opts.log?.info('long-running: hang detected, killing process');
      this.pushEvent({ type: 'error', message: 'multi-turn: hang detected' });
      this.pushEvent({ type: 'done' });
      this._state = 'dead';
      try {
        this.subprocess?.kill('SIGKILL');
      } catch { /* ignore */ }
      this.onCleanup?.();
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
      this.kill();
    }, this.opts.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
