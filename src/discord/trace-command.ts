import type { RunTrace, TraceEvent } from '../observability/trace-store.js';

export type TraceCommand =
  | { mode: 'list' }
  | { mode: 'detail'; traceId: string };

type TraceListRow = {
  started: string;
  flow: string;
  outcome: string;
  events: string;
  duration: string;
  traceId: string;
};

const TRACE_ID_WIDTH = 24;
const FLOW_WIDTH = 8;
const OUTCOME_WIDTH = 11;
const EVENTS_WIDTH = 6;
const DURATION_WIDTH = 8;

export function parseTraceCommand(content: string): TraceCommand | null {
  const normalized = String(content ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  if (lower === '!trace') {
    return { mode: 'list' };
  }

  if (!lower.startsWith('!trace ')) {
    return null;
  }

  const traceId = normalized.slice('!trace '.length).trim();
  if (!traceId || /\s/.test(traceId)) {
    return null;
  }

  return { mode: 'detail', traceId };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.round(seconds)}s`;
}

function formatStartedAt(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function toListRow(trace: RunTrace): TraceListRow {
  return {
    started: formatStartedAt(trace.startedAt),
    flow: trace.flow,
    outcome: trace.outcome,
    events: String(trace.events.length),
    duration: trace.outcome === 'in_progress' ? 'running' : formatDuration(trace.durationMs),
    traceId: trace.traceId,
  };
}

export function renderTraceList(traces: readonly RunTrace[]): string {
  const rows = traces.map(toListRow);
  const lines: string[] = [];

  lines.push('Recent traces');
  if (rows.length === 0) {
    lines.push('(none)');
    return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
  }

  lines.push(
    `${pad('Started', 8)}  ${pad('Flow', FLOW_WIDTH)}  ${pad('Outcome', OUTCOME_WIDTH)}  ${pad('Events', EVENTS_WIDTH)}  ${pad('Duration', DURATION_WIDTH)}  Trace ID`,
  );
  lines.push(
    `${'-'.repeat(8)}  ${'-'.repeat(FLOW_WIDTH)}  ${'-'.repeat(OUTCOME_WIDTH)}  ${'-'.repeat(EVENTS_WIDTH)}  ${'-'.repeat(DURATION_WIDTH)}  ${'-'.repeat(TRACE_ID_WIDTH)}`,
  );

  for (const row of rows) {
    lines.push(
      `${pad(row.started, 8)}  ${pad(row.flow, FLOW_WIDTH)}  ${pad(row.outcome, OUTCOME_WIDTH)}  ${pad(row.events, EVENTS_WIDTH)}  ${pad(row.duration, DURATION_WIDTH)}  ${truncate(row.traceId, TRACE_ID_WIDTH)}`,
    );
  }

  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}

function formatRelativeTime(startedAt: number, eventAt: number): string {
  const delta = Math.max(0, eventAt - startedAt);
  return `+${String(delta).padStart(5, ' ')}ms`;
}

function renderEventLabel(event: TraceEvent): string {
  switch (event.type) {
    case 'invoke_start':
      return 'INVOKE START';
    case 'invoke_end':
      return 'INVOKE END';
    case 'tool_start':
      return 'TOOL START';
    case 'tool_end':
      return 'TOOL END';
    case 'action_result':
      return 'ACTION';
    case 'error':
      return 'ERROR';
  }
}

function renderEventDetail(event: TraceEvent): string {
  switch (event.type) {
    case 'invoke_start': {
      const parts = [
        event.summary,
        event.promptPreview ? `prompt=${JSON.stringify(event.promptPreview)}` : null,
      ].filter(Boolean);
      return parts.join(' | ');
    }
    case 'invoke_end': {
      const parts = [event.ok ? 'ok' : 'failed', event.summary].filter(Boolean);
      return parts.join(' | ');
    }
    case 'tool_start': {
      const parts = [
        event.toolName,
        event.callId ? `call=${event.callId}` : null,
        event.inputSummary,
        event.summary,
      ].filter(Boolean);
      return parts.join(' | ');
    }
    case 'tool_end': {
      const parts = [
        event.toolName,
        event.ok ? 'ok' : 'failed',
        event.callId ? `call=${event.callId}` : null,
        event.durationMs === undefined ? null : `duration=${formatDuration(event.durationMs)}`,
        event.outputSummary,
        event.summary,
      ].filter(Boolean);
      return parts.join(' | ');
    }
    case 'action_result': {
      const parts = [
        event.action,
        event.ok ? 'ok' : 'failed',
        event.detail,
        event.summary,
      ].filter(Boolean);
      return parts.join(' | ');
    }
    case 'error': {
      const parts = [
        event.name ? `${event.name}: ${event.message}` : event.message,
        event.stage ? `stage=${event.stage}` : null,
        event.summary,
      ].filter(Boolean);
      return parts.join(' | ');
    }
  }
}

export function renderTraceDetail(trace: RunTrace): string {
  const lines: string[] = [];

  lines.push(`Trace ${trace.traceId}`);
  lines.push(
    `Flow: ${trace.flow} | Session: ${trace.sessionKey} | Outcome: ${trace.outcome} | Duration: ${
      trace.outcome === 'in_progress' ? 'running' : formatDuration(trace.durationMs)
    }`,
  );
  lines.push(`Started: ${new Date(trace.startedAt).toISOString()}`);
  lines.push('');

  if (trace.events.length === 0) {
    lines.push('(no events)');
    return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
  }

  for (const event of trace.events) {
    const label = pad(renderEventLabel(event), 12);
    const detail = renderEventDetail(event);
    lines.push(`${formatRelativeTime(trace.startedAt, event.at)}  ${label}  ${detail || '(no detail)'}`);
  }

  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}
