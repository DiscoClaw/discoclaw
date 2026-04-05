import type { MetricsSnapshot } from '../../observability/metrics.js';
import { globalMetrics } from '../../observability/metrics.js';

export type DashboardMetricsApiResponse = {
  ok: true;
  metrics: MetricsSnapshot;
};

export function buildMetricsResponse(): DashboardMetricsApiResponse {
  return {
    ok: true,
    metrics: globalMetrics.snapshot(),
  };
}
