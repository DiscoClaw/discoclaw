import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import type { PlanRunEvent } from './plan-manager.js';
import { adaptPlanRunEventText, adaptRuntimeEventText } from './runtime-event-text-adapter.js';

const STREAM_SANITIZE_FLAG = 'DISCOCLAW_DISABLE_STREAM_SANITIZATION';
const priorStreamSanitizeFlag = process.env[STREAM_SANITIZE_FLAG];

afterEach(() => {
  if (priorStreamSanitizeFlag === undefined) {
    delete process.env[STREAM_SANITIZE_FLAG];
  } else {
    process.env[STREAM_SANITIZE_FLAG] = priorStreamSanitizeFlag;
  }
});

describe('adaptRuntimeEventText', () => {
  it('renders concise tool lifecycle updates', () => {
    expect(adaptRuntimeEventText({ type: 'tool_start', name: 'Read', input: { file: '/tmp/a.ts' } }))
      .toBe('Next check: Read.');
    expect(adaptRuntimeEventText({ type: 'tool_end', name: 'Read', output: { ok: true }, ok: true }))
      .toBe('Finding: Read finished.');
    expect(adaptRuntimeEventText({ type: 'tool_end', name: 'Read', output: { ok: false }, ok: false }))
      .toBe('Finding: Read failed.');
  });

  it('renders sanitized log lines without leaking action tags', () => {
    const text = adaptRuntimeEventText({
      type: 'log_line',
      stream: 'stdout',
      line: 'reading <discord-action>{"type":"noop"}</discord-action> file',
    });
    expect(text).toBe('Update: reading file');
    expect(text).not.toContain('<discord-action>');
  });

  it('redacts structured JSON payloads from logs', () => {
    const stdoutText = adaptRuntimeEventText({
      type: 'log_line',
      stream: 'stdout',
      line: 'runtime payload {"type":"phase_start","planId":"plan-123"}',
    });
    const stderrText = adaptRuntimeEventText({
      type: 'log_line',
      stream: 'stderr',
      line: 'runtime payload {"error":"boom","stack":"trace"}',
    });
    expect(stdoutText).toBe('Runtime update (details omitted).');
    expect(stderrText).toBe('Runtime warning (details omitted).');
    expect(stdoutText).not.toContain('plan-123');
  });

  it('shows raw structured payloads when stream sanitization is disabled', () => {
    process.env[STREAM_SANITIZE_FLAG] = '1';
    const stdoutText = adaptRuntimeEventText({
      type: 'log_line',
      stream: 'stdout',
      line: 'runtime payload {"type":"phase_start","planId":"plan-123"}',
    });
    expect(stdoutText).toBe('Update: runtime payload {"type":"phase_start","planId":"plan-123"}');
  });

  it('formats usage lines with mode-aware cost precision', () => {
    const evt: EngineEvent = {
      type: 'usage',
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      costUsd: 0.0012,
    };
    expect(adaptRuntimeEventText(evt, { mode: 'compact' }))
      .toBe('Usage: in 11, out 7, total 18, cost $0.0012.');
    expect(adaptRuntimeEventText(evt, { mode: 'raw' }))
      .toBe('Usage: in 11, out 7, total 18, cost $0.001200.');
  });

  it('uses fallback text when usage has no numeric fields', () => {
    expect(adaptRuntimeEventText({ type: 'usage' })).toBe('Usage updated.');
  });

  it('renders codex preview_debug lifecycle events', () => {
    expect(adaptRuntimeEventText({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'reasoning',
      status: 'in_progress',
    })).toBe('Hypothesis: reasoning in progress.');

    expect(adaptRuntimeEventText({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'command_execution',
      status: 'completed',
    }, { mode: 'raw' })).toBe('Command Execution completed (completed).');

    expect(adaptRuntimeEventText({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'command_execution <discord-action>{"type":"noop"}</discord-action>',
    })).toBe('Command Execution completed.');
  });

  it('prefers preview_debug labels and sanitizes them', () => {
    expect(adaptRuntimeEventText({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'reasoning',
      label: 'Reasoning: compare <discord-action>{"type":"noop"}</discord-action> options',
    })).toBe('Reasoning: compare options');
  });

  it('formats runtime errors and handles blank messages', () => {
    expect(adaptRuntimeEventText({ type: 'error', message: '   timed out  ' }))
      .toBe('Runtime error: timed out');
    expect(adaptRuntimeEventText({ type: 'error', message: ' \n\t ' }))
      .toBe('Runtime error.');
  });

  it('returns null for non-display event types', () => {
    expect(adaptRuntimeEventText({ type: 'text_delta', text: 'x' })).toBeNull();
    expect(adaptRuntimeEventText({ type: 'text_final', text: 'x' })).toBeNull();
    expect(adaptRuntimeEventText({ type: 'image_data', image: { base64: 'x', mediaType: 'image/png' } })).toBeNull();
    expect(adaptRuntimeEventText({ type: 'done' })).toBeNull();
    expect(adaptRuntimeEventText({ type: 'preview_debug', source: 'codex', phase: 'completed', itemType: 'agent_message' })).toBeNull();
  });

  it('truncates long runtime lines by mode', () => {
    const longLine = `prefix ${'x'.repeat(500)} suffix`;
    const compactText = adaptRuntimeEventText({ type: 'log_line', stream: 'stdout', line: longLine }, { mode: 'compact' });
    const rawText = adaptRuntimeEventText({ type: 'log_line', stream: 'stdout', line: longLine }, { mode: 'raw' });

    expect(compactText).toMatch(/^Update: /);
    expect(rawText).toMatch(/^Update: /);
    expect((compactText ?? '').length).toBeLessThan((rawText ?? '').length);
  });

  it('does not mutate engine events', () => {
    const evt: EngineEvent = {
      type: 'tool_start',
      name: 'Read',
      input: { path: '/tmp/file.ts', flags: ['r'] },
    };
    const before = structuredClone(evt);
    adaptRuntimeEventText(evt);
    expect(evt).toEqual(before);
  });
});

describe('adaptPlanRunEventText', () => {
  it('renders concise phase lifecycle updates without internal ids', () => {
    const start: PlanRunEvent = {
      type: 'phase_start',
      planId: 'plan-042',
      phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
    };
    const done: PlanRunEvent = {
      type: 'phase_complete',
      planId: 'plan-042',
      phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
      status: 'done',
    };
    const failed: PlanRunEvent = {
      type: 'phase_complete',
      planId: 'plan-042',
      phase: { id: 'phase-2', title: 'Second phase', kind: 'audit' },
      status: 'failed',
    };
    const skipped: PlanRunEvent = {
      type: 'phase_complete',
      planId: 'plan-042',
      phase: { id: 'phase-3', title: 'Third phase', kind: 'read' },
      status: 'skipped',
    };

    expect(adaptPlanRunEventText(start)).toBe('Starting phase: First phase...');
    expect(adaptPlanRunEventText(done)).toBe('Phase complete: First phase.');
    expect(adaptPlanRunEventText(failed)).toBe('Phase failed: Second phase.');
    expect(adaptPlanRunEventText(skipped)).toBe('Phase skipped: Third phase.');
    expect(adaptPlanRunEventText(start)).not.toContain('plan-042');
    expect(adaptPlanRunEventText(start)).not.toContain('phase-1');
  });

  it('does not mutate plan run events', () => {
    const evt: PlanRunEvent = {
      type: 'phase_complete',
      planId: 'plan-777',
      phase: { id: 'phase-5', title: 'Wrap up', kind: 'read' },
      status: 'done',
    };
    const before = structuredClone(evt);
    adaptPlanRunEventText(evt);
    expect(evt).toEqual(before);
  });
});
