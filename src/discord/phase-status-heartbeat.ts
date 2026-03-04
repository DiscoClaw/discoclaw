export type PhaseStatusTerminalOutcome = 'succeeded' | 'failed' | 'cancelled';

export type PhaseStatusHeartbeatPolicy = {
  enabled: boolean;
  intervalMs: number;
};

export type PhaseStatusHeartbeatEvent =
  | {
      type: 'phase_start';
      flowLabel: string;
      phaseLabel: string;
      runElapsedMs: number;
      atMs: number;
    }
  | {
      type: 'heartbeat';
      flowLabel: string;
      phaseLabel: string;
      beat: number;
      phaseElapsedMs: number;
      runElapsedMs: number;
      atMs: number;
    }
  | {
      type: 'phase_transition';
      flowLabel: string;
      fromPhaseLabel: string;
      toPhaseLabel: string;
      fromPhaseElapsedMs: number;
      runElapsedMs: number;
      atMs: number;
    }
  | {
      type: 'terminal';
      flowLabel: string;
      phaseLabel: string | null;
      phaseElapsedMs: number;
      runElapsedMs: number;
      outcome: PhaseStatusTerminalOutcome;
      detail?: string;
      atMs: number;
    };

export type PhaseStatusHeartbeatControllerOpts = {
  flowLabel: string;
  onUpdate: (message: string, event: PhaseStatusHeartbeatEvent) => Promise<void> | void;
  onError?: (err: unknown, event: PhaseStatusHeartbeatEvent) => void;
  policy?: string | number | Partial<PhaseStatusHeartbeatPolicy> | null;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type PhaseStatusHeartbeatController = {
  startPhase: (phaseLabel: string) => Promise<void>;
  transitionPhase: (phaseLabel: string) => Promise<void>;
  complete: (outcome: PhaseStatusTerminalOutcome, detail?: string) => Promise<void>;
  dispose: () => void;
  getPolicy: () => PhaseStatusHeartbeatPolicy;
};

export const DEFAULT_PHASE_STATUS_HEARTBEAT_POLICY: PhaseStatusHeartbeatPolicy = {
  enabled: true,
  intervalMs: 45_000,
};

const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
const DISABLED_POLICY_WORDS = new Set(['off', 'none', 'disable', 'disabled', 'false']);

function parseDurationToMs(input: string): number | null {
  const m = input.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const value = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? 'ms').toLowerCase();
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return value;
}

function normalizeIntervalMs(ms: number): number {
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(ms));
}

export function parsePhaseStatusHeartbeatPolicy(
  raw: string | number | Partial<PhaseStatusHeartbeatPolicy> | null | undefined,
  defaults: PhaseStatusHeartbeatPolicy = DEFAULT_PHASE_STATUS_HEARTBEAT_POLICY,
): PhaseStatusHeartbeatPolicy {
  const base: PhaseStatusHeartbeatPolicy = {
    enabled: defaults.enabled,
    intervalMs: normalizeIntervalMs(defaults.intervalMs),
  };

  if (raw == null) return base;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return { ...base, enabled: false };
    return { enabled: true, intervalMs: normalizeIntervalMs(raw) };
  }

  if (typeof raw === 'string') {
    const token = raw.trim().toLowerCase();
    if (!token) return base;
    if (token === '0' || DISABLED_POLICY_WORDS.has(token)) return { ...base, enabled: false };
    const ms = parseDurationToMs(token);
    if (ms == null || ms <= 0) return base;
    return { enabled: true, intervalMs: normalizeIntervalMs(ms) };
  }

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled;
  const intervalCandidate = typeof raw.intervalMs === 'number' && Number.isFinite(raw.intervalMs)
    ? raw.intervalMs
    : base.intervalMs;
  return {
    enabled: enabled && intervalCandidate > 0,
    intervalMs: normalizeIntervalMs(intervalCandidate),
  };
}

export function extractPlanHeaderHeartbeatValue(planContent: string): string | null {
  if (!planContent) return null;
  const lines = planContent.split('\n');
  let heartbeatValue: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') break;
    const metadata = trimmed.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);
    if (!metadata) continue;
    const key = (metadata[1] ?? '').trim().toLowerCase();
    if (key !== 'heartbeat') continue;
    heartbeatValue = (metadata[2] ?? '').trim();
  }

  return heartbeatValue;
}

export function resolvePlanHeaderHeartbeatPolicy(
  planContent: string,
  fallbackPolicy?: string | number | Partial<PhaseStatusHeartbeatPolicy> | null,
): PhaseStatusHeartbeatPolicy {
  const defaults = parsePhaseStatusHeartbeatPolicy(fallbackPolicy);
  const rawPlanHeartbeat = extractPlanHeaderHeartbeatValue(planContent);
  if (rawPlanHeartbeat == null) return defaults;
  return parsePhaseStatusHeartbeatPolicy(rawPlanHeartbeat, defaults);
}

export function formatHeartbeatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatPhaseStatusHeartbeatEvent(event: PhaseStatusHeartbeatEvent): string {
  if (event.type === 'phase_start') {
    return `${event.flowLabel}: starting ${event.phaseLabel}...`;
  }
  if (event.type === 'heartbeat') {
    return `${event.flowLabel}: ${event.phaseLabel} still running (${formatHeartbeatDuration(event.phaseElapsedMs)} elapsed)`;
  }
  if (event.type === 'phase_transition') {
    return `${event.flowLabel}: ${event.fromPhaseLabel} complete (${formatHeartbeatDuration(event.fromPhaseElapsedMs)}). Starting ${event.toPhaseLabel}...`;
  }
  const phaseLabel = event.phaseLabel ? ` during ${event.phaseLabel}` : '';
  const detail = event.detail ? ` ${event.detail}` : '';
  if (event.outcome === 'succeeded') {
    return `${event.flowLabel}: complete${phaseLabel} (${formatHeartbeatDuration(event.runElapsedMs)} total).${detail}`;
  }
  if (event.outcome === 'cancelled') {
    return `${event.flowLabel}: cancelled${phaseLabel} after ${formatHeartbeatDuration(event.runElapsedMs)}.${detail}`;
  }
  return `${event.flowLabel}: failed${phaseLabel} after ${formatHeartbeatDuration(event.runElapsedMs)}.${detail}`;
}

export function createPhaseStatusHeartbeatController(
  opts: PhaseStatusHeartbeatControllerOpts,
): PhaseStatusHeartbeatController {
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const policy = parsePhaseStatusHeartbeatPolicy(opts.policy);

  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let terminalEmitted = false;
  let runStartedAtMs: number | null = null;
  let currentPhaseLabel: string | null = null;
  let currentPhaseStartedAtMs: number | null = null;
  let beat = 0;
  let heartbeatInFlight = false;
  let emitQueue: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  };

  const safeEmit = async (event: PhaseStatusHeartbeatEvent): Promise<void> => {
    try {
      await opts.onUpdate(formatPhaseStatusHeartbeatEvent(event), event);
    } catch (err) {
      opts.onError?.(err, event);
    }
  };

  const queueEmit = (event: PhaseStatusHeartbeatEvent): Promise<void> => {
    emitQueue = emitQueue.then(
      () => safeEmit(event),
      () => safeEmit(event),
    );
    return emitQueue;
  };

  const startTimerIfNeeded = () => {
    if (timer || disposed || terminalEmitted || !policy.enabled) return;
    timer = setIntervalFn(() => {
      if (disposed || terminalEmitted || !currentPhaseLabel || currentPhaseStartedAtMs == null) return;
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      beat += 1;
      const atMs = now();
      const runStart = runStartedAtMs ?? atMs;
      const event: PhaseStatusHeartbeatEvent = {
        type: 'heartbeat',
        flowLabel: opts.flowLabel,
        phaseLabel: currentPhaseLabel,
        beat,
        phaseElapsedMs: atMs - currentPhaseStartedAtMs,
        runElapsedMs: atMs - runStart,
        atMs,
      };
      void queueEmit(event).finally(() => {
        heartbeatInFlight = false;
      });
    }, policy.intervalMs);
  };

  const setPhase = async (phaseLabel: string): Promise<void> => {
    if (disposed || terminalEmitted) return;
    const atMs = now();
    if (runStartedAtMs == null) runStartedAtMs = atMs;

    const previousPhaseLabel = currentPhaseLabel;
    const previousPhaseStartedAtMs = currentPhaseStartedAtMs;

    currentPhaseLabel = phaseLabel;
    currentPhaseStartedAtMs = atMs;
    beat = 0;

    startTimerIfNeeded();

    if (!previousPhaseLabel || previousPhaseStartedAtMs == null) {
      await queueEmit({
        type: 'phase_start',
        flowLabel: opts.flowLabel,
        phaseLabel,
        runElapsedMs: atMs - runStartedAtMs,
        atMs,
      });
      return;
    }

    await queueEmit({
      type: 'phase_transition',
      flowLabel: opts.flowLabel,
      fromPhaseLabel: previousPhaseLabel,
      toPhaseLabel: phaseLabel,
      fromPhaseElapsedMs: atMs - previousPhaseStartedAtMs,
      runElapsedMs: atMs - runStartedAtMs,
      atMs,
    });
  };

  return {
    startPhase: setPhase,
    transitionPhase: setPhase,
    complete: async (outcome, detail) => {
      if (disposed || terminalEmitted) return;
      terminalEmitted = true;
      clearTimer();
      const atMs = now();
      const runStart = runStartedAtMs ?? atMs;
      const phaseStart = currentPhaseStartedAtMs ?? atMs;
      await queueEmit({
        type: 'terminal',
        flowLabel: opts.flowLabel,
        phaseLabel: currentPhaseLabel,
        phaseElapsedMs: atMs - phaseStart,
        runElapsedMs: atMs - runStart,
        outcome,
        detail,
        atMs,
      });
      currentPhaseLabel = null;
      currentPhaseStartedAtMs = null;
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
    getPolicy: () => ({ ...policy }),
  };
}
