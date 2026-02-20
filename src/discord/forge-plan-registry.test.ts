import { describe, expect, it, beforeEach } from 'vitest';
import {
  acquireWriterLock,
  setActiveOrchestrator,
  getActiveOrchestrator,
  getActiveForgeId,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
  getRunningPlanIds,
  waitForForgeCompletion,
  _resetForTest,
} from './forge-plan-registry.js';

beforeEach(() => {
  _resetForTest();
});

// ---------------------------------------------------------------------------
// Writer lock
// ---------------------------------------------------------------------------

describe('acquireWriterLock', () => {
  it('serializes concurrent acquires', async () => {
    const order: number[] = [];

    const r1 = await acquireWriterLock();
    const p2 = acquireWriterLock().then((r2) => {
      order.push(2);
      r2();
    });

    // r1 is held, so p2 should not have resolved yet
    await Promise.resolve(); // flush microtasks
    expect(order).toEqual([]);

    order.push(1);
    r1(); // release first lock

    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('works for sequential acquire-release cycles', async () => {
    const r1 = await acquireWriterLock();
    r1();

    const r2 = await acquireWriterLock();
    r2();

    // No deadlock — if we got here, it works
    expect(true).toBe(true);
  });

  it('chains three acquires in order', async () => {
    const order: number[] = [];

    const r1 = await acquireWriterLock();
    const p2 = acquireWriterLock().then((r) => { order.push(2); r(); });
    const p3 = acquireWriterLock().then((r) => { order.push(3); r(); });

    order.push(1);
    r1();

    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Active forge orchestrator
// ---------------------------------------------------------------------------

describe('active orchestrator', () => {
  it('starts as null', () => {
    expect(getActiveOrchestrator()).toBeNull();
    expect(getActiveForgeId()).toBeUndefined();
  });

  it('set and get', () => {
    const fake = { activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);
    expect(getActiveOrchestrator()).toBe(fake);
    expect(getActiveForgeId()).toBe('plan-001');
  });

  it('clear', () => {
    const fake = { activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);
    setActiveOrchestrator(null);
    expect(getActiveOrchestrator()).toBeNull();
    expect(getActiveForgeId()).toBeUndefined();
  });

  it('returns undefined when orchestrator has no activePlanId', () => {
    const fake = { activePlanId: undefined } as any;
    setActiveOrchestrator(fake);
    expect(getActiveForgeId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Running plan IDs
// ---------------------------------------------------------------------------

describe('running plan IDs', () => {
  it('starts empty', () => {
    expect(isPlanRunning('plan-001')).toBe(false);
    expect(getRunningPlanIds().size).toBe(0);
  });

  it('add and check', () => {
    addRunningPlan('plan-001');
    expect(isPlanRunning('plan-001')).toBe(true);
    expect(isPlanRunning('plan-002')).toBe(false);
    expect(getRunningPlanIds().size).toBe(1);
  });

  it('remove', () => {
    addRunningPlan('plan-001');
    removeRunningPlan('plan-001');
    expect(isPlanRunning('plan-001')).toBe(false);
    expect(getRunningPlanIds().size).toBe(0);
  });

  it('remove non-existent is a no-op', () => {
    removeRunningPlan('plan-999');
    expect(getRunningPlanIds().size).toBe(0);
  });

  it('tracks multiple plans', () => {
    addRunningPlan('plan-001');
    addRunningPlan('plan-002');
    expect(isPlanRunning('plan-001')).toBe(true);
    expect(isPlanRunning('plan-002')).toBe(true);
    expect(getRunningPlanIds().size).toBe(2);

    removeRunningPlan('plan-001');
    expect(isPlanRunning('plan-001')).toBe(false);
    expect(isPlanRunning('plan-002')).toBe(true);
  });

  it('duplicate add is idempotent', () => {
    addRunningPlan('plan-001');
    addRunningPlan('plan-001');
    expect(getRunningPlanIds().size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Forge-completion gate
// ---------------------------------------------------------------------------

describe('waitForForgeCompletion', () => {
  it('resolves immediately when no forge is active', async () => {
    await expect(waitForForgeCompletion()).resolves.toBeUndefined();
  });

  it('waits while a forge is active, resolves on setActiveOrchestrator(null)', async () => {
    const fake = { activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);

    let resolved = false;
    const wait = waitForForgeCompletion().then(() => { resolved = true; });

    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    setActiveOrchestrator(null);
    await wait;
    expect(resolved).toBe(true);
  });

  it('multiple concurrent waiters all resolve on forge completion', async () => {
    const fake = { activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);

    const order: number[] = [];
    const p1 = waitForForgeCompletion().then(() => order.push(1));
    const p2 = waitForForgeCompletion().then(() => order.push(2));

    setActiveOrchestrator(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('resolves immediately when called after forge has already completed', async () => {
    const fake = { activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);
    setActiveOrchestrator(null);

    await expect(waitForForgeCompletion()).resolves.toBeUndefined();
  });

  it('gates a second forge run independently of the first', async () => {
    const fake = { activePlanId: 'plan-001' } as any;

    // First forge run.
    setActiveOrchestrator(fake);
    setActiveOrchestrator(null);

    // Second forge run.
    setActiveOrchestrator(fake);

    let resolved = false;
    const wait = waitForForgeCompletion().then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);

    setActiveOrchestrator(null);
    await wait;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('_resetForTest', () => {
  it('clears all state', async () => {
    setActiveOrchestrator({ activePlanId: 'plan-001' } as any);
    addRunningPlan('plan-002');

    // Acquire a lock and don't release — reset should clear the chain
    await acquireWriterLock();

    _resetForTest();

    expect(getActiveOrchestrator()).toBeNull();
    expect(isPlanRunning('plan-002')).toBe(false);

    // Lock should be acquirable after reset (not stuck behind unreleased previous lock)
    const r = await acquireWriterLock();
    r();
  });
});
