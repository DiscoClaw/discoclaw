import type { EngineEvent, RuntimeId } from '../runtime/types.js';

/**
 * Hard cap for extra runtime-derived preview lines (tool/log/usage/reasoning signals)
 * so streaming previews stay cheap and predictable.
 */
export const MAX_RUNTIME_SIGNAL_LINES_PER_STREAM = 8;

/**
 * Fairness cap for noisy runtime logs so lifecycle/status signals still surface.
 */
export const MAX_RUNTIME_LOG_SIGNAL_LINES_PER_STREAM = 3;

/**
 * Fairness cap for usage updates; usage can be noisy in some runtimes.
 */
export const MAX_RUNTIME_USAGE_SIGNAL_LINES_PER_STREAM = 2;

/**
 * While native stream text is actively flowing, synthetic status lines are held
 * back and only re-enabled after this quiet window elapses.
 */
export const RUNTIME_SIGNAL_FALLBACK_IDLE_MS = 2500;

/**
 * One-time marker appended when the runtime signal budget is exhausted.
 */
export const RUNTIME_SIGNAL_SUPPRESSED_LINE = 'Some runtime preview updates suppressed.';

export function runtimeSupportsNativeThinkingStream(runtimeId: RuntimeId): boolean {
  // Codex can emit reasoning content as text deltas.
  return runtimeId === 'codex';
}

type RuntimeSignalClass = 'log' | 'usage' | 'status';

function classifyRuntimeSignal(evt: EngineEvent): RuntimeSignalClass | null {
  switch (evt.type) {
    case 'log_line':
      return 'log';
    case 'usage':
      return 'usage';
    case 'tool_start':
    case 'tool_end':
    case 'preview_debug':
      return 'status';
    default:
      return null;
  }
}

function isCriticalRuntimeSignal(evt: EngineEvent): boolean {
  return evt.type === 'tool_end' && evt.ok === false;
}

function shouldFallbackGateSignal(evt: EngineEvent): boolean {
  // Keep noisy signals fallback-only while native text is flowing.
  if (evt.type === 'log_line' || evt.type === 'usage') return true;

  // Reasoning lifecycle markers can be high-churn with native thinking deltas.
  if (evt.type === 'preview_debug') return evt.itemType === 'reasoning';

  // Always surface tool lifecycle and non-reasoning preview_debug.
  return false;
}

type ConsumeResult = {
  allow: boolean;
  appendSuppression: boolean;
};

/**
 * Shared signal budget tracker used by streaming surfaces to keep preview noise
 * bounded and fair across signal classes.
 */
export class RuntimeSignalBudgetTracker {
  private totalLines = 0;
  private logLines = 0;
  private usageLines = 0;
  private suppressionEmitted = false;
  private sawNativeTextDelta = false;
  private lastNativeTextDeltaAtMs = 0;
  private readonly useNativeTextFallback: boolean;

  constructor(opts?: { useNativeTextFallback?: boolean }) {
    this.useNativeTextFallback = opts?.useNativeTextFallback ?? false;
  }

  noteNativeTextDelta(nowMs = Date.now()): void {
    this.sawNativeTextDelta = true;
    this.lastNativeTextDeltaAtMs = nowMs;
  }

  reset(): void {
    this.totalLines = 0;
    this.logLines = 0;
    this.usageLines = 0;
    this.suppressionEmitted = false;
    this.sawNativeTextDelta = false;
    this.lastNativeTextDeltaAtMs = 0;
  }

  consume(evt: EngineEvent, nowMs = Date.now()): ConsumeResult {
    const cls = classifyRuntimeSignal(evt);
    if (!cls) return { allow: false, appendSuppression: false };

    // Option 2 behavior: when native thinking/stream text is flowing, treat
    // synthetic status lines as fallback-only (except critical failures).
    if (
      this.useNativeTextFallback &&
      this.sawNativeTextDelta &&
      shouldFallbackGateSignal(evt) &&
      !isCriticalRuntimeSignal(evt) &&
      nowMs - this.lastNativeTextDeltaAtMs <= RUNTIME_SIGNAL_FALLBACK_IDLE_MS
    ) {
      return { allow: false, appendSuppression: false };
    }

    if (this.totalLines >= MAX_RUNTIME_SIGNAL_LINES_PER_STREAM) {
      return this.suppress();
    }

    if (cls === 'log' && this.logLines >= MAX_RUNTIME_LOG_SIGNAL_LINES_PER_STREAM) {
      return this.suppress();
    }

    if (cls === 'usage' && this.usageLines >= MAX_RUNTIME_USAGE_SIGNAL_LINES_PER_STREAM) {
      return this.suppress();
    }

    this.totalLines += 1;
    if (cls === 'log') this.logLines += 1;
    if (cls === 'usage') this.usageLines += 1;
    return { allow: true, appendSuppression: false };
  }

  private suppress(): ConsumeResult {
    if (!this.suppressionEmitted) {
      this.suppressionEmitted = true;
      return { allow: false, appendSuppression: true };
    }
    return { allow: false, appendSuppression: false };
  }
}
