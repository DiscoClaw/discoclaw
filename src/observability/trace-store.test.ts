import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceStore } from './trace-store.js';

describe('TraceStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks a trace lifecycle and returns recent traces newest first', () => {
    vi.useFakeTimers();

    const store = new TraceStore();

    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
    store.startTrace('trace-1', 'session-1', 'message');
    store.addEvent('trace-1', {
      type: 'invoke_start',
      at: Date.now(),
      summary: 'message received',
    });

    vi.setSystemTime(new Date('2026-03-08T10:00:01.500Z'));
    store.addEvent('trace-1', {
      type: 'tool_end',
      at: Date.now(),
      toolName: 'shell',
      ok: true,
      durationMs: 200,
      outputSummary: 'completed',
    });
    const ended = store.endTrace('trace-1', 'success');

    vi.setSystemTime(new Date('2026-03-08T10:00:02.000Z'));
    store.startTrace('trace-2', 'session-2', 'reaction');

    expect(ended).toMatchObject({
      traceId: 'trace-1',
      sessionKey: 'session-1',
      flow: 'message',
      outcome: 'success',
      durationMs: 1500,
    });
    expect(ended?.events).toHaveLength(2);

    const trace = store.getTrace('trace-1');
    expect(trace).toMatchObject({
      traceId: 'trace-1',
      sessionKey: 'session-1',
      flow: 'message',
      outcome: 'success',
      durationMs: 1500,
    });
    expect(trace?.events).toEqual([
      {
        type: 'invoke_start',
        at: new Date('2026-03-08T10:00:00.000Z').getTime(),
        summary: 'message received',
      },
      {
        type: 'tool_end',
        at: new Date('2026-03-08T10:00:01.500Z').getTime(),
        toolName: 'shell',
        ok: true,
        durationMs: 200,
        outputSummary: 'completed',
      },
    ]);

    expect(store.listRecent(2).map((run) => run.traceId)).toEqual(['trace-2', 'trace-1']);
  });

  it('caps retained events per trace', () => {
    const store = new TraceStore({ maxEventsPerTrace: 2 });

    store.startTrace('trace-1', 'session-1', 'message');
    store.addEvent('trace-1', { type: 'invoke_start', at: 1, summary: 'start' });
    store.addEvent('trace-1', { type: 'tool_start', at: 2, toolName: 'shell' });
    store.addEvent('trace-1', { type: 'tool_end', at: 3, toolName: 'shell', ok: true });

    expect(store.getTrace('trace-1')?.events).toEqual([
      { type: 'tool_start', at: 2, toolName: 'shell' },
      { type: 'tool_end', at: 3, toolName: 'shell', ok: true },
    ]);
  });

  it('evicts the oldest completed traces when the store is full', () => {
    vi.useFakeTimers();

    const store = new TraceStore({ maxEntries: 2 });

    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
    store.startTrace('trace-1', 'session-1', 'message');
    store.endTrace('trace-1', 'success');

    vi.setSystemTime(new Date('2026-03-08T10:00:01.000Z'));
    store.startTrace('trace-2', 'session-2', 'message');
    store.endTrace('trace-2', 'error');

    vi.setSystemTime(new Date('2026-03-08T10:00:02.000Z'));
    store.startTrace('trace-3', 'session-3', 'message');

    expect(store.getTrace('trace-1')).toBeUndefined();
    expect(store.listRecent(5).map((run) => run.traceId)).toEqual(['trace-3', 'trace-2']);
  });

  it('retains up to the configured capacity before evicting on the next start', () => {
    vi.useFakeTimers();

    const store = new TraceStore({ maxEntries: 2 });

    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
    store.startTrace('trace-1', 'session-1', 'message');
    store.endTrace('trace-1', 'success');

    vi.setSystemTime(new Date('2026-03-08T10:00:01.000Z'));
    store.startTrace('trace-2', 'session-2', 'message');
    store.endTrace('trace-2', 'success');

    expect(store.listRecent(5).map((run) => run.traceId)).toEqual(['trace-2', 'trace-1']);

    vi.setSystemTime(new Date('2026-03-08T10:00:02.000Z'));
    store.startTrace('trace-3', 'session-3', 'message');

    expect(store.listRecent(5).map((run) => run.traceId)).toEqual(['trace-3', 'trace-2']);
  });

  it('returns defensive copies from getters', () => {
    const store = new TraceStore();

    store.startTrace('trace-1', 'session-1', 'message');
    store.addEvent('trace-1', { type: 'invoke_start', at: 1, summary: 'start' });

    const trace = store.getTrace('trace-1');
    trace?.events.push({ type: 'error', at: 2, message: 'mutated' });

    expect(store.getTrace('trace-1')?.events).toEqual([
      { type: 'invoke_start', at: 1, summary: 'start' },
    ]);
  });
});
