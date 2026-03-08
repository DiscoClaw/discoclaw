import type { InvokeFlow } from './metrics.js';

export type TraceOutcome = 'in_progress' | string;

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

  startTrace(traceId: string, sessionKey: string, flow: InvokeFlow): RunTrace {
    this.makeRoomForNewTrace();

    const trace: RunTrace = {
      traceId,
      sessionKey,
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
    this.pruneCompletedToLimit(this.maxEntries);
    return cloneTrace(trace);
  }

  getTrace(traceId: string): RunTrace | undefined {
    const trace = this.traces.get(traceId);
    return trace ? cloneTrace(trace) : undefined;
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

  private makeRoomForNewTrace(): void {
    this.pruneCompletedToLimit(this.maxEntries - 1);
  }

  private pruneCompletedToLimit(limit: number): void {
    const completed = [...this.traces.values()]
      .filter((trace) => trace.outcome !== 'in_progress')
      .sort((a, b) => a.startedAt - b.startedAt);

    while (this.traces.size > limit && completed.length > 0) {
      const oldest = completed.shift();
      if (!oldest) {
        break;
      }

      this.traces.delete(oldest.traceId);
    }
  }
}

export const globalTraceStore = new TraceStore();
