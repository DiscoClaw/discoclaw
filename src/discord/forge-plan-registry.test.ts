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
  getForgeStatusSummary,
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
// getForgeStatusSummary
// ---------------------------------------------------------------------------

describe('getForgeStatusSummary', () => {
  it('reports no forge and no plan runs', () => {
    expect(getForgeStatusSummary()).toBe('No forge is currently running.');
  });

  it('reports active forge with plan ID and no plan runs', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-001' } as any);
    expect(getForgeStatusSummary()).toBe('Forge is running: plan-001.');
  });

  it('reports active forge without plan ID', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: undefined } as any);
    expect(getForgeStatusSummary()).toBe('Forge is running.');
  });

  it('reports plan runs when no forge is running', () => {
    addRunningPlan('plan-042');
    addRunningPlan('plan-305');
    const summary = getForgeStatusSummary();
    expect(summary).toContain('No forge is currently running.');
    expect(summary).toContain('plan-042');
    expect(summary).toContain('plan-305');
  });

  it('reports both forge and plan runs when both are active', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-007' } as any);
    addRunningPlan('plan-099');
    const summary = getForgeStatusSummary();
    expect(summary).toContain('Forge is running: plan-007.');
    expect(summary).toContain('plan-099');
  });

  it('does not report plan runs suffix when none are active', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-007' } as any);
    expect(getForgeStatusSummary()).toBe('Forge is running: plan-007.');
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
