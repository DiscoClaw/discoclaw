import type { TraceSummary, RunTrace } from '../../observability/trace-store.js';
import { globalTraceStore } from '../../observability/trace-store.js';

export type DashboardTracesApiResponse = {
  ok: true;
  summary: TraceSummary;
  recentTraces: RunTrace[];
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function buildTracesResponse(limitParam: string | null): DashboardTracesApiResponse {
  const parsed = limitParam !== null ? Math.floor(Number(limitParam)) : DEFAULT_LIMIT;
  const limit = Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_LIMIT, parsed))
    : DEFAULT_LIMIT;

  return {
    ok: true,
    summary: globalTraceStore.summary(),
    recentTraces: globalTraceStore.listRecent(limit),
  };
}
