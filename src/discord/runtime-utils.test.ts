import { describe, expect, it, vi } from 'vitest';
import { collectRuntimeText } from './runtime-utils.js';
import type { RuntimeAdapter, EngineEvent, RuntimeInvokeParams } from '../runtime/types.js';

function makeCaptureRuntime(): { runtime: RuntimeAdapter; calls: RuntimeInvokeParams[] } {
  const calls: RuntimeInvokeParams[] = [];
  const runtime: RuntimeAdapter = {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(params) {
      calls.push(params);
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text: 'ok' };
      })();
    },
  };
  return { runtime, calls };
}

function makeMultiEventRuntime(events: EngineEvent[]): RuntimeAdapter {
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke() {
      return (async function* (): AsyncGenerator<EngineEvent> {
        for (const evt of events) yield evt;
      })();
    },
  };
}

describe('collectRuntimeText', () => {
  it('passes sessionKey through to runtime.invoke() when provided', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { sessionKey: 'forge:plan-001:opus:drafter' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionKey).toBe('forge:plan-001:opus:drafter');
  });

  it('does not include sessionKey in invoke params when opts omitted', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionKey).toBeUndefined();
  });

  it('does not include sessionKey when opts has no sessionKey', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { requireFinalEvent: true },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionKey).toBeUndefined();
  });

  it('passes supervisor policy through to runtime.invoke()', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { supervisor: { profile: 'plan_phase', treatAbortedAsRetryable: true } },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.supervisor).toEqual({ profile: 'plan_phase', treatAbortedAsRetryable: true });
  });
});

describe('collectRuntimeText signal', () => {
  it('passes signal through to runtime.invoke() when provided', async () => {
    const { runtime, calls } = makeCaptureRuntime();
    const ac = new AbortController();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { signal: ac.signal },
    );

    expect(calls).toHaveLength(1);
    // Loop detection composes a combined signal via AbortSignal.any(),
    // so it won't be the same reference — but aborting the caller should propagate.
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signal!.aborted).toBe(false);
    ac.abort();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  it('passes caller signal directly when loop detection is disabled', async () => {
    const { runtime, calls } = makeCaptureRuntime();
    const ac = new AbortController();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { signal: ac.signal, loopDetect: false },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(ac.signal);
  });

  it('provides loop-detector signal when opts has no caller signal', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { requireFinalEvent: true },
    );

    expect(calls).toHaveLength(1);
    // Loop detector creates its own AbortController, so a signal is always present.
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not include signal when opts has no signal and loop detection is disabled', async () => {
    const { runtime, calls } = makeCaptureRuntime();

    await collectRuntimeText(
      runtime,
      'hello',
      'test-model',
      '/tmp',
      ['Read'],
      [],
      30000,
      { requireFinalEvent: true, loopDetect: false },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeUndefined();
  });

  it('throws when runtime emits error due to pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const runtime = makeMultiEventRuntime([
      { type: 'error', message: 'aborted' },
    ]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, { signal: ac.signal }),
    ).rejects.toThrow('aborted');
  });
});

describe('collectRuntimeText onEvent', () => {
  it('forwards events to onEvent in order', async () => {
    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'text_final', text: 'hello world' },
    ];
    const runtime = makeMultiEventRuntime(events);
    const received: EngineEvent[] = [];

    await collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, {
      onEvent: (evt) => received.push(evt),
    });

    expect(received).toEqual(events);
  });

  it('return value is unchanged when onEvent is provided', async () => {
    const runtime = makeMultiEventRuntime([{ type: 'text_final', text: 'result text' }]);

    const result = await collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, {
      onEvent: () => { /* discard */ },
    });

    expect(result).toBe('result text');
  });

  it('does not propagate a throwing onEvent', async () => {
    const runtime = makeMultiEventRuntime([{ type: 'text_final', text: 'ok' }]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, {
        onEvent: () => { throw new Error('callback error'); },
      }),
    ).resolves.toBe('ok');
  });

  it('still processes all events even when onEvent throws', async () => {
    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'text_final', text: 'final' },
    ];
    const runtime = makeMultiEventRuntime(events);
    const callCount = { n: 0 };

    const result = await collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, {
      onEvent: () => { callCount.n++; throw new Error('oops'); },
    });

    expect(callCount.n).toBe(2);
    expect(result).toBe('final');
  });
});

describe('collectRuntimeText strict completion contract', () => {
  it('throws when requireDoneEvent is true and runtime never emits done', async () => {
    const runtime = makeMultiEventRuntime([{ type: 'text_final', text: 'ok' }]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, { requireDoneEvent: true }),
    ).rejects.toThrow('without done event');
  });

  it('returns final text when requireDoneEvent is true and runtime emits done', async () => {
    const runtime = makeMultiEventRuntime([
      { type: 'text_final', text: 'ok' },
      { type: 'done' },
    ]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, { requireDoneEvent: true }),
    ).resolves.toBe('ok');
  });

  it('ignores text_delta emitted after text_final and before done', async () => {
    const runtime = makeMultiEventRuntime([
      { type: 'text_delta', text: 'partial text' },
      { type: 'text_final', text: 'final text' },
      { type: 'text_delta', text: '\n[progress] still working' },
      { type: 'done' },
    ]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, { requireDoneEvent: true }),
    ).resolves.toBe('final text');
  });

  it('throws when runtime emits any event after done', async () => {
    const runtime = makeMultiEventRuntime([
      { type: 'text_final', text: 'ok' },
      { type: 'done' },
      { type: 'text_delta', text: 'late text' },
    ]);

    await expect(
      collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000, { requireDoneEvent: true }),
    ).rejects.toThrow('after done');
  });
});

describe('collectRuntimeText progress sanitization', () => {
  it('removes [progress] lines from text_final payload', async () => {
    const runtime = makeMultiEventRuntime([
      {
        type: 'text_final',
        text: 'Result line\n[progress] reading files\n[progress] thinking\nFinal answer',
      },
      { type: 'done' },
    ]);

    const result = await collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000);

    expect(result).toBe('Result line\nFinal answer');
  });

  it('removes [progress] lines from delta-only fallback output', async () => {
    const runtime = makeMultiEventRuntime([
      { type: 'text_delta', text: 'Start\n' },
      { type: 'text_delta', text: '[progress] indexing workspace\n' },
      { type: 'text_delta', text: 'Done' },
      { type: 'done' },
    ]);

    const result = await collectRuntimeText(runtime, 'p', 'm', '/tmp', [], [], 30000);

    expect(result).toBe('Start\nDone');
  });
});
