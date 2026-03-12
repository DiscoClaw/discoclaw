import { describe, expect, it, beforeEach } from 'vitest';
import {
  acquireWriterLock,
  setActiveOrchestrator,
  getActiveOrchestrator,
  getActiveForgeId,
  getActiveForgeChannelId,
  isForgeInChannel,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
  getRunningPlanIds,
  getForgeStatusSummary,
  isRunActiveInChannel,
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

  it('stores channelId when provided', () => {
    const fake = { activePlanId: 'plan-001', isRunning: true } as any;
    setActiveOrchestrator(fake, 'channel-123');
    expect(getActiveForgeChannelId()).toBe('channel-123');
  });

  it('clears channelId when orchestrator is set to null', () => {
    const fake = { activePlanId: 'plan-001', isRunning: true } as any;
    setActiveOrchestrator(fake, 'channel-123');
    setActiveOrchestrator(null);
    expect(getActiveForgeChannelId()).toBeUndefined();
  });

  it('returns undefined channelId when no channelId was provided', () => {
    const fake = { activePlanId: 'plan-001', isRunning: true } as any;
    setActiveOrchestrator(fake);
    expect(getActiveForgeChannelId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isForgeInChannel
// ---------------------------------------------------------------------------

describe('isForgeInChannel', () => {
  it('returns false when no orchestrator is set', () => {
    expect(isForgeInChannel('channel-123')).toBe(false);
  });

  it('returns true when forge is running in the same channel', () => {
    const fake = { isRunning: true, activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake, 'channel-123');
    expect(isForgeInChannel('channel-123')).toBe(true);
  });

  it('returns false when forge is running in a different channel', () => {
    const fake = { isRunning: true, activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake, 'channel-123');
    expect(isForgeInChannel('channel-456')).toBe(false);
  });

  it('returns true for a parent forum alias when forge was registered from a thread', () => {
    const fake = { isRunning: true, activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake, ['thread-123', 'forum-123']);
    expect(isForgeInChannel('forum-123')).toBe(true);
  });

  it('returns false when forge is not running', () => {
    const fake = { isRunning: false, activePlanId: undefined } as any;
    setActiveOrchestrator(fake, 'channel-123');
    expect(isForgeInChannel('channel-123')).toBe(false);
  });

  it('returns false when forge has no channel info', () => {
    const fake = { isRunning: true, activePlanId: 'plan-001' } as any;
    setActiveOrchestrator(fake);
    expect(isForgeInChannel('channel-123')).toBe(false);
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
    addRunningPlan('plan-001', 'ch-1');
    expect(isPlanRunning('plan-001')).toBe(true);
    expect(isPlanRunning('plan-002')).toBe(false);
    expect(getRunningPlanIds().size).toBe(1);
  });

  it('remove', () => {
    addRunningPlan('plan-001', 'ch-1');
    removeRunningPlan('plan-001');
    expect(isPlanRunning('plan-001')).toBe(false);
    expect(getRunningPlanIds().size).toBe(0);
  });

  it('remove non-existent is a no-op', () => {
    removeRunningPlan('plan-999');
    expect(getRunningPlanIds().size).toBe(0);
  });

  it('tracks multiple plans', () => {
    addRunningPlan('plan-001', 'ch-1');
    addRunningPlan('plan-002', 'ch-2');
    expect(isPlanRunning('plan-001')).toBe(true);
    expect(isPlanRunning('plan-002')).toBe(true);
    expect(getRunningPlanIds().size).toBe(2);

    removeRunningPlan('plan-001');
    expect(isPlanRunning('plan-001')).toBe(false);
    expect(isPlanRunning('plan-002')).toBe(true);
  });

  it('duplicate add is idempotent', () => {
    addRunningPlan('plan-001', 'ch-1');
    addRunningPlan('plan-001', 'ch-1');
    expect(getRunningPlanIds().size).toBe(1);
  });

  it('tracks both thread and parent forum aliases for a running plan', () => {
    addRunningPlan('plan-001', ['thread-123', 'forum-123']);
    expect(isRunActiveInChannel('thread-123')).toBe(true);
    expect(isRunActiveInChannel('forum-123')).toBe(true);
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
    addRunningPlan('plan-042', 'ch-1');
    addRunningPlan('plan-305', 'ch-2');
    const summary = getForgeStatusSummary();
    expect(summary).toContain('No forge is currently running.');
    expect(summary).toContain('plan-042');
    expect(summary).toContain('plan-305');
  });

  it('reports both forge and plan runs when both are active', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-007' } as any);
    addRunningPlan('plan-099', 'ch-1');
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
// isRunActiveInChannel
// ---------------------------------------------------------------------------

describe('isRunActiveInChannel', () => {
  it('returns false when nothing is active', () => {
    expect(isRunActiveInChannel('ch-1')).toBe(false);
  });

  it('returns true when a forge is active in the channel', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-001' } as any, 'ch-1');
    expect(isRunActiveInChannel('ch-1')).toBe(true);
    expect(isRunActiveInChannel('ch-2')).toBe(false);
  });

  it('returns true when a plan run is active in the channel', () => {
    addRunningPlan('plan-001', 'ch-1');
    expect(isRunActiveInChannel('ch-1')).toBe(true);
    expect(isRunActiveInChannel('ch-2')).toBe(false);
  });

  it('returns true when both forge and plan run are in the channel', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-001' } as any, 'ch-1');
    addRunningPlan('plan-002', 'ch-1');
    expect(isRunActiveInChannel('ch-1')).toBe(true);
  });

  it('returns true when a thread-registered forge or plan run is queried via the parent forum channel', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-001' } as any, ['thread-1', 'forum-1']);
    addRunningPlan('plan-002', ['thread-2', 'forum-1']);
    expect(isRunActiveInChannel('forum-1')).toBe(true);
  });

  it('returns true for channel with plan run even if forge is in different channel', () => {
    setActiveOrchestrator({ isRunning: true, activePlanId: 'plan-001' } as any, 'ch-1');
    addRunningPlan('plan-002', 'ch-2');
    expect(isRunActiveInChannel('ch-1')).toBe(true);
    expect(isRunActiveInChannel('ch-2')).toBe(true);
    expect(isRunActiveInChannel('ch-3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('_resetForTest', () => {
  it('clears all state', async () => {
    setActiveOrchestrator({ activePlanId: 'plan-001', isRunning: true } as any, 'channel-789');
    addRunningPlan('plan-002', 'ch-1');

    // Acquire a lock and don't release — reset should clear the chain
    await acquireWriterLock();

    _resetForTest();

    expect(getActiveOrchestrator()).toBeNull();
    expect(getActiveForgeChannelId()).toBeUndefined();
    expect(isPlanRunning('plan-002')).toBe(false);

    // Lock should be acquirable after reset (not stuck behind unreleased previous lock)
    const r = await acquireWriterLock();
    r();
  });
});
