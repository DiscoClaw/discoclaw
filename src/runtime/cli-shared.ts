// Shared CLI runtime utilities — extracted from claude-code-cli.ts and codex-cli.ts
// to eliminate duplication across CLI-based runtime adapters.

import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import type { ResultPromise } from 'execa';
import {
  CODEX_CAPABILITY_CONTRACT,
  createAdvertisedCodexCapabilities,
} from './tool-capabilities.js';
import type { EngineEvent } from './types.js';
import type { RuntimeCapability } from './types.js';

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

type CodexCapabilityContractEntry = (typeof CODEX_CAPABILITY_CONTRACT)[keyof typeof CODEX_CAPABILITY_CONTRACT];
type CodexContractCapability = keyof typeof CODEX_CAPABILITY_CONTRACT;

const ORDERED_ADVERTISED_CODEX_CAPABILITIES = (
  Object.entries(CODEX_CAPABILITY_CONTRACT) as Array<[CodexContractCapability, CodexCapabilityContractEntry]>
)
  .filter(([, contract]) => contract.exposure === 'advertised')
  .map(([capability]) => capability);

/**
 * Resolve prompt-safe Codex orchestration wording from the audited capability profile.
 * This intentionally emits only enforcement-backed guarantees and drops richer
 * transport-only affordances that are not safe to advertise as runtime contracts.
 */
export function collectPromptSafeCodexOrchestrationWording(
  runtimeCapabilities: Iterable<RuntimeCapability>,
): string[] {
  const advertised = createAdvertisedCodexCapabilities(runtimeCapabilities);
  const wording: string[] = [];

  for (const capability of ORDERED_ADVERTISED_CODEX_CAPABILITIES) {
    if (!advertised.has(capability)) continue;
    wording.push(CODEX_CAPABILITY_CONTRACT[capability].runtimeWording);
  }

  return wording;
}

/** Join prompt-safe Codex orchestration wording into a single runtime-facing string. */
export function formatPromptSafeCodexOrchestrationWording(
  runtimeCapabilities: Iterable<RuntimeCapability>,
): string {
  return collectPromptSafeCodexOrchestrationWording(runtimeCapabilities).join(' ');
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
export function cliExecaEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...process.env,
    NO_COLOR: process.env.NO_COLOR ?? '1',
    FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
    TERM: process.env.TERM ?? 'dumb',
    ...(overrides ?? {}),
  };
}

const ANSI_ESCAPE_SEQUENCE =
  /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|(?:\u001B[P^_]|[\u0090\u009E\u009F])[\s\S]*?(?:\u001B\\|\u009C)|\u001B[@-_]/g;

/**
 * Remove ANSI/VT control sequences from shell output.
 * `stripVTControlCharacters()` handles the common cases; the regex pass covers
 * OSC/DCS/PM/APC string forms that may still appear in raw CLI output.
 */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text.replace(ANSI_ESCAPE_SEQUENCE, ''));
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
