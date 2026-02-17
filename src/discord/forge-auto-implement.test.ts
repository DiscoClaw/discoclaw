import { describe, expect, it, vi } from 'vitest';
import type { ForgeResult } from './forge-commands.js';
import type { ForgeAutoImplementDeps } from './forge-auto-implement.js';
import { autoImplementForgePlan } from './forge-auto-implement.js';

type LoggerMock = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const baseResult: ForgeResult = {
  planId: 'plan-001',
  filePath: 'plans/plan-001.md',
  finalVerdict: 'none',
  rounds: 1,
  reachedMaxRounds: false,
};

const createDeps = (overrides: Partial<ForgeAutoImplementDeps> = {}): ForgeAutoImplementDeps => {
  const log: LoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const base: ForgeAutoImplementDeps = {
    planApprove: vi.fn(() => Promise.resolve()),
    planRun: vi.fn(() => Promise.resolve({ summary: 'Plan run started' })),
    isPlanRunning: vi.fn(() => false),
    log,
  } as ForgeAutoImplementDeps;

  return { ...base, ...overrides };
};

const buildResult = (overrides: Partial<ForgeResult> = {}): ForgeResult => ({
  ...baseResult,
  ...overrides,
});

describe('autoImplementForgePlan', () => {
  it('auto approves and runs a clean plan', async () => {
    const result = buildResult();
    const deps = createDeps();

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome).toEqual({ status: 'auto', planId: result.planId, summary: 'Plan run started' });
    expect(deps.planApprove).toHaveBeenCalledWith(result.planId);
    expect(deps.planRun).toHaveBeenCalledWith(result.planId);
    expect(deps.log?.info).toHaveBeenCalled();
  });

  it('auto approves and runs a plan with non-blocking severity warnings', async () => {
    const result = buildResult({ finalVerdict: 'medium' });
    const deps = createDeps();

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('auto');
    if (outcome.status !== 'auto') throw new Error('expected auto');
    expect(outcome.planId).toBe(result.planId);
    expect(outcome.summary).toBe('Forge reported medium severity concerns.\n\nPlan run started');
    expect(deps.planApprove).toHaveBeenCalledWith(result.planId);
    expect(deps.planRun).toHaveBeenCalledWith(result.planId);
    expect(deps.log?.info).toHaveBeenCalled();
  });

  it('warns when a plan run is already in progress', async () => {
    const result = buildResult();
    const deps = createDeps({ isPlanRunning: () => true });

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('A plan run is already in progress for this plan.');
  });

  it('notifies when the audit cap was reached', async () => {
    const result = buildResult({ reachedMaxRounds: true });
    const deps = createDeps();

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('CAP_REACHED');
  });

  it('propagates forge errors into the fallback message', async () => {
    const result = buildResult({ error: 'timeout' });
    const deps = createDeps();

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('Forge failed: timeout');
  });

  it('falls back when auto-approval throws', async () => {
    const result = buildResult();
    const planApprove = vi.fn(() => Promise.reject(new Error('boom')));
    const deps = createDeps({ planApprove });

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('Auto-approval failed: Error: boom');
    expect(deps.planRun).not.toHaveBeenCalled();
    expect(deps.log?.error).toHaveBeenCalled();
  });

  it('logs and reports when the plan run fails', async () => {
    const result = buildResult();
    const planRun = vi.fn(() => Promise.reject(new Error('run fail')));
    const deps = createDeps({ planRun });

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('Auto-run failed: Error: run fail');
    expect(deps.log?.error).toHaveBeenCalled();
  });

  it('includes blocking severity labels in the fallback message', async () => {
    const result = buildResult({ finalVerdict: 'blocking' });
    const deps = createDeps();

    const outcome = await autoImplementForgePlan({ planId: result.planId, result }, deps);

    expect(outcome.status).toBe('manual');
    if (outcome.status !== 'manual') throw new Error('expected manual');
    expect(outcome.message).toContain('blocking severity concerns');
  });
});
