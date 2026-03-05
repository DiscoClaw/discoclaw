import type { ForgeOrchestrator } from './forge-commands.js';

// ---------------------------------------------------------------------------
// Shared forge/plan lifecycle state
// ---------------------------------------------------------------------------
//
// Centralizes the orchestrator reference, running plan IDs, and workspace
// writer lock that were previously scattered across discord.ts module-level
// variables. Both human `!` commands and action-initiated forge/plan/memory
// operations coordinate through this registry.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace writer lock — serializes forge creates, plan phase runs, and
// memory mutations that touch the workspace filesystem.
// ---------------------------------------------------------------------------

let writerLockChain: Promise<void> = Promise.resolve();

/**
 * Acquire the workspace writer lock. Returns a release function.
 * Callers must call `release()` when done, ideally in a finally block.
 */
export function acquireWriterLock(): Promise<() => void> {
  let release!: () => void;
  const prev = writerLockChain;
  writerLockChain = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => release);
}

// ---------------------------------------------------------------------------
// Active forge orchestrator
// ---------------------------------------------------------------------------

let _activeOrchestrator: ForgeOrchestrator | null = null;
let _activeForgeChannelId: string | undefined;

/** Set the active forge orchestrator (or null to clear). */
export function setActiveOrchestrator(orch: ForgeOrchestrator | null, channelId?: string): void {
  _activeOrchestrator = orch;
  _activeForgeChannelId = orch ? channelId : undefined;
}

/** Get the active forge orchestrator, if any. */
export function getActiveOrchestrator(): ForgeOrchestrator | null {
  return _activeOrchestrator;
}

/** Returns the active forge plan ID if a forge is running, undefined otherwise. */
export function getActiveForgeId(): string | undefined {
  return _activeOrchestrator?.activePlanId;
}

/** Returns the channel ID where the active forge is running, if known. */
export function getActiveForgeChannelId(): string | undefined {
  return _activeOrchestrator ? _activeForgeChannelId : undefined;
}

/**
 * Check whether the active forge is running in the given channel.
 * Returns true when a forge is running AND its channel matches.
 * Returns false when no forge is running, the forge has no channel info, or the channel doesn't match.
 */
export function isForgeInChannel(channelId: string): boolean {
  return _activeOrchestrator?.isRunning === true && _activeForgeChannelId === channelId;
}

// ---------------------------------------------------------------------------
// Running plan IDs — tracks which plans have active phase runs.
// ---------------------------------------------------------------------------

const _runningPlanIds = new Map<string, string>();

/** Mark a plan as having an active phase run, associated with a channel/thread. */
export function addRunningPlan(planId: string, channelId: string): void {
  _runningPlanIds.set(planId, channelId);
}

/** Remove a plan from the active runs set. */
export function removeRunningPlan(planId: string): void {
  _runningPlanIds.delete(planId);
}

/** Check if a plan has an active phase run. */
export function isPlanRunning(planId: string): boolean {
  return _runningPlanIds.has(planId);
}

/** Get all currently running plan IDs (snapshot). */
export function getRunningPlanIds(): ReadonlySet<string> {
  return new Set(_runningPlanIds.keys());
}

/**
 * Check whether a forge or plan run is active in the given channel.
 * Returns true if a forge is active in the channel (via isForgeInChannel)
 * OR any running plan in the Map is mapped to that channel.
 */
export function isRunActiveInChannel(channelId: string): boolean {
  if (isForgeInChannel(channelId)) return true;
  for (const ch of _runningPlanIds.values()) {
    if (ch === channelId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Combined status summary
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable status summary combining the active forge
 * orchestrator state with any running plan phase IDs. Used by the
 * forgeStatus action so both sources of activity are always reported
 * together, even when no forge orchestrator is running but a plan phase
 * is actively executing via planRun.
 */
export function getForgeStatusSummary(): string {
  const planRunsSuffix = _runningPlanIds.size > 0
    ? ` Plan runs active: ${[..._runningPlanIds.keys()].join(', ')}.`
    : '';
  if (_activeOrchestrator?.isRunning) {
    const activeId = _activeOrchestrator.activePlanId;
    return `Forge is running${activeId ? `: ${activeId}` : ''}.${planRunsSuffix}`;
  }
  return `No forge is currently running.${planRunsSuffix}`;
}

// ---------------------------------------------------------------------------
// Test helper — reset all state (for test isolation)
// ---------------------------------------------------------------------------

export function _resetForTest(): void {
  writerLockChain = Promise.resolve();
  _activeOrchestrator = null;
  _activeForgeChannelId = undefined;
  _runningPlanIds.clear();
}
