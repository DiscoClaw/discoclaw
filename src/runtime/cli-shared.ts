// Shared CLI runtime utilities — extracted from claude-code-cli.ts and codex-cli.ts
// to eliminate duplication across CLI-based runtime adapters.

import process from 'node:process';
import type { ResultPromise } from 'execa';
import type { EngineEvent } from './types.js';

// ---------------------------------------------------------------------------
// STDIN_THRESHOLD — byte limit above which prompts are piped via stdin
// ---------------------------------------------------------------------------
/** Byte threshold above which prompts are piped via stdin instead of positional arg. */
export const STDIN_THRESHOLD = 100_000;

// ---------------------------------------------------------------------------
// tryParseJsonLine — lenient single-line JSON parser
// ---------------------------------------------------------------------------
export function tryParseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createEventQueue — push/wait/wake pattern for async generator streaming
// ---------------------------------------------------------------------------
export type EventQueue = {
  q: EngineEvent[];
  push: (evt: EngineEvent) => void;
  wait: () => Promise<void>;
  wake: () => void;
};

export function createEventQueue(): EventQueue {
  const q: EngineEvent[] = [];
  let notify: (() => void) | null = null;

  const wake = () => {
    if (!notify) return;
    const n = notify;
    notify = null;
    n();
  };
  const push = (evt: EngineEvent) => {
    q.push(evt);
    wake();
  };
  const wait = () => new Promise<void>((r) => { notify = r; });

  return { q, push, wait, wake };
}

// ---------------------------------------------------------------------------
// SubprocessTracker — tracks active subprocesses + pools for shutdown
// ---------------------------------------------------------------------------
export class SubprocessTracker {
  private readonly subprocesses = new Set<ResultPromise>();
  private readonly pools = new Set<{ killAll(): void }>();

  /** Register an active subprocess for tracking. */
  add(p: ResultPromise): void {
    this.subprocesses.add(p);
  }

  /** Unregister a subprocess after it completes. */
  delete(p: ResultPromise): void {
    this.subprocesses.delete(p);
  }

  /** Register a process pool for shutdown cleanup. */
  addPool(pool: { killAll(): void }): void {
    this.pools.add(pool);
  }

  /** SIGKILL all tracked subprocesses and pools (e.g. on SIGTERM). */
  killAll(): void {
    for (const pool of this.pools) {
      pool.killAll();
    }
    for (const p of this.subprocesses) {
      p.kill('SIGKILL');
    }
    this.subprocesses.clear();
  }
}

// ---------------------------------------------------------------------------
// cliExecaEnv — standard env overrides for CLI subprocesses
// ---------------------------------------------------------------------------
/** Build the environment for a CLI subprocess (NO_COLOR, FORCE_COLOR, TERM). */
export function cliExecaEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NO_COLOR: process.env.NO_COLOR ?? '1',
    FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
    TERM: process.env.TERM ?? 'dumb',
  };
}

// ---------------------------------------------------------------------------
// LineBuffer — splits streaming chunks into lines, preserving trailing buffer
// ---------------------------------------------------------------------------
export class LineBuffer {
  private buffer = '';

  /** Feed a chunk and return completed lines (without newlines). */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  /** Return and clear any remaining buffered content. */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }
}
