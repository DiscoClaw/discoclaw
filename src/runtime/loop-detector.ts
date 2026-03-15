import type { EngineEvent } from './types.js';

export type LoopDetectorOpts = {
  /** Number of repeated patterns before emitting a warning. Default: 8 */
  warnThreshold?: number;
  /** Number of repeated patterns before triggering abort. Default: 15 */
  criticalThreshold?: number;
  /** Sliding window size for frequency analysis. Default: 20 */
  windowSize?: number;
  /** Called when a repeating pattern reaches the warn threshold. */
  onWarn?: (pattern: string) => void;
  /** Called when a repeating pattern reaches the critical threshold. */
  onCritical?: (pattern: string) => void;
};

/**
 * Fast non-crypto hash for tool-call signatures.
 * djb2 variant — good distribution, trivial to compute.
 */
function fastHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function makeSignature(name: string, input: unknown): string {
  let inputHash: number;
  try {
    inputHash = fastHash(JSON.stringify(input ?? ''));
  } catch {
    inputHash = 0;
  }
  return `${name}:${inputHash}`;
}

/**
 * Detects degenerate tool-calling loops during AI runtime execution.
 *
 * Observes `tool_start` events and checks for three patterns:
 * 1. Consecutive identical calls (same tool + same input N times in a row)
 * 2. Ping-pong alternation (A-B-A-B-… pattern)
 * 3. Frequency dominance (same signature appears too often within the sliding window)
 *
 * Emits `onWarn` at the warn threshold and `onCritical` at the critical threshold.
 */
export class LoopDetector {
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly windowSize: number;
  private readonly onWarnCb?: (pattern: string) => void;
  private readonly onCriticalCb?: (pattern: string) => void;

  /** Circular buffer of recent signatures. */
  private readonly buffer: string[];
  /** Write position in the circular buffer. */
  private pos = 0;
  /** Total events seen (used to know how full the buffer is). */
  private count = 0;

  /** Tracks whether warn/critical have already fired for a given pattern. */
  private warnedPatterns = new Set<string>();
  private criticalPatterns = new Set<string>();

  constructor(opts: LoopDetectorOpts = {}) {
    this.warnThreshold = opts.warnThreshold ?? 8;
    this.criticalThreshold = opts.criticalThreshold ?? 15;
    this.windowSize = opts.windowSize ?? 20;
    this.onWarnCb = opts.onWarn;
    this.onCriticalCb = opts.onCritical;

    this.buffer = new Array<string>(this.windowSize).fill('');
  }

  onEvent(evt: EngineEvent): void {
    if (evt.type !== 'tool_start') return;

    const sig = makeSignature(evt.name, evt.input);

    // Write into circular buffer.
    this.buffer[this.pos % this.windowSize] = sig;
    this.pos = (this.pos + 1) % this.windowSize;
    this.count++;

    // --- Pattern 1: Consecutive identical calls ---
    const consecutiveCount = this.countConsecutiveTail(sig);
    this.checkThresholds(`consecutive:${sig}`, consecutiveCount, `consecutive "${evt.name}"`);

    // --- Pattern 2: Ping-pong (alternating pair) ---
    const pingPongLen = this.detectPingPong();
    if (pingPongLen > 0) {
      // pingPongLen is the number of alternations (each pair = 2 events).
      // We count pairs, so 4 alternations = A-B-A-B = 4 events.
      const prev = this.bufferAt(-2);
      const ppLabel = `pingpong:${prev}/${sig}`;
      this.checkThresholds(ppLabel, pingPongLen, `ping-pong "${this.toolName(prev)}" <-> "${evt.name}"`);
    }

    // --- Pattern 3: Frequency within window ---
    const freq = this.countInWindow(sig);
    this.checkThresholds(`freq:${sig}`, freq, `frequency "${evt.name}"`);
  }

  dispose(): void {
    this.buffer.fill('');
    this.pos = 0;
    this.count = 0;
    this.warnedPatterns.clear();
    this.criticalPatterns.clear();
  }

  /** Count how many consecutive entries at the tail of the buffer match `sig`. */
  private countConsecutiveTail(sig: string): number {
    const filled = Math.min(this.count, this.windowSize);
    let run = 0;
    for (let i = 0; i < filled; i++) {
      const idx = ((this.pos - 1 - i) % this.windowSize + this.windowSize) % this.windowSize;
      if (this.buffer[idx] !== sig) break;
      run++;
    }
    return run;
  }

  /** Detect alternating A-B-A-B pattern at the tail. Returns the length of the alternation. */
  private detectPingPong(): number {
    const filled = Math.min(this.count, this.windowSize);
    if (filled < 4) return 0;

    const a = this.bufferAt(-1); // most recent
    const b = this.bufferAt(-2);
    if (a === b) return 0; // Not alternating if both are the same.

    let pairs = 0;
    for (let i = 0; i < filled; i += 2) {
      const posA = ((this.pos - 1 - i) % this.windowSize + this.windowSize) % this.windowSize;
      const posB = ((this.pos - 2 - i) % this.windowSize + this.windowSize) % this.windowSize;
      if (this.buffer[posA] === a && this.buffer[posB] === b) {
        pairs++;
      } else {
        break;
      }
    }
    // pairs=1 means just one A-B occurrence (the current), which is fine.
    // We return the count as number of individual events in the alternation.
    return pairs >= 2 ? pairs * 2 : 0;
  }

  /** Count how many times `sig` appears in the current window. */
  private countInWindow(sig: string): number {
    const filled = Math.min(this.count, this.windowSize);
    let n = 0;
    for (let i = 0; i < filled; i++) {
      const idx = ((this.pos - 1 - i) % this.windowSize + this.windowSize) % this.windowSize;
      if (this.buffer[idx] === sig) n++;
    }
    return n;
  }

  /** Read a buffer entry relative to the current position. -1 = most recent. */
  private bufferAt(offset: number): string {
    const idx = ((this.pos + offset) % this.windowSize + this.windowSize) % this.windowSize;
    return this.buffer[idx];
  }

  /** Extract the tool name from a signature. */
  private toolName(sig: string): string {
    const colon = sig.indexOf(':');
    return colon >= 0 ? sig.slice(0, colon) : sig;
  }

  private checkThresholds(patternKey: string, count: number, label: string): void {
    if (count >= this.criticalThreshold && !this.criticalPatterns.has(patternKey)) {
      this.criticalPatterns.add(patternKey);
      this.warnedPatterns.add(patternKey); // skip warn if jumping straight to critical
      this.onCriticalCb?.(`loop detected: ${label} (${count}x)`);
    } else if (count >= this.warnThreshold && !this.warnedPatterns.has(patternKey)) {
      this.warnedPatterns.add(patternKey);
      this.onWarnCb?.(`possible loop: ${label} (${count}x)`);
    }
  }
}
