import { describe, expect, it } from 'vitest';
import { buildMetricsResponse } from './metrics.js';

describe('buildMetricsResponse', () => {
  it('returns ok with a metrics snapshot', () => {
    const response = buildMetricsResponse();

    expect(response.ok).toBe(true);
    expect(response.metrics).toBeDefined();
    expect(typeof response.metrics.startedAt).toBe('number');
    expect(response.metrics.counters).toBeDefined();
    expect(response.metrics.latencies).toBeDefined();
    expect(response.metrics.latencies).toHaveProperty('message');
    expect(response.metrics.latencies).toHaveProperty('reaction');
    expect(response.metrics.latencies).toHaveProperty('cron');
    expect(response.metrics.latencies).toHaveProperty('defer');
  });
});
