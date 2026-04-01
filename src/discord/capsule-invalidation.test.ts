import { describe, expect, it } from 'vitest';
import type { ContinuationCapsule } from './capsule.js';
import {
  DEFAULT_CAPSULE_TTL_MS,
  isCapsuleIdle,
  isCapsuleExpired,
  validateCapsuleForInjection,
} from './capsule-invalidation.js';

function makeCapsule(currentFocus: string): ContinuationCapsule {
  return { currentFocus, nextStep: 'do something' };
}

describe('isCapsuleIdle', () => {
  it.each([
    'idle',
    'Idle',
    'IDLE',
    'none',
    'None',
    'NONE',
    'awaiting input',
    'Awaiting user response',
    'waiting for user',
    'Waiting on feedback',
    'no active task',
    'No active task right now',
    'n/a',
    'N/A',
    '(none)',
    '(None)',
    '(idle)',
    '(Idle)',
    '(awaiting input)',
    '(Awaiting response)',
  ])('returns true for idle focus: %s', (focus) => {
    expect(isCapsuleIdle(makeCapsule(focus))).toBe(true);
  });

  it.each([
    'Implement feature X',
    'Debugging the parser',
    'idling is not the same',
    'nonetheless important',
  ])('returns false for active focus: %s', (focus) => {
    expect(isCapsuleIdle(makeCapsule(focus))).toBe(false);
  });

  it('trims whitespace before matching', () => {
    expect(isCapsuleIdle(makeCapsule('  idle  '))).toBe(true);
    expect(isCapsuleIdle(makeCapsule('  none  '))).toBe(true);
  });
});

describe('isCapsuleExpired', () => {
  it('returns false when within TTL', () => {
    const now = Date.now();
    const updatedAt = now - (DEFAULT_CAPSULE_TTL_MS - 1000);
    expect(isCapsuleExpired(updatedAt, now)).toBe(false);
  });

  it('returns true when past default TTL', () => {
    const now = Date.now();
    const updatedAt = now - DEFAULT_CAPSULE_TTL_MS - 1;
    expect(isCapsuleExpired(updatedAt, now)).toBe(true);
  });

  it('returns false at exactly the TTL boundary', () => {
    const now = Date.now();
    const updatedAt = now - DEFAULT_CAPSULE_TTL_MS;
    expect(isCapsuleExpired(updatedAt, now)).toBe(false);
  });

  it('respects a custom ttlMs', () => {
    const now = 100_000;
    expect(isCapsuleExpired(90_000, now, 5_000)).toBe(true);  // 10s > 5s TTL
    expect(isCapsuleExpired(96_000, now, 5_000)).toBe(false); // 4s < 5s TTL
  });

  it('DEFAULT_CAPSULE_TTL_MS is 2 hours', () => {
    expect(DEFAULT_CAPSULE_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe('validateCapsuleForInjection', () => {
  const now = 1_000_000;
  const freshUpdatedAt = now - 60_000; // 1 minute ago

  it('returns valid for active, fresh capsule', () => {
    const capsule = makeCapsule('Implementing feature X');
    const result = validateCapsuleForInjection(capsule, freshUpdatedAt, { now });
    expect(result).toEqual({ valid: true });
  });

  it('returns idle reason for idle capsule', () => {
    const capsule = makeCapsule('idle');
    const result = validateCapsuleForInjection(capsule, freshUpdatedAt, { now });
    expect(result).toEqual({ valid: false, reason: 'idle' });
  });

  it('returns expired reason for stale capsule', () => {
    const capsule = makeCapsule('Implementing feature X');
    const staleUpdatedAt = now - DEFAULT_CAPSULE_TTL_MS - 1;
    const result = validateCapsuleForInjection(capsule, staleUpdatedAt, { now });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('idle takes precedence over expired', () => {
    const capsule = makeCapsule('none');
    const staleUpdatedAt = now - DEFAULT_CAPSULE_TTL_MS - 1;
    const result = validateCapsuleForInjection(capsule, staleUpdatedAt, { now });
    expect(result).toEqual({ valid: false, reason: 'idle' });
  });

  it('respects custom ttlMs via opts', () => {
    const capsule = makeCapsule('Working on task');
    const updatedAt = now - 10_000; // 10s ago
    const result = validateCapsuleForInjection(capsule, updatedAt, { now, ttlMs: 5_000 });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });
});
