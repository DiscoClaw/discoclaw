import type { InvokeFlow } from './metrics.js';

export type TraceOutcome = 'in_progress' | string;

export type TraceFlowSummary = {
  total: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  avgDurationMs: number;
};

export type TraceSummary = {
  total: number;
  inProgress: number;
  oldestAt: number | null;
  newestAt: number | null;
  byFlow: Record<InvokeFlow, TraceFlowSummary>;
  byOutcome: Record<string, number>;
  recentErrors: Array<{ traceId: string; flow: InvokeFlow; message: string; at: number }>;
};

type TraceEventBase = {
  at: number;
  summary?: string;
};

export type InvokeStartTraceEvent = TraceEventBase & {
  type: 'invoke_start';
  promptPreview?: string;
};

export type InvokeEndTraceEvent = TraceEventBase & {
  type: 'invoke_end';
  ok: boolean;
};

export type ToolStartTraceEvent = TraceEventBase & {
  type: 'tool_start';
  toolName: string;
  callId?: string;
  inputSummary?: string;
};

export type ToolEndTraceEvent = TraceEventBase & {
  type: 'tool_end';
  toolName: string;
  ok: boolean;
  callId?: string;
  durationMs?: number;
  outputSummary?: string;
};

export type ActionResultTraceEvent = TraceEventBase & {
  type: 'action_result';
  action: string;
  ok: boolean;
  detail?: string;
};

export type ErrorTraceEvent = TraceEventBase & {
  type: 'error';
  message: string;
  name?: string;
  stage?: string;
  stack?: string;
};

export type TraceEvent =
  | InvokeStartTraceEvent
  | InvokeEndTraceEvent
  | ToolStartTraceEvent
  | ToolEndTraceEvent
  | ActionResultTraceEvent
  | ErrorTraceEvent;

export type RunTrace = {
  traceId: string;
  sessionKey: string;
  channelId?: string;
  flow: InvokeFlow;
  startedAt: number;
  events: TraceEvent[];
  outcome: TraceOutcome;
  durationMs: number;
};

type TraceStoreOptions = {
  maxEntries?: number;
  maxEventsPerTrace?: number;
};

function cloneEvent(event: TraceEvent): TraceEvent {
  return { ...event };
}

function cloneTrace(trace: RunTrace): RunTrace {
  return {
    ...trace,
    events: trace.events.map(cloneEvent),
  };
}

export class TraceStore {
  private readonly traces = new Map<string, RunTrace>();
  private readonly maxEntries: number;
  private readonly maxEventsPerTrace: number;

  constructor(options: TraceStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 50));
    this.maxEventsPerTrace = Math.max(1, Math.floor(options.maxEventsPerTrace ?? 500));
  }

  startTrace(
    traceId: string,
    sessionKey: string,
    flow: InvokeFlow,
    channelId?: string,
  ): RunTrace {
    this.makeRoomForNewTrace();

    const trace: RunTrace = {
      traceId,
      sessionKey,
      channelId,
      flow,
      startedAt: Date.now(),
      events: [],
      outcome: 'in_progress',
      durationMs: 0,
    };

    this.traces.set(traceId, trace);
    return cloneTrace(trace);
  }

  addEvent(traceId: string, event: TraceEvent): void {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    trace.events.push(cloneEvent(event));
    while (trace.events.length > this.maxEventsPerTrace) {
      trace.events.shift();
    }
  }

  endTrace(traceId: string, outcome: TraceOutcome): RunTrace | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return undefined;
    }

    trace.outcome = outcome;
    trace.durationMs = Math.max(0, Date.now() - trace.startedAt);
    this.pruneToLimit(this.maxEntries);
    return cloneTrace(trace);
  }

  getTrace(traceId: string): RunTrace | undefined {
    const trace = this.traces.get(traceId);
    return trace ? cloneTrace(trace) : undefined;
  }

  getTraceForChannel(traceId: string, channelId: string | undefined): RunTrace | undefined {
    if (!channelId) {
      return undefined;
    }

    const trace = this.traces.get(traceId);
    if (!trace || trace.channelId !== channelId) {
      return undefined;
    }

    return cloneTrace(trace);
  }

  listRecent(n: number): RunTrace[] {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) {
      return [];
    }

    return [...this.traces.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(cloneTrace);
  }

  listRecentForChannel(n: number, channelId: string | undefined): RunTrace[] {
    if (!channelId) {
      return [];
    }

    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) {
      return [];
    }

    return [...this.traces.values()]
      .filter((trace) => trace.channelId === channelId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(cloneTrace);
  }

  get size(): number {
    return this.traces.size;
  }

  summary(): TraceSummary {
    const allTraces = [...this.traces.values()];

    const flows: InvokeFlow[] = ['message', 'reaction', 'cron', 'defer'];
    const byFlow = {} as Record<InvokeFlow, TraceFlowSummary>;
    for (const flow of flows) {
      const matching = allTraces.filter((t) => t.flow === flow);
      const completed = matching.filter((t) => t.outcome !== 'in_progress');
      const succeeded = completed.filter((t) => t.outcome === 'success').length;
      const totalDuration = completed.reduce((sum, t) => sum + t.durationMs, 0);
      byFlow[flow] = {
        total: matching.length,
        succeeded,
        failed: completed.length - succeeded,
        inProgress: matching.length - completed.length,
        avgDurationMs: completed.length > 0 ? Math.round(totalDuration / completed.length) : 0,
      };
    }

    const byOutcome: Record<string, number> = {};
    for (const trace of allTraces) {
      byOutcome[trace.outcome] = (byOutcome[trace.outcome] ?? 0) + 1;
    }

    const MAX_RECENT_ERRORS = 10;
    const recentErrors: TraceSummary['recentErrors'] = [];
    const sorted = [...allTraces].sort((a, b) => b.startedAt - a.startedAt);
    for (const trace of sorted) {
      if (recentErrors.length >= MAX_RECENT_ERRORS) break;
      if (trace.outcome === 'success' || trace.outcome === 'in_progress') continue;
      const lastError = [...trace.events].reverse().find((e) => e.type === 'error');
      recentErrors.push({
        traceId: trace.traceId,
        flow: trace.flow,
        message: lastError && 'message' in lastError ? lastError.message : trace.outcome,
        at: trace.startedAt,
      });
    }

    let oldestAt: number | null = null;
    let newestAt: number | null = null;
    if (allTraces.length > 0) {
      oldestAt = Math.min(...allTraces.map((t) => t.startedAt));
      newestAt = Math.max(...allTraces.map((t) => t.startedAt));
    }

    return {
      total: allTraces.length,
      inProgress: allTraces.filter((t) => t.outcome === 'in_progress').length,
      oldestAt,
      newestAt,
      byFlow,
      byOutcome,
      recentErrors,
    };
  }

  private makeRoomForNewTrace(): void {
    this.pruneToLimit(this.maxEntries - 1);
  }

  private pruneToLimit(limit: number): void {
    const normalizedLimit = Math.max(0, limit);
    const completed = [...this.traces.values()]
      .filter((trace) => trace.outcome !== 'in_progress')
      .sort((a, b) => a.startedAt - b.startedAt);

    while (this.traces.size > normalizedLimit && completed.length > 0) {
      const oldest = completed.shift();
      if (!oldest) {
        break;
      }

      this.traces.delete(oldest.traceId);
    }

    if (this.traces.size <= normalizedLimit) {
      return;
    }

    const remaining = [...this.traces.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (this.traces.size > normalizedLimit && remaining.length > 0) {
      const oldest = remaining.shift();
      if (!oldest) {
        break;
      }

      this.traces.delete(oldest.traceId);
    }
  }
}

export const globalTraceStore = new TraceStore();
