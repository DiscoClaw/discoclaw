// In-memory registry mapping Discord message IDs to AbortController instances.
// Supports a short-lived cooldown window after disposal so that stale 🛑 taps
// on recently-finished messages are silently consumed rather than forwarded.

const COOLDOWN_MS = 15_000;

const active = new Map<string, AbortController>();
const cooldown = new Set<string>();

// ---------------------------------------------------------------------------
// Abort metadata — tracks context about active streams for stop summaries
// ---------------------------------------------------------------------------

export type AbortMeta = {
  channelId: string;
  userMessage: string;
  startedAt: number;
  /** Callback to snapshot current partial response text. */
  getPartialResponse: () => string;
  /** Callback to snapshot current activity label. */
  getActivityLabel: () => string;
  sessionKey: string;
};

export type AbortSnapshot = {
  messageId: string;
  channelId: string;
  userMessage: string;
  partialResponse: string;
  activityLabel: string;
  sessionKey: string;
  elapsedMs: number;
};

const metaStore = new Map<string, AbortMeta>();

/** Attach metadata to an active abort entry for stop summary generation. */
export function setAbortMeta(messageId: string, m: AbortMeta): void {
  metaStore.set(messageId, m);
}

/** Remove metadata for a message (called alongside dispose). */
export function clearAbortMeta(messageId: string): void {
  metaStore.delete(messageId);
}

/** Snapshot the metadata for a single active stream. Returns null if not found. */
export function snapshotAbort(messageId: string): AbortSnapshot | null {
  const m = metaStore.get(messageId);
  if (!m) return null;
  return {
    messageId,
    channelId: m.channelId,
    userMessage: m.userMessage,
    partialResponse: m.getPartialResponse(),
    activityLabel: m.getActivityLabel(),
    sessionKey: m.sessionKey,
    elapsedMs: Date.now() - m.startedAt,
  };
}

/** Snapshot metadata for all actively streaming entries. */
export function snapshotAllAborts(): AbortSnapshot[] {
  const snapshots: AbortSnapshot[] = [];
  for (const messageId of active.keys()) {
    const snap = snapshotAbort(messageId);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Core abort registry
// ---------------------------------------------------------------------------

/**
 * Register an AbortController for a message that is about to start streaming.
 *
 * Returns:
 * - `signal` — pass to RuntimeInvokeParams.signal
 * - `dispose` — call when the stream ends; moves the entry into a cooldown
 *   set so that a belated 🛑 tap is silently consumed for ~15 s.
 */
export function registerAbort(messageId: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  active.set(messageId, controller);

  function dispose() {
    active.delete(messageId);
    metaStore.delete(messageId);
    cooldown.add(messageId);
    setTimeout(() => cooldown.delete(messageId), COOLDOWN_MS);
  }

  return { signal: controller.signal, dispose };
}

/**
 * Attempt to abort the stream for a message.
 *
 * Returns:
 * - `true` and fires `abort()` if the message is actively streaming.
 * - `true` (no-op) if the message is in the cooldown window (already finished).
 * - `false` if the message ID is unknown — caller should let the reaction through.
 */
export function tryAbort(messageId: string): boolean {
  const controller = active.get(messageId);
  if (controller) {
    controller.abort();
    return true;
  }
  if (cooldown.has(messageId)) {
    return true;
  }
  return false;
}

/**
 * Returns true if the message is actively streaming (abort not yet fired).
 * Use this to distinguish an active abort from a cooldown no-op before calling tryAbort.
 */
export function isActivelyStreaming(messageId: string): boolean {
  return active.has(messageId);
}

/**
 * Abort all active streams.
 *
 * Returns the number of streams that were actively streaming and aborted.
 * Does not modify the active/cooldown sets — each stream's `dispose()` call
 * (in its finally block) handles cleanup and cooldown the same way as a
 * single-message abort via `tryAbort`.
 */
export function tryAbortAll(): number {
  const controllers = [...active.values()];
  for (const controller of controllers) {
    controller.abort();
  }
  return controllers.length;
}

/** Clear all state. Only for use in tests. */
export function _resetForTest(): void {
  active.clear();
  cooldown.clear();
  metaStore.clear();
}
