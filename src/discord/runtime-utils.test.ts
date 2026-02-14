import { describe, expect, it } from 'vitest';
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
});
