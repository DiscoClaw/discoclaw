import path from 'node:path';
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

export type ForgeTurnPhase =
  | 'draft_research'
  | 'draft_artifact'
  | 'audit'
  | 'revision_research'
  | 'revision_artifact';

export type ForgeTurnRoute = 'native' | 'hybrid' | 'cli';

export type ForgePlanFallbackMode = 're_research' | 'reject';

export type ForgePlanPhaseState = {
  currentPhase: ForgeTurnPhase;
  researchComplete: boolean;
};

export type ForgePlanCandidateBounds = {
  candidatePaths: string[];
  allowlistPaths: string[];
};

export type ForgePlanFallbackPolicy = {
  onOutOfBounds: ForgePlanFallbackMode;
  reResearchPhase: ForgeTurnPhase | null;
};

export type ForgePlanMetadataCompatibility = 'current' | 'legacy_incomplete';

export type ForgePlanMetadata = {
  phaseState: ForgePlanPhaseState;
  candidateBounds: ForgePlanCandidateBounds;
  fallbackPolicy: ForgePlanFallbackPolicy;
  compatibility: ForgePlanMetadataCompatibility;
  requiresFreshResearch: boolean;
};

export type ForgePlanMetadataInput = {
  phaseState?: Partial<ForgePlanPhaseState> | null;
  candidateBounds?: Partial<{
    candidatePaths: readonly string[] | null;
    allowlistPaths: readonly string[] | null;
  }> | null;
  fallbackPolicy?: Partial<ForgePlanFallbackPolicy> | null;
};

export type ForgePlanPhaseGate = {
  requestedPhase: ForgeTurnPhase;
  nextPhase: ForgeTurnPhase;
  route: ForgeTurnRoute;
  researchComplete: boolean;
  candidatePaths: string[];
  allowlistPaths: string[];
  fallbackPolicy: ForgePlanFallbackPolicy;
  compatibility: ForgePlanMetadataCompatibility;
  requiresFreshResearch: boolean;
  reason?: string;
};

type StoredForgePlanMetadata = {
  phaseState?: Partial<ForgePlanPhaseState>;
  candidateBounds?: Partial<{
    candidatePaths: readonly string[] | null;
    allowlistPaths: readonly string[] | null;
  }>;
  fallbackPolicy?: Partial<ForgePlanFallbackPolicy>;
};

const FORGE_PHASES = new Set<ForgeTurnPhase>([
  'draft_research',
  'draft_artifact',
  'audit',
  'revision_research',
  'revision_artifact',
]);

const _planMetadata = new Map<string, StoredForgePlanMetadata>();

let writerLockChain: Promise<void> = Promise.resolve();

function isForgeTurnPhase(value: unknown): value is ForgeTurnPhase {
  return typeof value === 'string' && FORGE_PHASES.has(value as ForgeTurnPhase);
}

function isForgePlanFallbackMode(value: unknown): value is ForgePlanFallbackMode {
  return value === 're_research' || value === 'reject';
}

export function isForgeResearchPhase(phase: ForgeTurnPhase): boolean {
  return phase === 'draft_research' || phase === 'revision_research';
}

export function isForgeFinalArtifactPhase(phase: ForgeTurnPhase): boolean {
  return phase === 'draft_artifact' || phase === 'revision_artifact';
}

export function resolveForgeTurnRoute(phase: ForgeTurnPhase): ForgeTurnRoute {
  if (phase === 'draft_research' || phase === 'revision_research') return 'native';
  if (phase === 'audit') return 'hybrid';
  return 'cli';
}

function resolveForgeReResearchPhase(phase: ForgeTurnPhase): ForgeTurnPhase | null {
  switch (phase) {
    case 'draft_artifact':
      return 'draft_research';
    case 'audit':
    case 'revision_artifact':
      return 'revision_research';
    default:
      return null;
  }
}

function resolveCompatibilityResearchPhase(phase: ForgeTurnPhase): ForgeTurnPhase {
  return phase === 'draft_research' || phase === 'draft_artifact'
    ? 'draft_research'
    : 'revision_research';
}

function normalizeForgeCandidatePath(candidatePath: string): string | null {
  const trimmed = candidatePath.trim();
  if (!trimmed) return null;
  const unwrapped = trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  if (!unwrapped) return null;
  const slashNormalized = unwrapped.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(slashNormalized)) return null;
  const normalized = path.posix.normalize(slashNormalized).replace(/^(\.\/)+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeForgeCandidatePathList(
  candidatePaths: readonly string[] | null | undefined,
): string[] {
  if (!candidatePaths?.length) return [];
  const normalized = new Set<string>();
  for (const candidatePath of candidatePaths) {
    const next = normalizeForgeCandidatePath(candidatePath);
    if (next) normalized.add(next);
  }
  return [...normalized];
}

function mergeStoredSection<T extends object>(
  previous: Partial<T> | undefined,
  next: Partial<T> | null | undefined,
): Partial<T> | undefined {
  if (next === null) return undefined;
  if (next === undefined) return previous;
  return { ...(previous ?? {}), ...next };
}

function hasCompleteFallbackPolicy(
  value: Partial<ForgePlanFallbackPolicy> | undefined,
): value is ForgePlanFallbackPolicy {
  if (!value || !isForgePlanFallbackMode(value.onOutOfBounds)) return false;
  if (value.onOutOfBounds === 'reject') {
    return value.reResearchPhase === null || value.reResearchPhase === undefined;
  }
  return isForgeTurnPhase(value.reResearchPhase);
}

function resolveDefaultFallbackPolicy(phase: ForgeTurnPhase): ForgePlanFallbackPolicy {
  const reResearchPhase = resolveForgeReResearchPhase(phase);
  return reResearchPhase
    ? { onOutOfBounds: 're_research', reResearchPhase }
    : { onOutOfBounds: 'reject', reResearchPhase: null };
}

function normalizeForgePlanMetadata(
  stored: StoredForgePlanMetadata | undefined,
  requestedPhase?: ForgeTurnPhase,
): ForgePlanMetadata {
  const storedPhase = isForgeTurnPhase(stored?.phaseState?.currentPhase)
    ? stored.phaseState.currentPhase
    : undefined;
  const phaseForGate = requestedPhase ?? storedPhase ?? 'draft_research';
  const compatibilityPhase = resolveCompatibilityResearchPhase(phaseForGate);
  const hasCompletePhaseState = !!storedPhase && typeof stored?.phaseState?.researchComplete === 'boolean';
  const hasCompleteBounds = Array.isArray(stored?.candidateBounds?.candidatePaths)
    && Array.isArray(stored?.candidateBounds?.allowlistPaths);
  const storedFallbackPolicy = stored?.fallbackPolicy;
  const hasFallbackPolicy = hasCompleteFallbackPolicy(storedFallbackPolicy);
  const compatibility: ForgePlanMetadataCompatibility = hasCompletePhaseState && hasCompleteBounds && hasFallbackPolicy
    ? 'current'
    : 'legacy_incomplete';
  const candidateBounds = {
    candidatePaths: normalizeForgeCandidatePathList(stored?.candidateBounds?.candidatePaths),
    allowlistPaths: normalizeForgeCandidatePathList(stored?.candidateBounds?.allowlistPaths),
  };
  const phaseState = {
    currentPhase: compatibility === 'current' && storedPhase ? storedPhase : compatibilityPhase,
    researchComplete: compatibility === 'current' && stored?.phaseState?.researchComplete === true,
  };
  const fallbackPolicy = compatibility === 'current' && hasFallbackPolicy
    ? storedFallbackPolicy
    : resolveDefaultFallbackPolicy(phaseState.currentPhase);
  const requiresFreshResearch = !isForgeResearchPhase(phaseForGate)
    && (
      compatibility !== 'current'
      || !phaseState.researchComplete
      || candidateBounds.allowlistPaths.length === 0
    );

  return {
    phaseState,
    candidateBounds,
    fallbackPolicy,
    compatibility,
    requiresFreshResearch,
  };
}

export function setForgePlanMetadata(planId: string, metadata: ForgePlanMetadataInput): ForgePlanMetadata {
  const previous = _planMetadata.get(planId);
  const next: StoredForgePlanMetadata = {
    phaseState: mergeStoredSection(previous?.phaseState, metadata.phaseState),
    candidateBounds: mergeStoredSection(previous?.candidateBounds, metadata.candidateBounds),
    fallbackPolicy: mergeStoredSection(previous?.fallbackPolicy, metadata.fallbackPolicy),
  };
  _planMetadata.set(planId, next);
  return normalizeForgePlanMetadata(next);
}

export function getForgePlanMetadata(
  planId: string,
  opts?: { requestedPhase?: ForgeTurnPhase },
): ForgePlanMetadata {
  return normalizeForgePlanMetadata(_planMetadata.get(planId), opts?.requestedPhase);
}

export function clearForgePlanMetadata(planId: string): void {
  _planMetadata.delete(planId);
}

export function resolveForgePlanPhaseGate(planId: string, requestedPhase: ForgeTurnPhase): ForgePlanPhaseGate {
  const metadata = getForgePlanMetadata(planId, { requestedPhase });
  if (isForgeResearchPhase(requestedPhase)) {
    return {
      requestedPhase,
      nextPhase: requestedPhase,
      route: resolveForgeTurnRoute(requestedPhase),
      researchComplete: metadata.phaseState.researchComplete,
      candidatePaths: metadata.candidateBounds.candidatePaths,
      allowlistPaths: metadata.candidateBounds.allowlistPaths,
      fallbackPolicy: metadata.fallbackPolicy,
      compatibility: metadata.compatibility,
      requiresFreshResearch: false,
    };
  }

  if (!metadata.requiresFreshResearch) {
    return {
      requestedPhase,
      nextPhase: requestedPhase,
      route: resolveForgeTurnRoute(requestedPhase),
      researchComplete: metadata.phaseState.researchComplete,
      candidatePaths: metadata.candidateBounds.candidatePaths,
      allowlistPaths: metadata.candidateBounds.allowlistPaths,
      fallbackPolicy: metadata.fallbackPolicy,
      compatibility: metadata.compatibility,
      requiresFreshResearch: false,
    };
  }

  const nextPhase = metadata.fallbackPolicy.reResearchPhase ?? resolveCompatibilityResearchPhase(requestedPhase);
  return {
    requestedPhase,
    nextPhase,
    route: resolveForgeTurnRoute(nextPhase),
    researchComplete: false,
    candidatePaths: metadata.candidateBounds.candidatePaths,
    allowlistPaths: metadata.candidateBounds.allowlistPaths,
    fallbackPolicy: metadata.fallbackPolicy,
    compatibility: metadata.compatibility,
    requiresFreshResearch: true,
    reason: `Stored forge metadata is legacy, partial, or unbounded. Re-enter ${nextPhase} before ${requestedPhase}.`,
  };
}

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
let _activeForgeChannelIds = new Set<string>();

type ActiveChannelIdInput = string | Iterable<string | null | undefined> | null | undefined;

function normalizeChannelIds(input: ActiveChannelIdInput): string[] {
  const values = typeof input === 'string'
    ? [input]
    : input
      ? Array.from(input)
      : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Set the active forge orchestrator (or null to clear). */
export function setActiveOrchestrator(orch: ForgeOrchestrator | null, channelIds?: ActiveChannelIdInput): void {
  _activeOrchestrator = orch;
  if (!orch) {
    _activeForgeChannelId = undefined;
    _activeForgeChannelIds = new Set();
    return;
  }

  const normalized = normalizeChannelIds(channelIds);
  _activeForgeChannelIds = new Set(normalized);
  _activeForgeChannelId = normalized[0];
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
  return _activeOrchestrator?.isRunning === true && _activeForgeChannelIds.has(channelId);
}

// ---------------------------------------------------------------------------
// Running plan IDs — tracks which plans have active phase runs.
// ---------------------------------------------------------------------------

const _runningPlanIds = new Map<string, string[]>();

/** Mark a plan as having an active phase run, associated with a channel/thread. */
export function addRunningPlan(planId: string, channelIds: ActiveChannelIdInput): void {
  const normalized = normalizeChannelIds(channelIds);
  if (normalized.length === 0) return;
  _runningPlanIds.set(planId, normalized);
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
  for (const channelIds of _runningPlanIds.values()) {
    if (channelIds.includes(channelId)) return true;
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
  _activeForgeChannelIds.clear();
  _runningPlanIds.clear();
  _planMetadata.clear();
}
