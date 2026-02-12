export type InvokeFlow = 'message' | 'reaction' | 'cron';

export type MetricsSnapshot = {
  startedAt: number;
  counters: Record<string, number>;
  latencies: Record<InvokeFlow, { count: number; p50Ms: number; p95Ms: number; maxMs: number }>;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return Math.round(sorted[idx] * 100) / 100;
}

function classifyError(message?: string): string {
  const msg = String(message ?? '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg.includes('timed out')) return 'timeout';
  if (msg.includes('missing permissions') || msg.includes('missing access')) return 'discord_permissions';
  if (msg.includes('unauthorized') || msg.includes('auth')) return 'auth';
  if (msg.includes('stream stall')) return 'stream_stall';
  return 'other';
}

export class MetricsRegistry {
  private readonly startedAtMs = Date.now();
  private readonly counters = new Map<string, number>();
  private readonly latencies: Record<InvokeFlow, number[]> = {
    message: [],
    reaction: [],
    cron: [],
  };
  private readonly maxLatencySamples = 400;

  increment(name: string, value = 1): void {
    const next = (this.counters.get(name) ?? 0) + value;
    this.counters.set(name, next);
  }

  recordInvokeStart(flow: InvokeFlow): void {
    this.increment(`invoke.${flow}.started`);
  }

  recordInvokeResult(flow: InvokeFlow, ms: number, ok: boolean, errorMessage?: string): void {
    this.increment(`invoke.${flow}.${ok ? 'succeeded' : 'failed'}`);
    this.pushLatency(flow, ms);
    if (!ok) {
      this.increment(`invoke.${flow}.error_class.${classifyError(errorMessage)}`);
    }
  }

  recordActionResult(ok: boolean): void {
    this.increment(`actions.${ok ? 'succeeded' : 'failed'}`);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) counters[k] = v;

    return {
      startedAt: this.startedAtMs,
      counters,
      latencies: {
        message: this.latencySummary('message'),
        reaction: this.latencySummary('reaction'),
        cron: this.latencySummary('cron'),
      },
    };
  }

  private pushLatency(flow: InvokeFlow, ms: number): void {
    const arr = this.latencies[flow];
    arr.push(Math.max(0, ms));
    if (arr.length > this.maxLatencySamples) {
      arr.shift();
    }
  }

  private latencySummary(flow: InvokeFlow): { count: number; p50Ms: number; p95Ms: number; maxMs: number } {
    const values = this.latencies[flow];
    const maxMs = values.length > 0 ? Math.max(...values) : 0;
    return {
      count: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maxMs: Math.round(maxMs * 100) / 100,
    };
  }
}

export const globalMetrics = new MetricsRegistry();
