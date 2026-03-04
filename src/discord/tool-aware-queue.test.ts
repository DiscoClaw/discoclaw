import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import type { DisplayAction } from './tool-aware-queue.js';
import { ToolAwareQueue } from './tool-aware-queue.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function collect() {
  const actions: DisplayAction[] = [];
  const emit = (a: DisplayAction) => actions.push(a);
  return { actions, emit };
}

describe('ToolAwareQueue', () => {
  it('emits periodic preview_text during long tool_active when narration is buffered', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, {
      flushDelayMs: 800,
      postToolDelayMs: 500,
      toolActivePreviewIntervalMs: 100,
    });

    taq.handleEvent({ type: 'tool_start', name: 'Bash' });
    taq.handleEvent({ type: 'text_delta', text: 'Working' });

    vi.advanceTimersByTime(99);
    expect(actions.filter((a) => a.type === 'preview_text')).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(actions.filter((a) => a.type === 'preview_text')).toEqual([
      { type: 'preview_text', text: 'Working' },
    ]);

    taq.handleEvent({ type: 'text_delta', text: ' hard' });
    vi.advanceTimersByTime(100);
    expect(actions.filter((a) => a.type === 'preview_text')).toEqual([
      { type: 'preview_text', text: 'Working' },
      { type: 'preview_text', text: 'Working hard' },
    ]);

    taq.dispose();
  });

  it('preview cadence stops after tool_end, error, and dispose', () => {
    const runUntilStop = (stopEvent: EngineEvent | 'dispose') => {
      const { actions, emit } = collect();
      const taq = new ToolAwareQueue(emit, {
        flushDelayMs: 800,
        postToolDelayMs: 500,
        toolActivePreviewIntervalMs: 100,
      });

      taq.handleEvent({ type: 'tool_start', name: 'Bash' });
      taq.handleEvent({ type: 'text_delta', text: 'Streaming preview' });

      vi.advanceTimersByTime(100);
      expect(actions.filter((a) => a.type === 'preview_text')).toHaveLength(1);

      if (stopEvent === 'dispose') {
        taq.dispose();
      } else {
        taq.handleEvent(stopEvent);
      }

      vi.advanceTimersByTime(500);
      expect(actions.filter((a) => a.type === 'preview_text')).toHaveLength(1);

      taq.dispose();
    };

    runUntilStop({ type: 'tool_end', name: 'Bash', ok: true });
    runUntilStop({ type: 'error', message: 'boom' });
    runUntilStop('dispose');
  });

  it('text_final during tool_active still emits only set_final for terminal output', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, {
      flushDelayMs: 800,
      postToolDelayMs: 500,
      toolActivePreviewIntervalMs: 100,
    });

    taq.handleEvent({ type: 'tool_start', name: 'Bash' });
    taq.handleEvent({ type: 'text_delta', text: 'intermediate tool narration' });
    taq.handleEvent({ type: 'text_final', text: 'Final answer' });

    expect(actions.filter((a) => a.type === 'set_final')).toEqual([
      { type: 'set_final', text: 'Final answer' },
    ]);
    expect(actions.filter((a) => a.type === 'stream_text')).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(actions.filter((a) => a.type === 'preview_text')).toHaveLength(0);

    taq.dispose();
  });

  it('text-only response: text deltas buffered then streamed after flush delay', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'Hello ' });
    taq.handleEvent({ type: 'text_delta', text: 'world' });

    // Before flush timer: nothing emitted yet.
    expect(actions).toHaveLength(0);

    // After flush timer fires.
    vi.advanceTimersByTime(800);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'stream_text', text: 'Hello world' });

    // Further deltas stream directly.
    taq.handleEvent({ type: 'text_delta', text: '!' });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ type: 'stream_text', text: '!' });

    taq.dispose();
  });

  it('text then tool: narration discarded, activity shown', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'Let me read the file...' });
    taq.handleEvent({ type: 'tool_start', name: 'Read', input: { file_path: '/tmp/foo.ts' } });

    // Narration was discarded, only show_activity emitted.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'show_activity' });
    expect((actions[0] as any).label).toContain('Reading');

    taq.dispose();
  });

  it('tool then text: activity during tool, text streams after', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'tool_start', name: 'Bash' });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'show_activity', label: 'Running command...' });

    taq.handleEvent({ type: 'tool_end', name: 'Bash', ok: true });

    // After tool ends, start post-tool delay.
    vi.advanceTimersByTime(500);

    // Now text deltas should stream directly.
    taq.handleEvent({ type: 'text_delta', text: 'The result is 42.' });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ type: 'stream_text', text: 'The result is 42.' });

    taq.dispose();
  });

  it('multiple sequential tools: each shows its label, final text streams', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    // First tool.
    taq.handleEvent({ type: 'tool_start', name: 'Read', input: { file_path: '/a/b.ts' } });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'show_activity' });

    taq.handleEvent({ type: 'tool_end', name: 'Read', ok: true });

    // Second tool arrives before post-tool flush.
    taq.handleEvent({ type: 'tool_start', name: 'Bash' });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({ type: 'show_activity', label: 'Running command...' });

    taq.handleEvent({ type: 'tool_end', name: 'Bash', ok: true });

    // Let post-tool flush fire.
    vi.advanceTimersByTime(500);

    // Final text.
    taq.handleEvent({ type: 'text_final', text: 'Done!' });
    expect(actions.find((a) => a.type === 'set_final')).toEqual({ type: 'set_final', text: 'Done!' });

    taq.dispose();
  });

  it('text_final overrides everything', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'buffered' });
    taq.handleEvent({ type: 'text_final', text: 'The final answer.' });

    // Timer should be cancelled, set_final should be emitted.
    const finals = actions.filter((a) => a.type === 'set_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({ type: 'set_final', text: 'The final answer.' });

    // No stream_text for the buffered text.
    expect(actions.filter((a) => a.type === 'stream_text')).toHaveLength(0);

    taq.dispose();
  });

  it('flush timer fires correctly with fake timers', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 3000, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'test' });

    // Not yet.
    vi.advanceTimersByTime(2999);
    expect(actions).toHaveLength(0);

    // Now.
    vi.advanceTimersByTime(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'stream_text', text: 'test' });

    taq.dispose();
  });

  it('dispose() cancels timers', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'will be lost' });
    taq.dispose();

    vi.advanceTimersByTime(5000);
    expect(actions).toHaveLength(0);
  });

  it('post-tool delay prevents flashing narration between tools', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'tool_start', name: 'Read' });
    taq.handleEvent({ type: 'tool_end', name: 'Read', ok: true });

    // Text delta during post-tool delay window.
    taq.handleEvent({ type: 'text_delta', text: 'Now let me run...' });

    // Before post-tool delay fires, second tool starts.
    vi.advanceTimersByTime(200);
    taq.handleEvent({ type: 'tool_start', name: 'Bash' });

    // The narration text should not have been streamed.
    expect(actions.filter((a) => a.type === 'stream_text')).toHaveLength(0);
    // Two show_activity actions.
    expect(actions.filter((a) => a.type === 'show_activity')).toHaveLength(2);

    taq.dispose();
  });

  it('events after dispose() are silently ignored', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_delta', text: 'before' });
    taq.dispose();

    const countAfterDispose = actions.length;

    // These should all be silently dropped.
    taq.handleEvent({ type: 'text_delta', text: 'after' });
    taq.handleEvent({ type: 'tool_start', name: 'Read' });
    taq.handleEvent({ type: 'tool_end', name: 'Read', ok: true });
    taq.handleEvent({ type: 'text_final', text: 'final' });

    vi.advanceTimersByTime(5000);
    expect(actions).toHaveLength(countAfterDispose);
  });

  it('tool_end without prior tool_start does not crash', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    // Orphan tool_end — should be silently ignored (state is idle, not tool_active).
    taq.handleEvent({ type: 'tool_end', name: 'Bash', ok: true });

    // Queue should still function normally after the orphan.
    taq.handleEvent({ type: 'text_delta', text: 'hello' });
    vi.advanceTimersByTime(800);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'stream_text', text: 'hello' });

    taq.dispose();
  });

  it('multiple text_final events: only first is emitted as set_final', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'text_final', text: 'first final' });
    taq.handleEvent({ type: 'text_final', text: 'second final' });

    const finals = actions.filter((a) => a.type === 'set_final');
    expect(finals).toHaveLength(2);
    expect(finals[0]).toEqual({ type: 'set_final', text: 'first final' });
    // Second text_final still emits (no crash), but first is the meaningful one.
    expect(finals[1]).toEqual({ type: 'set_final', text: 'second final' });

    taq.dispose();
  });

  it('text deltas during tool_active are discarded on next tool_start', () => {
    const { actions, emit } = collect();
    const taq = new ToolAwareQueue(emit, { flushDelayMs: 800, postToolDelayMs: 500 });

    taq.handleEvent({ type: 'tool_start', name: 'Read' });
    taq.handleEvent({ type: 'text_delta', text: 'I found...' });
    taq.handleEvent({ type: 'tool_end', name: 'Read', ok: true });

    // Tool end transitions to buffering_text with empty buffer.
    // But the text delta during tool_active was in buffer...
    // Then a new tool arrives before the flush timer.
    taq.handleEvent({ type: 'tool_start', name: 'Bash' });

    // No stream_text should have been emitted.
    expect(actions.filter((a) => a.type === 'stream_text')).toHaveLength(0);

    taq.dispose();
  });
});
