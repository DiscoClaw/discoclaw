import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './metrics.js';

describe('MetricsRegistry', () => {
  it('tracks invoke counters and latency summaries', () => {
    const m = new MetricsRegistry();
    m.recordInvokeStart('message');
    m.recordInvokeResult('message', 100, true);
    m.recordInvokeResult('message', 200, false, 'timed out');

    const snap = m.snapshot();
    expect(snap.counters['invoke.message.started']).toBe(1);
    expect(snap.counters['invoke.message.succeeded']).toBe(1);
    expect(snap.counters['invoke.message.failed']).toBe(1);
    expect(snap.counters['invoke.message.error_class.timeout']).toBe(1);
    expect(snap.latencies.message.count).toBe(2);
    expect(snap.latencies.message.maxMs).toBe(200);
    expect(snap.latencies.reaction.count).toBe(0);
  });

  it('classifies stream stall errors as stream_stall', () => {
    const m = new MetricsRegistry();
    m.recordInvokeResult('message', 120000, false, 'stream stall: no output for 120000ms');

    const snap = m.snapshot();
    expect(snap.counters['invoke.message.error_class.stream_stall']).toBe(1);
  });

  it('includes memory stats when a memory sampler is configured', () => {
    const m = new MetricsRegistry();
    m.setMemorySampler({
      peek: () => ({
        rssBytes: 1,
        heapUsedBytes: 2,
        heapTotalBytes: 3,
        externalBytes: 4,
        rssHwmBytes: 5,
        heapUsedHwmBytes: 6,
        sampleCount: 7,
      }),
    } as any);

    const snap = m.snapshot();
    expect(snap.memory).toBeDefined();
    expect(snap.memory?.rssBytes).toBe(1);
    expect(snap.memory?.sampleCount).toBe(7);
  });
});
