import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from './actions.js';
import { DeferScheduler, type DeferSchedulerOptions } from './defer-scheduler.js';
import { executeDeferAction, executeDeferListAction, type DeferActionRequest, type DeferredRun } from './actions-defer.js';
import type { Client, Guild } from 'discord.js';

const baseContext: ActionContext = {
  guild: { id: 'guild-1' } as unknown as Guild,
  client: { token: 'dummy' } as unknown as Client,
  channelId: 'channel-1',
  messageId: 'message-1',
};

afterEach(() => {
  vi.useRealTimers();
});

function createContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    ...baseContext,
    ...overrides,
  };
}

function makeScheduler(opts?: Partial<DeferSchedulerOptions<DeferActionRequest, ActionContext>>) {
  const handler: DeferSchedulerOptions<DeferActionRequest, ActionContext>['jobHandler'] =
    opts?.jobHandler ?? vi.fn(async () => {});
  const scheduler = new DeferScheduler<DeferActionRequest, ActionContext>({
    maxDelaySeconds: opts?.maxDelaySeconds ?? 60,
    maxConcurrent: opts?.maxConcurrent ?? 2,
    jobHandler: handler,
  });
  return { scheduler, handler };
}

describe('executeDeferAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('requires scheduler configuration', async () => {
    const result = await executeDeferAction({ type: 'defer', channel: 'general', prompt: 'check', delaySeconds: 10 }, baseContext);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('defer action unexpectedly succeeded without a scheduler');
    expect(result.error).toContain('not configured');
  });

  it('validates input fields', async () => {
    const { scheduler } = makeScheduler();
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };

    await expect(executeDeferAction({ type: 'defer', channel: '', prompt: 'check', delaySeconds: 1 }, ctx)).resolves.toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('target channel') }),
    );
    await expect(executeDeferAction({ type: 'defer', channel: 'a', prompt: '', delaySeconds: 1 }, ctx)).resolves.toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('prompt') }),
    );
    await expect(executeDeferAction({ type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 0 }, ctx)).resolves.toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('greater than zero') }),
    );
  });

  it('schedules deferred run when valid and includes job id', async () => {
    const { scheduler, handler } = makeScheduler();
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };
    const action: DeferActionRequest = { type: 'defer', channel: 'general', prompt: 'report', delaySeconds: 5 };

    const result = await executeDeferAction(action, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('defer action failed when it should have succeeded');
    expect(result.summary).toContain('general');
    expect(result.summary).toContain('in 5s');
    expect(result.summary).toContain('id=');
    expect(result.summary).toContain('runs at 2025-01-01');

    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining<Partial<DeferredRun>>({
        action: expect.objectContaining({
          channel: 'general',
          prompt: 'report',
          delaySeconds: 5,
        }),
        context: ctx,
      }),
    );
  });

  it('returns rejection summaries when scheduler denies a job', async () => {
    const { scheduler } = makeScheduler({ maxDelaySeconds: 5 });
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };
    const action: DeferActionRequest = { type: 'defer', channel: 'general', prompt: 'check back', delaySeconds: 10 };

    const result = await executeDeferAction(action, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('defer action unexpectedly succeeded despite exceeding max delay');
    expect(result.error).toBe('One-shot deferred follow-up for general rejected: delaySeconds cannot exceed 5 seconds');
  });
});

describe('executeDeferListAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('requires scheduler configuration', () => {
    const result = executeDeferListAction(baseContext);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('deferList unexpectedly succeeded without a scheduler');
    expect(result.error).toContain('not configured');
  });

  it('returns empty message when no jobs are pending', () => {
    const { scheduler } = makeScheduler();
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };

    const result = executeDeferListAction(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('deferList failed unexpectedly');
    expect(result.summary).toBe('No pending one-shot deferred actions.');
  });

  it('lists pending jobs with id, channel, prompt, and time remaining', () => {
    const { scheduler } = makeScheduler();
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };

    scheduler.schedule({
      action: { type: 'defer', channel: 'general', prompt: 'check status', delaySeconds: 30 },
      context: ctx,
    });
    scheduler.schedule({
      action: { type: 'defer', channel: 'alerts', prompt: 'send report', delaySeconds: 60 },
      context: ctx,
    });

    const result = executeDeferListAction(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('deferList failed unexpectedly');
    expect(result.summary).toContain('Pending one-shot deferred actions (2)');
    expect(result.summary).toMatch(/id=\d+/);
    expect(result.summary).toContain('channel=general');
    expect(result.summary).toContain('prompt="check status"');
    expect(result.summary).toContain('remaining=30s');
    expect(result.summary).toContain('channel=alerts');
    expect(result.summary).toContain('prompt="send report"');
    expect(result.summary).toContain('remaining=1m');
  });

  it('shows decreasing time remaining as time passes', () => {
    const { scheduler } = makeScheduler();
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };

    scheduler.schedule({
      action: { type: 'defer', channel: 'general', prompt: 'ping', delaySeconds: 60 },
      context: ctx,
    });

    vi.advanceTimersByTime(45_000);

    const result = executeDeferListAction(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('deferList failed unexpectedly');
    expect(result.summary).toContain('remaining=15s');
  });

  it('excludes completed jobs from the listing', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 2 });
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };

    scheduler.schedule({
      action: { type: 'defer', channel: 'general', prompt: 'first', delaySeconds: 5 },
      context: ctx,
    });
    scheduler.schedule({
      action: { type: 'defer', channel: 'alerts', prompt: 'second', delaySeconds: 30 },
      context: ctx,
    });

    // Advance past the first job's delay
    vi.advanceTimersByTime(5000);
    await Promise.resolve();

    const result = executeDeferListAction(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('deferList failed unexpectedly');
    expect(result.summary).toContain('Pending one-shot deferred actions (1)');
    expect(result.summary).toContain('channel=alerts');
    expect(result.summary).not.toContain('channel=general');
  });
});

describe('DeferScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('enforces max delay', () => {
    const { scheduler } = makeScheduler({ maxDelaySeconds: 5 });
    const ctx = createContext();
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 10 };
    const result = scheduler.schedule({ action, context: ctx });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('schedule unexpectedly succeeded despite exceeding max delay');
    expect(result.error).toMatch(/delaySeconds cannot exceed 5/);
  });

  it('enforces concurrency cap', () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 2 };
    const first = scheduler.schedule({ action, context: ctx });
    expect(first.ok).toBe(true);
    const second = scheduler.schedule({ action: { ...action, channel: 'b' }, context: ctx });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('schedule unexpectedly succeeded despite concurrency cap');
    expect(second.error).toMatch(/Maximum of 1 deferred actions/);

    vi.advanceTimersByTime(2000);
  });

  it('releases slot after run completes', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    const ctx: ActionContext = {
      ...createContext(),
      deferScheduler: scheduler,
    };
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 1 };
    const first = scheduler.schedule({ action, context: ctx });
    expect(first.ok).toBe(true);

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const second = scheduler.schedule({ action: { ...action, channel: 'b' }, context: ctx });
    expect(second.ok).toBe(true);
  });

  it('returns a stable job id from schedule()', () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 5 });
    const ctx = createContext();
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 2 };

    const r1 = scheduler.schedule({ action, context: ctx });
    const r2 = scheduler.schedule({ action: { ...action, channel: 'b' }, context: ctx });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error('schedule failed');
    expect(r1.id).toBeTypeOf('number');
    expect(r2.id).toBeTypeOf('number');
    expect(r1.id).not.toBe(r2.id);
  });

  it('exposes job id in listActive()', () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 5 });
    const ctx = createContext();
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 2 };

    const r = scheduler.schedule({ action, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(r.id);
  });

  it('cancel() removes a pending job and prevents handler execution', async () => {
    const { scheduler, handler } = makeScheduler({ maxConcurrent: 5 });
    const ctx = createContext();
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 5 };

    const r = scheduler.schedule({ action, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    const cancelled = scheduler.cancel(r.id);
    expect(cancelled).toBe(true);
    expect(scheduler.listActive()).toHaveLength(0);

    // Timer should not fire
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancel() returns false for unknown job id', () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.cancel(999)).toBe(false);
  });

  it('cancel() frees a concurrency slot', () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    const ctx = createContext();
    const action: DeferActionRequest = { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 5 };

    const r = scheduler.schedule({ action, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    // Concurrency is full
    const blocked = scheduler.schedule({ action: { ...action, channel: 'b' }, context: ctx });
    expect(blocked.ok).toBe(false);

    // Cancel frees the slot
    scheduler.cancel(r.id);
    const retry = scheduler.schedule({ action: { ...action, channel: 'b' }, context: ctx });
    expect(retry.ok).toBe(true);
  });

  it('cancelAll() clears all pending jobs and returns count', async () => {
    const { scheduler, handler } = makeScheduler({ maxConcurrent: 5 });
    const ctx = createContext();

    scheduler.schedule({ action: { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 5 }, context: ctx });
    scheduler.schedule({ action: { type: 'defer', channel: 'b', prompt: 'y', delaySeconds: 10 }, context: ctx });
    scheduler.schedule({ action: { type: 'defer', channel: 'c', prompt: 'z', delaySeconds: 15 }, context: ctx });

    expect(scheduler.listActive()).toHaveLength(3);

    const count = scheduler.cancelAll();
    expect(count).toBe(3);
    expect(scheduler.listActive()).toHaveLength(0);

    // No timers should fire
    vi.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancelAll() returns 0 when no jobs are pending', () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.cancelAll()).toBe(0);
  });

  it('cancel() returns false for a running job', async () => {
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((r) => { resolveHandler = r; });
    const { scheduler } = makeScheduler({
      maxConcurrent: 5,
      jobHandler: () => handlerPromise,
    });
    const ctx = createContext();
    const r = scheduler.schedule({ action: { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 1 }, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    // Advance timer so the handler starts executing (timer fires, handler awaits)
    vi.advanceTimersByTime(1000);

    // Job is now running — cancel should return false
    expect(scheduler.cancel(r.id)).toBe(false);

    // Clean up: let the handler finish
    resolveHandler();
    await Promise.resolve();
  });

  it('cancelAll() clears only pending jobs, leaves running jobs alone', async () => {
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((r) => { resolveHandler = r; });
    let callCount = 0;
    const { scheduler } = makeScheduler({
      maxConcurrent: 5,
      jobHandler: () => {
        callCount++;
        return handlerPromise;
      },
    });
    const ctx = createContext();

    // Schedule 3 jobs: first fires at 1s, other two at 5s and 10s
    const r1 = scheduler.schedule({ action: { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 1 }, context: ctx });
    scheduler.schedule({ action: { type: 'defer', channel: 'b', prompt: 'y', delaySeconds: 5 }, context: ctx });
    scheduler.schedule({ action: { type: 'defer', channel: 'c', prompt: 'z', delaySeconds: 10 }, context: ctx });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('schedule failed');

    // Advance so only the first job's timer fires (handler starts running)
    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(1);

    // cancelAll should cancel the 2 pending jobs, leave the running one
    const count = scheduler.cancelAll();
    expect(count).toBe(2);

    // The running job should still be visible in listActive()
    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(r1.id);

    // Clean up
    resolveHandler();
    await Promise.resolve();
  });

  it('concurrency slot is NOT freed for a running job on cancel()', async () => {
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((r) => { resolveHandler = r; });
    const { scheduler } = makeScheduler({
      maxConcurrent: 1,
      jobHandler: () => handlerPromise,
    });
    const ctx = createContext();
    const r = scheduler.schedule({ action: { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 1 }, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    // Advance timer so handler starts
    vi.advanceTimersByTime(1000);

    // cancel returns false — job is running, not pending
    expect(scheduler.cancel(r.id)).toBe(false);

    // Concurrency slot is still occupied — new schedule should be rejected
    const second = scheduler.schedule({ action: { type: 'defer', channel: 'b', prompt: 'y', delaySeconds: 5 }, context: ctx });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('schedule unexpectedly succeeded while running job holds the slot');
    expect(second.error).toMatch(/Maximum of 1 deferred actions/);

    // Clean up
    resolveHandler();
    await Promise.resolve();
  });

  it('cancel() returns false after handler completion', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 5 });
    const ctx = createContext();
    const r = scheduler.schedule({ action: { type: 'defer', channel: 'a', prompt: 'x', delaySeconds: 1 }, context: ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('schedule failed');

    // Advance timer and let handler complete
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    // Job is finished — cancel should return false
    expect(scheduler.cancel(r.id)).toBe(false);
  });
});
