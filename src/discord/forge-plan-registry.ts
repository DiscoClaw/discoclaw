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
// Forge-completion gate — callers can await the end of an active forge run
// before invoking the chat runtime, preventing empty responses due to
// resource contention between forge and chat runtime invocations.
// ---------------------------------------------------------------------------

let _forgeCompletionResolve: (() => void) | null = null;
let _forgeCompletionPromise: Promise<void> = Promise.resolve();

/**
 * Wait until no forge run is active. Resolves immediately if no forge is
 * running, or waits until the current forge run completes.
 */
export function waitForForgeCompletion(): Promise<void> {
  return _forgeCompletionPromise;
}

// ---------------------------------------------------------------------------
// Active forge orchestrator
// ---------------------------------------------------------------------------

let _activeOrchestrator: ForgeOrchestrator | null = null;

/** Set the active forge orchestrator (or null to clear). */
export function setActiveOrchestrator(orch: ForgeOrchestrator | null): void {
  if (orch !== null && _activeOrchestrator === null) {
    // Forge starting — arm the gate.
    _forgeCompletionPromise = new Promise<void>((resolve) => {
      _forgeCompletionResolve = resolve;
    });
  } else if (orch === null && _activeOrchestrator !== null) {
    // Forge completing — release all waiters.
    const res = _forgeCompletionResolve;
    _forgeCompletionResolve = null;
    res?.();
  }
  _activeOrchestrator = orch;
}

/** Get the active forge orchestrator, if any. */
export function getActiveOrchestrator(): ForgeOrchestrator | null {
  return _activeOrchestrator;
}

/** Returns the active forge plan ID if a forge is running, undefined otherwise. */
export function getActiveForgeId(): string | undefined {
  return _activeOrchestrator?.activePlanId;
}

// ---------------------------------------------------------------------------
// Running plan IDs — tracks which plans have active phase runs.
// ---------------------------------------------------------------------------

const _runningPlanIds = new Set<string>();

/** Mark a plan as having an active phase run. */
export function addRunningPlan(planId: string): void {
  _runningPlanIds.add(planId);
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
  return _runningPlanIds;
}

// ---------------------------------------------------------------------------
// Test helper — reset all state (for test isolation)
// ---------------------------------------------------------------------------

export function _resetForTest(): void {
  writerLockChain = Promise.resolve();
  _activeOrchestrator = null;
  _runningPlanIds.clear();
  _forgeCompletionResolve?.();
  _forgeCompletionResolve = null;
  _forgeCompletionPromise = Promise.resolve();
}
