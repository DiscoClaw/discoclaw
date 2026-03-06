import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPhaseStatusHeartbeatController,
  extractPlanHeaderHeartbeatValue,
  formatHeartbeatDuration,
  formatPhaseStatusHeartbeatEvent,
  parsePhaseStatusHeartbeatPolicy,
  resolvePlanHeaderHeartbeatPolicy,
} from './phase-status-heartbeat.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parsePhaseStatusHeartbeatPolicy', () => {
  it('parses disabled values', () => {
    expect(parsePhaseStatusHeartbeatPolicy('off')).toEqual({ enabled: false, intervalMs: 45_000 });
    expect(parsePhaseStatusHeartbeatPolicy(0)).toEqual({ enabled: false, intervalMs: 45_000 });
  });

  it('parses string durations and enforces a minimum interval', () => {
    expect(parsePhaseStatusHeartbeatPolicy('90s')).toEqual({ enabled: true, intervalMs: 90_000 });
    expect(parsePhaseStatusHeartbeatPolicy('250ms')).toEqual({ enabled: true, intervalMs: 1_000 });
  });

  it('falls back to defaults for invalid inputs', () => {
    expect(parsePhaseStatusHeartbeatPolicy('nonsense')).toEqual({ enabled: true, intervalMs: 45_000 });
  });
});

describe('resolvePlanHeaderHeartbeatPolicy', () => {
  it('parses Heartbeat metadata from the plan header before the first separator', () => {
    const content = [
      '# Plan: Example',
      '',
      '**Heartbeat:** 90s',
      '',
      '---',
      '',
      '## Objective',
      '',
      '**Heartbeat:** off',
    ].join('\n');

    expect(extractPlanHeaderHeartbeatValue(content)).toBe('90s');
    expect(resolvePlanHeaderHeartbeatPolicy(content, 12_000)).toEqual({ enabled: true, intervalMs: 90_000 });
  });

  it('falls back to configured defaults when header value is invalid', () => {
    const content = [
      '# Plan: Example',
      '',
      '**Heartbeat:** nonsense',
      '',
      '---',
      '',
      '## Objective',
    ].join('\n');

    expect(resolvePlanHeaderHeartbeatPolicy(content, 12_000)).toEqual({ enabled: true, intervalMs: 12_000 });
  });
});

describe('formatPhaseStatusHeartbeatEvent', () => {
  it('renders human-readable status lines', () => {
    expect(formatHeartbeatDuration(65_000)).toBe('1m 5s');
    expect(
      formatPhaseStatusHeartbeatEvent({
        type: 'phase_transition',
        flowLabel: 'Forge plan-123',
        fromPhaseLabel: 'Drafting',
        toPhaseLabel: 'Audit round 1/5',
        fromPhaseElapsedMs: 20_000,
        runElapsedMs: 20_000,
        atMs: 123,
      }),
    ).toBe('🔄 Forge plan-123: Drafting complete (20s). Starting Audit round 1/5...');
  });
});

describe('createPhaseStatusHeartbeatController', () => {
  it('does not overlap heartbeat callbacks when a previous tick is still running', async () => {
    let active = 0;
    let maxActive = 0;
    let heartbeatCalls = 0;
    let releaseCurrent: (() => void) | null = null;

    const onUpdate = vi.fn(async (_message: string, event) => {
      if (event.type !== 'heartbeat') return;
      heartbeatCalls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releaseCurrent = () => {
          active--;
          resolve();
        };
      });
    });

    const ctrl = createPhaseStatusHeartbeatController({
      flowLabel: 'Plan run plan-001',
      policy: { intervalMs: 1_000, enabled: true },
      onUpdate,
    });

    await ctrl.startPhase('phase-1');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(heartbeatCalls).toBe(1);
    expect(maxActive).toBe(1);

    const release = releaseCurrent as (() => void) | null;
    if (typeof release === 'function') release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeatCalls).toBe(2);

    ctrl.dispose();
  });

  it('contains callback errors and continues scheduling', async () => {
    let heartbeatCalls = 0;
    const onError = vi.fn();
    const onUpdate = vi.fn(async (_message: string, event) => {
      if (event.type !== 'heartbeat') return;
      heartbeatCalls++;
      if (heartbeatCalls === 1) {
        throw new Error('boom');
      }
    });

    const ctrl = createPhaseStatusHeartbeatController({
      flowLabel: 'Forge plan-020',
      policy: { intervalMs: 1_000, enabled: true },
      onUpdate,
      onError,
    });

    await ctrl.startPhase('Drafting');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(heartbeatCalls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });
});
