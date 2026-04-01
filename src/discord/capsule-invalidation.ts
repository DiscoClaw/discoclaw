import type { ContinuationCapsule } from './capsule.js';

/**
 * Default TTL for continuation capsules: 2 hours.
 * If the parent summary's updatedAt is older than this, the capsule is
 * considered stale and should not be injected.
 */
export const DEFAULT_CAPSULE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Patterns in `currentFocus` that indicate the capsule carries no useful
 * state — the assistant was idle, awaiting input, or had no active task.
 */
const IDLE_FOCUS_PATTERNS: RegExp[] = [
  /^idle$/i,
  /^none$/i,
  /^awaiting\b/i,
  /^waiting\b/i,
  /^no active task/i,
  /^n\/a$/i,
  /^\(none\)$/i,
  /^\(idle\)$/i,
  /^\(awaiting\b/i,
];

/**
 * Returns true when the capsule's `currentFocus` matches an idle/no-state
 * pattern, meaning the capsule should not be injected.
 */
export function isCapsuleIdle(capsule: ContinuationCapsule): boolean {
  const focus = capsule.currentFocus.trim();
  return IDLE_FOCUS_PATTERNS.some(pattern => pattern.test(focus));
}

/**
 * Returns true when the parent summary's `updatedAt` exceeds the staleness
 * threshold relative to `now`.
 */
export function isCapsuleExpired(
  updatedAt: number,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_CAPSULE_TTL_MS,
): boolean {
  if (ttlMs <= 0) return false;
  return now - updatedAt > ttlMs;
}

export type CapsuleValidationResult = {
  valid: boolean;
  reason?: 'idle' | 'expired';
};

/**
 * Combined check: returns whether a capsule should be injected into
 * the conversation prompt. Both idle detection and TTL expiry are
 * evaluated; idle is checked first (cheaper).
 */
export function validateCapsuleForInjection(
  capsule: ContinuationCapsule,
  updatedAt: number,
  opts?: { now?: number; ttlMs?: number },
): CapsuleValidationResult {
  if (isCapsuleIdle(capsule)) {
    return { valid: false, reason: 'idle' };
  }
  if (isCapsuleExpired(updatedAt, opts?.now, opts?.ttlMs)) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}
