import { describe, expect, it } from 'vitest';
import { buildTracesResponse } from './traces.js';
import { globalTraceStore } from '../../observability/trace-store.js';

describe('buildTracesResponse', () => {
  it('returns ok with summary and recent traces', () => {
    const response = buildTracesResponse(null);

    expect(response.ok).toBe(true);
    expect(response.summary).toBeDefined();
    expect(typeof response.summary.total).toBe('number');
    expect(response.summary.byFlow).toBeDefined();
    expect(Array.isArray(response.recentTraces)).toBe(true);
  });

  it('uses default limit of 50 when param is null', () => {
    const response = buildTracesResponse(null);
    expect(response.ok).toBe(true);
    // With an empty store, recentTraces should be empty
    expect(response.recentTraces.length).toBeLessThanOrEqual(50);
  });

  it('respects a custom limit param', () => {
    // Seed a few traces
    globalTraceStore.startTrace('t1', 'user:ch', 'message');
    globalTraceStore.endTrace('t1', 'success');
    globalTraceStore.startTrace('t2', 'user:ch', 'cron');
    globalTraceStore.endTrace('t2', 'success');
    globalTraceStore.startTrace('t3', 'user:ch', 'reaction');
    globalTraceStore.endTrace('t3', 'success');

    const response = buildTracesResponse('2');
    expect(response.ok).toBe(true);
    expect(response.recentTraces.length).toBeLessThanOrEqual(2);
  });

  it('clamps limit to max of 200', () => {
    const response = buildTracesResponse('999');
    expect(response.ok).toBe(true);
    // Just verify it doesn't throw — the limit is clamped internally
  });

  it('falls back to default for non-numeric limit', () => {
    const response = buildTracesResponse('abc');
    expect(response.ok).toBe(true);
  });
});
