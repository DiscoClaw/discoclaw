import type { EngineEvent, RuntimeId } from '../runtime/types.js';

/**
 * Hard cap for extra runtime-derived preview lines (tool/log/usage/reasoning signals)
 * so streaming previews stay cheap and predictable.
 */
export const MAX_RUNTIME_SIGNAL_LINES_PER_STREAM = 30;

/**
 * Fairness cap for noisy runtime logs so lifecycle/status signals still surface.
 */
export const MAX_RUNTIME_LOG_SIGNAL_LINES_PER_STREAM = 12;

/**
 * Fairness cap for usage updates; usage can be noisy in some runtimes.
 */
export const MAX_RUNTIME_USAGE_SIGNAL_LINES_PER_STREAM = 4;

/**
 * While native stream text is actively flowing, synthetic status lines are held
 * back and only re-enabled after this quiet window elapses.
 */
export const RUNTIME_SIGNAL_FALLBACK_IDLE_MS = 2500;

/**
 * One-time marker appended when the runtime signal budget is exhausted.
 */
export const RUNTIME_SIGNAL_SUPPRESSED_LINE = 'Some runtime preview updates suppressed.';

/**
 * After repeated Discord edit timeouts, keep the retry cooldown short enough
 * that already-buffered high-value preview updates can still surface promptly.
 */
export const STREAMING_EDIT_TIMEOUT_COOLDOWN_MS = 5_000;

export function runtimeSupportsNativeThinkingStream(runtimeId: RuntimeId): boolean {
  // Codex can emit reasoning content as text deltas.
  return runtimeId === 'codex';
}

export function shouldBypassStreamingEditCooldown(evt: EngineEvent): boolean {
  if (evt.type === 'preview_debug') {
    return evt.source === 'codex' && (evt.itemType === 'reasoning' || evt.itemType === 'command_execution');
  }
  if (evt.type === 'tool_end') return evt.ok === false;
  if (evt.type === 'error') return true;
  return false;
}

type RuntimeSignalClass = 'log' | 'usage' | 'status';
export type RuntimeSignalDecisionReason =
  | 'allowed'
  | 'guaranteed_signal'
  | 'not_runtime_signal'
  | 'duplicate_preview_debug'
  | 'native_fallback_active'
  | 'total_budget_exhausted'
  | 'log_budget_exhausted'
  | 'usage_budget_exhausted';

function classifyRuntimeSignal(evt: EngineEvent): RuntimeSignalClass | null {
  switch (evt.type) {
    case 'log_line':
      return 'log';
    case 'usage':
      return 'usage';
    case 'tool_start':
    case 'tool_end':
    case 'preview_debug':
    case 'thinking_delta':
      return 'status';
    default:
      return null;
  }
}

function isCriticalRuntimeSignal(evt: EngineEvent): boolean {
  return evt.type === 'tool_end' && evt.ok === false;
}

function isGuaranteedRuntimeSignal(evt: EngineEvent): boolean {
  // Always surface final tool status.
  if (evt.type === 'tool_end') return true;

  // Always surface thinking previews — already throttled at the source.
  if (evt.type === 'thinking_delta') return true;

  // Always surface codex lifecycle markers for reasoning + command execution.
  if (evt.type === 'preview_debug') {
    return evt.source === 'codex' && (evt.itemType === 'reasoning' || evt.itemType === 'command_execution');
  }

  return false;
}

function shouldFallbackGateSignal(evt: EngineEvent): boolean {
  // Keep noisy signals fallback-only while native text is flowing.
  if (evt.type === 'log_line' || evt.type === 'usage') return true;

  // Lifecycle markers are handled by the guaranteed lane.
  return false;
}

type ConsumeResult = {
  allow: boolean;
  appendSuppression: boolean;
  reason: RuntimeSignalDecisionReason;
};

/**
 * Shared signal budget tracker used by streaming surfaces to keep preview noise
 * bounded and fair across signal classes.
 */
export interface RuntimeSignalBudgetLimits {
  maxTotal?: number;
  maxLog?: number;
  maxUsage?: number;
}

export class RuntimeSignalBudgetTracker {
  private totalLines = 0;
  private logLines = 0;
  private usageLines = 0;
  private suppressionEmitted = false;
  private openPreviewLifecycle = new Set<string>();
  private recentPreviewTerminalKeys = new Set<string>();
  private recentPreviewTerminalOrder: string[] = [];
  private sawNativeTextDelta = false;
  private lastNativeTextDeltaAtMs = 0;
  private readonly useNativeTextFallback: boolean;
  private readonly maxTotal: number;
  private readonly maxLog: number;
  private readonly maxUsage: number;

  constructor(opts?: { useNativeTextFallback?: boolean; budgetLimits?: RuntimeSignalBudgetLimits }) {
    this.useNativeTextFallback = opts?.useNativeTextFallback ?? false;
    this.maxTotal = opts?.budgetLimits?.maxTotal ?? MAX_RUNTIME_SIGNAL_LINES_PER_STREAM;
    this.maxLog = opts?.budgetLimits?.maxLog ?? MAX_RUNTIME_LOG_SIGNAL_LINES_PER_STREAM;
    this.maxUsage = opts?.budgetLimits?.maxUsage ?? MAX_RUNTIME_USAGE_SIGNAL_LINES_PER_STREAM;
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
    this.openPreviewLifecycle.clear();
    this.recentPreviewTerminalKeys.clear();
    this.recentPreviewTerminalOrder = [];
    this.sawNativeTextDelta = false;
    this.lastNativeTextDeltaAtMs = 0;
  }

  private rememberPreviewTerminalKey(key: string): void {
    if (this.recentPreviewTerminalKeys.has(key)) return;
    this.recentPreviewTerminalKeys.add(key);
    this.recentPreviewTerminalOrder.push(key);
    while (this.recentPreviewTerminalOrder.length > 64) {
      const oldest = this.recentPreviewTerminalOrder.shift();
      if (oldest) this.recentPreviewTerminalKeys.delete(oldest);
    }
  }

  consume(evt: EngineEvent, nowMs = Date.now()): ConsumeResult {
    const cls = classifyRuntimeSignal(evt);
    if (!cls) return { allow: false, appendSuppression: false, reason: 'not_runtime_signal' };

    // Collapse duplicate preview lifecycle chatter when runtime provides a stable item id.
    if (evt.type === 'preview_debug') {
      const key = evt.itemId ? `${evt.source}:${evt.itemType}:${evt.itemId}` : null;
      if (key) {
        if (evt.phase === 'started') {
          if (this.openPreviewLifecycle.has(key)) {
            return { allow: false, appendSuppression: false, reason: 'duplicate_preview_debug' };
          }
          this.openPreviewLifecycle.add(key);
        } else if (evt.phase === 'completed') {
          const terminalKey = `${key}:${evt.phase}`;
          if (!this.openPreviewLifecycle.has(key) && this.recentPreviewTerminalKeys.has(terminalKey)) {
            return { allow: false, appendSuppression: false, reason: 'duplicate_preview_debug' };
          }
          this.openPreviewLifecycle.delete(key);
          this.rememberPreviewTerminalKey(terminalKey);
        }
      }
    }

    // Guaranteed lane bypasses fallback gating and budget caps.
    if (isGuaranteedRuntimeSignal(evt)) {
      return { allow: true, appendSuppression: false, reason: 'guaranteed_signal' };
    }

    // Option 2 behavior: when native thinking/stream text is flowing, treat
    // synthetic status lines as fallback-only (except critical failures).
    if (
      this.useNativeTextFallback &&
      this.sawNativeTextDelta &&
      shouldFallbackGateSignal(evt) &&
      !isCriticalRuntimeSignal(evt) &&
      nowMs - this.lastNativeTextDeltaAtMs <= RUNTIME_SIGNAL_FALLBACK_IDLE_MS
    ) {
      return { allow: false, appendSuppression: false, reason: 'native_fallback_active' };
    }

    if (this.totalLines >= this.maxTotal) {
      return this.suppress('total_budget_exhausted');
    }

    if (cls === 'log' && this.logLines >= this.maxLog) {
      return this.suppress('log_budget_exhausted');
    }

    if (cls === 'usage' && this.usageLines >= this.maxUsage) {
      return this.suppress('usage_budget_exhausted');
    }

    this.totalLines += 1;
    if (cls === 'log') this.logLines += 1;
    if (cls === 'usage') this.usageLines += 1;
    return { allow: true, appendSuppression: false, reason: 'allowed' };
  }

  private suppress(reason: Extract<RuntimeSignalDecisionReason, 'total_budget_exhausted' | 'log_budget_exhausted' | 'usage_budget_exhausted'>): ConsumeResult {
    if (!this.suppressionEmitted) {
      this.suppressionEmitted = true;
      return { allow: false, appendSuppression: true, reason };
    }
    return { allow: false, appendSuppression: false, reason };
  }
}
