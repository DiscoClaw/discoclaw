/**
 * Token estimator for Gemini Live sessions.
 *
 * Tracks approximate token usage across text, audio, and tool payloads
 * to warn before the context window fills and server-side sliding window
 * compression silently drops older context.
 *
 * Estimation is deliberately coarse (chars/4 for text, duration-based for
 * audio) — the goal is order-of-magnitude awareness, not exact counts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenEstimate = {
  textTokens: number;
  audioTokens: number;
  toolTokens: number;
  total: number;
};

export type TokenBudget = {
  /** Estimated tokens before emitting a warning. */
  warnAt: number;
  /** Estimated tokens before recommending compression/rotation. */
  compressAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough chars-per-token for mixed English text. */
const CHARS_PER_TOKEN = 4;

/** Approximate tokens per second of 16 kHz mono speech audio. */
const AUDIO_TOKENS_PER_SECOND = 25;

/** Input audio: 16 kHz mono PCM s16le → 2 bytes per sample. */
const INPUT_BYTES_PER_SECOND = 16_000 * 2;

/** Output audio: 24 kHz mono PCM s16le → 2 bytes per sample. */
const OUTPUT_BYTES_PER_SECOND = 24_000 * 2;

const DEFAULT_BUDGET: TokenBudget = {
  warnAt: 200_000,
  compressAt: 500_000,
};

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export class GeminiLiveTokenEstimator {
  private textTokens = 0;
  private audioTokens = 0;
  private toolTokens = 0;
  private warnEmitted = false;
  private compressEmitted = false;
  private readonly budget: TokenBudget;

  constructor(budget?: Partial<TokenBudget>) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  /** Record text tokens (sent or received). */
  addText(text: string): void {
    this.textTokens += Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /** Record input audio tokens from PCM byte count (16 kHz mono). */
  addInputAudio(pcmBytes: number): void {
    const seconds = pcmBytes / INPUT_BYTES_PER_SECOND;
    this.audioTokens += Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND);
  }

  /** Record output audio tokens from PCM byte count (24 kHz mono). */
  addOutputAudio(pcmBytes: number): void {
    const seconds = pcmBytes / OUTPUT_BYTES_PER_SECOND;
    this.audioTokens += Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND);
  }

  /** Record a tool call (function name + serialised args). */
  addToolCall(name: string, args: Record<string, unknown>): void {
    const payload = name + JSON.stringify(args);
    this.toolTokens += Math.ceil(payload.length / CHARS_PER_TOKEN);
  }

  /** Record a tool response. */
  addToolResponse(output: string): void {
    this.toolTokens += Math.ceil(output.length / CHARS_PER_TOKEN);
  }

  /** Current estimate snapshot. */
  get estimate(): TokenEstimate {
    const total = this.textTokens + this.audioTokens + this.toolTokens;
    return { textTokens: this.textTokens, audioTokens: this.audioTokens, toolTokens: this.toolTokens, total };
  }

  /** Whether the warn threshold has been crossed. */
  get shouldWarn(): boolean {
    return this.estimate.total >= this.budget.warnAt;
  }

  /** Whether the compress/rotate threshold has been crossed. */
  get shouldCompress(): boolean {
    return this.estimate.total >= this.budget.compressAt;
  }

  /**
   * Check thresholds and return which (if any) was newly crossed.
   * Returns the threshold name once per crossing — subsequent calls
   * return `null` until `reset()` is called.
   */
  checkThreshold(): 'warn' | 'compress' | null {
    if (this.shouldCompress && !this.compressEmitted) {
      this.compressEmitted = true;
      this.warnEmitted = true; // skip warn if compress fires first
      return 'compress';
    }
    if (this.shouldWarn && !this.warnEmitted) {
      this.warnEmitted = true;
      return 'warn';
    }
    return null;
  }

  /** Reset all counters (e.g. after session rotation). */
  reset(): void {
    this.textTokens = 0;
    this.audioTokens = 0;
    this.toolTokens = 0;
    this.warnEmitted = false;
    this.compressEmitted = false;
  }
}
