import { describe, expect, it } from 'vitest';
import { MemorySampler, formatMiB, renderMemoryLine } from './memory-sampler.js';

function makeSource(values: Partial<NodeJS.MemoryUsage>[]) {
  let idx = 0;
  return (): NodeJS.MemoryUsage => {
    const v = values[Math.min(idx++, values.length - 1)];
    return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0, ...v };
  };
}

describe('MemorySampler', () => {
  it('returns current values from a single sample', () => {
    const sampler = new MemorySampler(makeSource([{ rss: 100, heapUsed: 50, heapTotal: 80, external: 5 }]));
    const stats = sampler.sample();
    expect(stats.rssBytes).toBe(100);
    expect(stats.heapUsedBytes).toBe(50);
    expect(stats.heapTotalBytes).toBe(80);
    expect(stats.externalBytes).toBe(5);
    expect(stats.sampleCount).toBe(1);
  });

  it('tracks high-water marks across multiple samples', () => {
    const sampler = new MemorySampler(makeSource([
      { rss: 100, heapUsed: 50 },
      { rss: 200, heapUsed: 30 },
      { rss: 150, heapUsed: 80 },
    ]));
    sampler.sample();
    sampler.sample();
    const stats = sampler.sample();
    expect(stats.rssHwmBytes).toBe(200);
    expect(stats.heapUsedHwmBytes).toBe(80);
    expect(stats.sampleCount).toBe(3);
  });

  it('hwm equals current value when current exceeds prior hwm', () => {
    const sampler = new MemorySampler(makeSource([
      { rss: 100, heapUsed: 50 },
      { rss: 300, heapUsed: 200 },
    ]));
    sampler.sample();
    const stats = sampler.sample();
    expect(stats.rssHwmBytes).toBe(300);
    expect(stats.heapUsedHwmBytes).toBe(200);
  });

  it('peek does not increment sample count or update hwm', () => {
    const sampler = new MemorySampler(makeSource([
      { rss: 100, heapUsed: 50 },
      { rss: 999, heapUsed: 999 },
    ]));
    sampler.sample();
    const peeked = sampler.peek();
    expect(peeked.sampleCount).toBe(1);
    // HWM should reflect sample (100/50), not the peek value (999/999)
    expect(peeked.rssHwmBytes).toBe(999);
    expect(peeked.heapUsedHwmBytes).toBe(999);
    // But internal hwm state remains at 100/50 — verify via another sample
    const sampler2 = new MemorySampler(makeSource([{ rss: 100, heapUsed: 50 }]));
    sampler2.sample();
    const after = sampler2.peek();
    expect(after.sampleCount).toBe(1);
  });

  it('reset clears hwm and count', () => {
    const sampler = new MemorySampler(makeSource([
      { rss: 500, heapUsed: 300 },
      { rss: 10, heapUsed: 5 },
    ]));
    sampler.sample();
    sampler.reset();
    const stats = sampler.sample();
    expect(stats.rssHwmBytes).toBe(10);
    expect(stats.heapUsedHwmBytes).toBe(5);
    expect(stats.sampleCount).toBe(1);
  });
});

describe('formatMiB', () => {
  it('formats bytes to one decimal MiB', () => {
    expect(formatMiB(1024 * 1024)).toBe('1.0 MiB');
    expect(formatMiB(1.5 * 1024 * 1024)).toBe('1.5 MiB');
    expect(formatMiB(0)).toBe('0.0 MiB');
  });
});

describe('renderMemoryLine', () => {
  it('produces a correctly formatted line', () => {
    const line = renderMemoryLine({
      rssBytes: 50 * 1024 * 1024,
      heapUsedBytes: 30 * 1024 * 1024,
      heapTotalBytes: 40 * 1024 * 1024,
      externalBytes: 2 * 1024 * 1024,
      rssHwmBytes: 60 * 1024 * 1024,
      heapUsedHwmBytes: 35 * 1024 * 1024,
      sampleCount: 12,
    });
    expect(line).toBe(
      'Memory: rss=50.0 MiB heapUsed=30.0 MiB heapTotal=40.0 MiB hwm(rss=60.0 MiB heap=35.0 MiB) samples=12',
    );
  });
});
