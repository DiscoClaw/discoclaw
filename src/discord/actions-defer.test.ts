import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from './actions.js';
import { DeferScheduler, type DeferSchedulerOptions } from './defer-scheduler.js';
import { executeDeferAction, type DeferActionRequest, type DeferredRun } from './actions-defer.js';
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

  it('schedules deferred run when valid', async () => {
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
    expect(result.error).toBe('Deferred follow-up for general rejected: delaySeconds cannot exceed 5 seconds');
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
});
