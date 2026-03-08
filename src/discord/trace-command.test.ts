import { describe, expect, it } from 'vitest';
import type { RunTrace } from '../observability/trace-store.js';
import { parseTraceCommand, renderTraceDetail, renderTraceList } from './trace-command.js';

describe('parseTraceCommand', () => {
  it('parses list and detail modes', () => {
    expect(parseTraceCommand('!trace')).toEqual({ mode: 'list' });
    expect(parseTraceCommand('  !trace   trace-123  ')).toEqual({ mode: 'detail', traceId: 'trace-123' });
    expect(parseTraceCommand('!trace message:123:456')).toEqual({ mode: 'detail', traceId: 'message:123:456' });
  });

  it('rejects unsupported or malformed command forms', () => {
    expect(parseTraceCommand('!trace abc def')).toBeNull();
    expect(parseTraceCommand('!health')).toBeNull();
    expect(parseTraceCommand('')).toBeNull();
  });
});

describe('renderTraceList', () => {
  it('renders an empty state', () => {
    expect(renderTraceList([])).toBe('```text\nRecent traces\n(none)\n```');
  });

  it('renders recent traces as a summary table', () => {
    const traces: RunTrace[] = [
      {
        traceId: 'trace-running',
        sessionKey: 'session-2',
        flow: 'message',
        startedAt: new Date('2026-03-08T10:00:05.000Z').getTime(),
        outcome: 'in_progress',
        durationMs: 0,
        events: [{ type: 'invoke_start', at: new Date('2026-03-08T10:00:05.000Z').getTime(), summary: 'started' }],
      },
      {
        traceId: 'trace-successfully-completed-abcdef',
        sessionKey: 'session-1',
        flow: 'reaction',
        startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
        outcome: 'success',
        durationMs: 1450,
        events: [
          { type: 'invoke_start', at: new Date('2026-03-08T10:00:00.000Z').getTime(), summary: 'started' },
          { type: 'invoke_end', at: new Date('2026-03-08T10:00:01.450Z').getTime(), ok: true },
        ],
      },
    ];

    const rendered = renderTraceList(traces);

    expect(rendered).toContain('Recent traces');
    expect(rendered).toContain('Started   Flow      Outcome      Events  Duration  Trace ID');
    expect(rendered).toContain('10:00:05  message   in_progress  1       running   trace-running');
    expect(rendered).toContain('10:00:00  reaction  success      2       1.4s');
    expect(rendered).toContain('trace-successfully-completed-abcdef');
  });
});

describe('renderTraceDetail', () => {
  it('renders a readable event timeline with relative timestamps', () => {
    const trace: RunTrace = {
      traceId: 'trace-123',
      sessionKey: 'session-abc',
      flow: 'message',
      startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
      outcome: 'error',
      durationMs: 1700,
      events: [
        {
          type: 'invoke_start',
          at: new Date('2026-03-08T10:00:00.000Z').getTime(),
          summary: 'message received',
          promptPreview: 'hello world',
        },
        {
          type: 'tool_start',
          at: new Date('2026-03-08T10:00:00.250Z').getTime(),
          toolName: 'shell',
          callId: 'call-1',
          inputSummary: 'ls -la',
        },
        {
          type: 'tool_end',
          at: new Date('2026-03-08T10:00:01.000Z').getTime(),
          toolName: 'shell',
          ok: true,
          callId: 'call-1',
          durationMs: 750,
          outputSummary: 'completed',
        },
        {
          type: 'action_result',
          at: new Date('2026-03-08T10:00:01.200Z').getTime(),
          action: 'discord.reply',
          ok: true,
          detail: 'sent operator update',
        },
        {
          type: 'error',
          at: new Date('2026-03-08T10:00:01.500Z').getTime(),
          name: 'RuntimeError',
          message: 'boom',
          stage: 'runtime',
        },
        {
          type: 'invoke_end',
          at: new Date('2026-03-08T10:00:01.700Z').getTime(),
          ok: false,
          summary: 'run failed',
        },
      ],
    };

    const rendered = renderTraceDetail(trace);

    expect(rendered).toContain('Trace trace-123');
    expect(rendered).toContain('Flow: message | Session: session-abc | Outcome: error | Duration: 1.7s');
    expect(rendered).toContain('Started: 2026-03-08T10:00:00.000Z');
    expect(rendered).toContain('+    0ms  INVOKE START  message received | prompt="hello world"');
    expect(rendered).toContain('+  250ms  TOOL START    shell | call=call-1 | ls -la');
    expect(rendered).toContain('+ 1000ms  TOOL END      shell | ok | call=call-1 | duration=750ms | completed');
    expect(rendered).toContain('+ 1200ms  ACTION        discord.reply | ok | sent operator update');
    expect(rendered).toContain('+ 1500ms  ERROR         RuntimeError: boom | stage=runtime');
    expect(rendered).toContain('+ 1700ms  INVOKE END    failed | run failed');
  });

  it('renders traces with no events', () => {
    const trace: RunTrace = {
      traceId: 'trace-empty',
      sessionKey: 'session-empty',
      flow: 'message',
      startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
      outcome: 'in_progress',
      durationMs: 0,
      events: [],
    };

    const rendered = renderTraceDetail(trace);

    expect(rendered).toContain('Trace trace-empty');
    expect(rendered).toContain('Outcome: in_progress | Duration: running');
    expect(rendered).toContain('(no events)');
  });
});
