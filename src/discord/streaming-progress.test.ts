import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { createStreamingProgress } from './streaming-progress.js';
import {
  RUNTIME_SIGNAL_FALLBACK_IDLE_MS,
  RUNTIME_SIGNAL_SUPPRESSED_LINE,
} from './runtime-signal-budget.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeMessage() {
  const edits: string[] = [];
  const message = {
    edit: vi.fn(async (opts: { content: string }) => {
      edits.push(opts.content);
    }),
    edits,
  };
  return message;
}

function firstFencedContentLines(rendered: string): string[] {
  const open = '```text\n';
  const start = rendered.indexOf(open);
  if (start < 0) return [];
  const bodyStart = start + open.length;
  const end = rendered.indexOf('\n```', bodyStart);
  if (end < 0) return [];
  return rendered.slice(bodyStart, end).split('\n');
}

describe('createStreamingProgress', () => {
  it('onProgress edits the message with the provided text', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase 1 running...');

    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(message.edits[0]).toBe('Phase 1 running...');
    ctrl.dispose();
  });

  it('onProgress respects the throttle when force is not set', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 5000);

    await ctrl.onProgress('first');
    await ctrl.onProgress('second'); // within throttle window

    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(message.edits[0]).toBe('first');
    ctrl.dispose();
  });

  it('onProgress with force: true bypasses the throttle', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 5000);

    await ctrl.onProgress('first');
    await ctrl.onProgress('second', { force: true });

    expect(message.edit).toHaveBeenCalledTimes(2);
    expect(message.edits[1]).toBe('second');
    ctrl.dispose();
  });

  it('onEvent feeds events into the queue and keepalive interval drives edits', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 5000);

    await ctrl.onProgress('Phase start', { force: true });
    // Simulate a tool use event so the TAQ emits show_activity
    ctrl.onEvent({ type: 'tool_start', name: 'Read', input: '' } as EngineEvent);

    // Advance past STREAMING_EDIT_INTERVAL_MS (1250ms)
    await vi.advanceTimersByTimeAsync(1300);

    // The keepalive interval should have fired and edited with streaming content
    expect(message.edit.mock.calls.length).toBeGreaterThan(1);
    ctrl.dispose();
  });

  it('tool_start with narration deltas renders preview edits before tool_end', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'tool_start', name: 'Bash', input: { command: 'sleep 2' } } as EngineEvent);
    ctrl.onEvent({ type: 'text_delta', text: 'fetching context...' } as EngineEvent);

    await vi.advanceTimersByTimeAsync(2600);

    const streamedEdits = message.edits.slice(1);
    expect(streamedEdits.some((edit) => edit.includes('fetching context...'))).toBe(true);
    expect(streamedEdits.some((edit) => edit.includes('finished.'))).toBe(false);
    ctrl.dispose();
  });

  it('repeated narration chunks produce repeated preview edits on cadence', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'tool_start', name: 'Bash', input: { command: 'long run' } } as EngineEvent);

    ctrl.onEvent({ type: 'text_delta', text: 'alpha ' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(2600);
    const alphaEdit = message.edits.findIndex((edit) => edit.includes('alpha '));
    expect(alphaEdit).toBeGreaterThan(-1);

    ctrl.onEvent({ type: 'text_delta', text: 'beta ' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(2600);
    const betaEdit = message.edits.findIndex((edit) => edit.includes('alpha beta '));
    expect(betaEdit).toBeGreaterThan(alphaEdit);

    ctrl.onEvent({ type: 'text_delta', text: 'gamma' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(2600);
    const gammaEdit = message.edits.findIndex((edit) => edit.includes('alpha beta gamma'));
    expect(gammaEdit).toBeGreaterThan(betaEdit);
    expect(message.edits.some((edit) => edit.includes('finished.'))).toBe(false);
    ctrl.dispose();
  });

  it('onEvent emits visible tool/log/usage runtime signal lines', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'tool_start', name: 'Read', input: '' } as EngineEvent);
    ctrl.onEvent({
      type: 'log_line',
      stream: 'stdout',
      line: 'reading <discord-action>{"type":"noop"}</discord-action> file',
    } as EngineEvent);
    ctrl.onEvent({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      costUsd: 0.0012,
    } as EngineEvent);
    ctrl.onEvent({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'command_execution',
    } as EngineEvent);
    ctrl.onEvent({ type: 'tool_end', name: 'Read', output: '', ok: true } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const allEdits = message.edits.join('\n');
    expect(allEdits).toContain('Next check: Read.');
    expect(allEdits).toContain('Update: reading file');
    expect(allEdits).toContain('Usage: in 11, out 7, total 18, cost $0.0012.');
    expect(allEdits).toContain('Command Execution completed.');
    expect(allEdits).toContain('Finding: Read finished.');
    expect(allEdits).not.toContain('<discord-action>');
    ctrl.dispose();
  });

  it('supports raw stream preview mode for richer runtime signals and wider tails', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0, { streamPreviewMode: 'raw' });

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({
      type: 'tool_start',
      name: 'Bash',
      input: {
        command: 'echo hi <discord-action>{"type":"noop"}</discord-action>',
      },
    } as EngineEvent);
    ctrl.onEvent({
      type: 'log_line',
      stream: 'stdout',
      line: `runtime ${'x'.repeat(95)} <discord-action>{"type":"noop"}</discord-action> done`,
    } as EngineEvent);
    ctrl.onEvent({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      costUsd: 0.0012,
    } as EngineEvent);
    ctrl.onEvent({
      type: 'tool_end',
      name: 'Bash',
      output: 'ok <discord-action>{"type":"noop"}</discord-action>',
      ok: true,
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const allEdits = message.edits.join('\n');
    expect(allEdits).toContain('Next check: Bash.');
    expect(allEdits).toContain('Usage: in 11, out 7, total 18, cost $0.001200.');
    expect(allEdits).toContain('Finding: Bash finished.');
    expect(allEdits).toContain('Update: runtime');
    expect(allEdits).not.toContain('input=');
    expect(allEdits).not.toContain('output=');
    expect(allEdits).not.toContain('<discord-action>');

    const lastEdit = message.edits[message.edits.length - 1]!;
    const rawLines = firstFencedContentLines(lastEdit);
    expect(rawLines).toHaveLength(14);
    expect(rawLines.some((line) => line.length > 72)).toBe(true);
    ctrl.dispose();
  });

  it('tool activity no longer clears recent preview lines mid-run', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({
      type: 'log_line',
      stream: 'stdout',
      line: 'warmup complete',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    ctrl.onEvent({
      type: 'tool_start',
      name: 'Bash',
      input: { command: 'echo test' },
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const lastEdit = message.edits[message.edits.length - 1]!;
    expect(lastEdit).toContain('Update: warmup complete');
    expect(lastEdit).toContain('Next check: Bash.');
    ctrl.dispose();
  });

  it('onProgress resets the queue so stale streaming state is cleared between phases', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    // Feed some streaming state
    ctrl.onEvent({
      type: 'log_line',
      stream: 'stdout',
      line: 'phase-1 stale signal',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    // New phase boundary
    await ctrl.onProgress('Phase 2 starting...', { force: true });
    ctrl.onEvent({ type: 'tool_start', name: 'Read', input: '' } as EngineEvent);

    // Advance interval — should not show stale text since queue was reset
    await vi.advanceTimersByTimeAsync(1300);

    const lastEdit = message.edits[message.edits.length - 1]!;
    expect(lastEdit).not.toContain('phase-1 stale signal');
    expect(lastEdit).toContain('Next check: Read.');
    ctrl.dispose();
  });

  it('keeps runtime event payloads unchanged while adapting display text', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    const evt = {
      type: 'tool_start',
      name: 'Read',
      input: { path: '/tmp/file.ts', flags: ['r'] },
    } as EngineEvent;
    const original = JSON.parse(JSON.stringify(evt));
    ctrl.onEvent(evt);
    await vi.advanceTimersByTimeAsync(1300);

    expect(evt).toEqual(original);
    ctrl.dispose();
  });

  it('redacts structured json payload fragments from visible runtime updates', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({
      type: 'log_line',
      stream: 'stdout',
      line: 'runtime emitted {"type":"status","step":"draft"}',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const allEdits = message.edits.join('\n');
    expect(allEdits).toContain('Runtime update (details omitted).');
    expect(allEdits).not.toContain('"type":"status"');
    ctrl.dispose();
  });

  it('caps runtime signal lines and appends one suppression marker', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    for (let i = 1; i <= 14; i++) {
      ctrl.onEvent({
        type: 'log_line',
        stream: 'stdout',
        line: `signal-${i.toString().padStart(2, '0')}`,
      } as EngineEvent);
    }
    await vi.advanceTimersByTimeAsync(1300);

    const allEdits = message.edits.join('\n');
    expect(allEdits).toContain(RUNTIME_SIGNAL_SUPPRESSED_LINE);
    expect(allEdits).not.toContain('signal-14');
    ctrl.dispose();
  });

  it('resets runtime signal suppression budget at phase boundaries', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase 1 start', { force: true });
    for (let i = 1; i <= 20; i++) {
      ctrl.onEvent({
        type: 'log_line',
        stream: 'stdout',
        line: `phase1-signal-${i.toString().padStart(2, '0')}`,
      } as EngineEvent);
    }
    await vi.advanceTimersByTimeAsync(1300);
    const phaseOneEdits = message.edits.join('\n');
    expect(phaseOneEdits).toContain(RUNTIME_SIGNAL_SUPPRESSED_LINE);

    await ctrl.onProgress('Phase 2 start', { force: true });
    ctrl.onEvent({
      type: 'tool_start',
      name: 'Read',
      input: '',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const phaseTwoLastEdit = message.edits[message.edits.length - 1] ?? '';
    expect(phaseTwoLastEdit).toContain('Next check: Read.');
    ctrl.dispose();
  });

  it('reserves signal budget so log spam does not starve lifecycle updates', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    await ctrl.onProgress('Phase start', { force: true });
    for (let i = 1; i <= 30; i++) {
      ctrl.onEvent({
        type: 'log_line',
        stream: 'stdout',
        line: `log-spam-${i.toString().padStart(2, '0')}`,
      } as EngineEvent);
    }
    ctrl.onEvent({ type: 'tool_start', name: 'Read', input: '' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const allEdits = message.edits.join('\n');
    expect(allEdits).toContain('Next check: Read.');
    ctrl.dispose();
  });

  it('uses synthetic runtime signal lines only as fallback while text deltas are active', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0, { useNativeTextFallback: true });

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'text_delta', text: 'thinking stream tick\n' } as EngineEvent);
    ctrl.onEvent({ type: 'log_line', stream: 'stderr', line: 'warning-hidden-while-streaming' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    let latest = message.edits[message.edits.length - 1] ?? '';
    expect(latest).toContain('thinking stream tick');
    expect(latest).not.toContain('warning-hidden-while-streaming');

    await vi.advanceTimersByTimeAsync(RUNTIME_SIGNAL_FALLBACK_IDLE_MS + 10);
    ctrl.onEvent({ type: 'log_line', stream: 'stderr', line: 'warning-visible-after-idle' } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    latest = message.edits[message.edits.length - 1] ?? '';
    expect(latest).toContain('Warning: warning-visible-after-idle');
    ctrl.dispose();
  });

  it('keeps tool lifecycle and non-reasoning preview_debug visible while fallback gating is active', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0, { useNativeTextFallback: true });

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'text_delta', text: 'reasoning stream\n' } as EngineEvent);
    ctrl.onEvent({ type: 'tool_start', name: 'Read', input: '' } as EngineEvent);
    ctrl.onEvent({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'command_execution',
      status: 'in_progress',
    } as EngineEvent);
    ctrl.onEvent({
      type: 'tool_end',
      name: 'Read',
      ok: true,
      output: '',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const latest = message.edits[message.edits.length - 1] ?? '';
    expect(latest).toContain('Next check: Read.');
    expect(latest).toContain('Command Execution started.');
    expect(latest).toContain('Finding: Read finished.');
    ctrl.dispose();
  });

  it('keeps reasoning preview_debug fallback-only while text deltas are active', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0, { useNativeTextFallback: true });

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'text_delta', text: 'reasoning stream\n' } as EngineEvent);
    ctrl.onEvent({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'reasoning',
      status: 'in_progress',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const latest = message.edits[message.edits.length - 1] ?? '';
    expect(latest).not.toContain('Hypothesis: reasoning in progress');
    ctrl.dispose();
  });

  it('keeps failed tool_end visible even when fallback gating is active', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0, { useNativeTextFallback: true });

    await ctrl.onProgress('Phase start', { force: true });
    ctrl.onEvent({ type: 'text_delta', text: 'reasoning stream\n' } as EngineEvent);
    ctrl.onEvent({
      type: 'tool_end',
      name: 'Read',
      ok: false,
      output: 'permission denied',
    } as EngineEvent);
    await vi.advanceTimersByTimeAsync(1300);

    const latest = message.edits[message.edits.length - 1] ?? '';
    expect(latest).toContain('Finding: Read failed.');
    ctrl.dispose();
  });

  it('dispose clears the keepalive interval', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);
    const editsBefore = message.edit.mock.calls.length;

    ctrl.dispose();
    await vi.advanceTimersByTimeAsync(5000);

    // No additional edits from the interval after dispose
    expect(message.edit.mock.calls.length).toBe(editsBefore);
  });

  it('handles deleted-message (code 10008) gracefully — stops editing', async () => {
    const message = makeMessage();
    message.edit.mockRejectedValueOnce(Object.assign(new Error('Unknown Message'), { code: 10008 }));
    const ctrl = createStreamingProgress(message, 0);

    // First call triggers the 10008 error
    await ctrl.onProgress('Starting...');
    // Second call should be silently skipped (progressMessageGone = true)
    await ctrl.onProgress('Next step...', { force: true });

    expect(message.edit).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  it('surfaces archived-thread (50083) as fatal when throwOnFatal is enabled', async () => {
    const message = makeMessage();
    const err50083 = Object.assign(new Error('Thread is archived'), { code: 50083 });
    message.edit.mockRejectedValue(err50083);
    const onFatalError = vi.fn();
    const ctrl = createStreamingProgress(message, 0, { throwOnFatal: true, onFatalError });

    await expect(ctrl.onProgress('Starting...', { force: true })).rejects.toMatchObject({ code: 50083 });
    expect(onFatalError).toHaveBeenCalledTimes(1);
    await expect(ctrl.onProgress('Retry', { force: true })).rejects.toMatchObject({ code: 50083 });
    ctrl.dispose();
  });
});
