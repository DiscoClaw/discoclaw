import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { createStreamingProgress } from './streaming-progress.js';

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

  it('onProgress resets the queue so stale streaming state is cleared', async () => {
    const message = makeMessage();
    const ctrl = createStreamingProgress(message, 0);

    // Feed some streaming state
    ctrl.onEvent({ type: 'text_delta', text: 'stale text' } as EngineEvent);

    // New phase boundary
    await ctrl.onProgress('Phase 2 starting...', { force: true });

    // Advance interval — should not show stale text since queue was reset
    await vi.advanceTimersByTimeAsync(1300);

    const lastEdit = message.edits[message.edits.length - 1]!;
    // After reset, streaming state is cleared; last edit is the progress message
    // or empty streaming output — not stale text
    expect(lastEdit).not.toContain('stale text');
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
});
