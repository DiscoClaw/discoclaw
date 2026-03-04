import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GLOBAL_SUPERVISOR_BAIL_PREFIX,
  GLOBAL_SUPERVISOR_ENABLED_ENV,
  isGlobalSupervisorEnabled,
  parseGlobalSupervisorBail,
  withGlobalSupervisor,
} from './global-supervisor.js';
import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from './types.js';

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

function extractAudit(events: EngineEvent[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const evt of events) {
    if (evt.type !== 'log_line') continue;
    try {
      const parsed = JSON.parse(evt.line) as Record<string, unknown>;
      if (parsed['source'] === 'global_supervisor') out.push(parsed);
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

function findBailError(events: EngineEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.type === 'error' && evt.message.startsWith(`${GLOBAL_SUPERVISOR_BAIL_PREFIX} `)) {
      return evt.message;
    }
  }
  return null;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isGlobalSupervisorEnabled', () => {
  it('defaults to false', () => {
    expect(isGlobalSupervisorEnabled({})).toBe(false);
  });

  it('accepts truthy env variants', () => {
    expect(isGlobalSupervisorEnabled({ [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' })).toBe(true);
    expect(isGlobalSupervisorEnabled({ [GLOBAL_SUPERVISOR_ENABLED_ENV]: 'true' })).toBe(true);
    expect(isGlobalSupervisorEnabled({ [GLOBAL_SUPERVISOR_ENABLED_ENV]: 'yes' })).toBe(true);
    expect(isGlobalSupervisorEnabled({ [GLOBAL_SUPERVISOR_ENABLED_ENV]: 'on' })).toBe(true);
  });
});

describe('withGlobalSupervisor', () => {
  it('is a no-op when disabled', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, { env: {} });
    expect(wrapped).toBe(runtime);

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    expect(events).toEqual([
      { type: 'text_final', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('honors explicit enabled=false even when env is set', () => {
    vi.stubEnv(GLOBAL_SUPERVISOR_ENABLED_ENV, '1');

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, { enabled: false });
    expect(wrapped).toBe(runtime);
  });

  it('emits cycle audit events and completes on first successful cycle', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'hello' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractAudit(events);

    expect(audit.some((a) => a['phase'] === 'plan')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'execute')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'evaluate')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'complete')).toBe(true);
    expect(events.some((e) => e.type === 'text_final' && e.text === 'hello')).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('retries transient failures and escalates the next cycle prompt', async () => {
    const invocations: RuntimeInvokeParams[] = [];
    let calls = 0;

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        calls += 1;
        invocations.push(params);

        if (calls === 1) {
          yield { type: 'error', message: 'OpenAI API error: 429 rate limit' };
          yield { type: 'done' };
          return;
        }

        yield { type: 'text_final', text: 'success on retry' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      limits: { maxCycles: 4, maxRetries: 3 },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractAudit(events);

    expect(calls).toBe(2);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'retry')).toBe(true);
    expect(events.some((e) => e.type === 'text_final' && e.text === 'success on retry')).toBe(true);
    expect(findBailError(events)).toBeNull();
    expect(invocations[1]?.systemPrompt ?? '').toContain('Global Supervisor escalation');
  });

  it('blocks deterministic retries when the same failure signature repeats', async () => {
    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        yield { type: 'error', message: 'OpenAI API error: 429 overloaded' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      limits: { maxCycles: 5, maxRetries: 5 },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const bailMsg = findBailError(events);
    const bail = bailMsg ? parseGlobalSupervisorBail(bailMsg) : null;

    expect(calls).toBe(2);
    expect(bail).not.toBeNull();
    expect(bail?.reason).toBe('deterministic_retry_blocked');
    expect(bail?.retryable).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('produces structured bail handoff on non-retryable failures', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'error', message: 'aborted by caller' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const bailMsg = findBailError(events);
    const bail = bailMsg ? parseGlobalSupervisorBail(bailMsg) : null;

    expect(bail).not.toBeNull();
    expect(bail?.reason).toBe('non_retryable_failure');
    expect(bail?.failureKind).toBe('aborted');
    expect(bail?.cycle).toBe(1);
  });

  it('allows per-invocation supervisor disable override', async () => {
    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        yield { type: 'text_final', text: 'direct' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    const events = await collectEvents(wrapped.invoke({
      prompt: 'x',
      model: 'm',
      cwd: '/tmp',
      supervisor: { enabled: false },
    }));

    expect(calls).toBe(1);
    expect(extractAudit(events)).toHaveLength(0);
    expect(events).toEqual([
      { type: 'text_final', text: 'direct' },
      { type: 'done' },
    ]);
  });

  it('treats aborted failures as retryable for plan_phase profile', async () => {
    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: 'error', message: 'aborted by caller' };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text_final', text: 'success after abort retry' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    const events = await collectEvents(wrapped.invoke({
      prompt: 'x',
      model: 'm',
      cwd: '/tmp',
      supervisor: { profile: 'plan_phase' },
    }));
    const audit = extractAudit(events);

    expect(calls).toBe(2);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'retry')).toBe(true);
    expect(findBailError(events)).toBeNull();
    expect(events.some((evt) => evt.type === 'text_final' && evt.text === 'success after abort retry')).toBe(true);
  });

  it('allows additional deterministic retries for plan_phase profile', async () => {
    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        yield { type: 'error', message: 'OpenAI API error: 429 overloaded' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      limits: { maxCycles: 10, maxRetries: 10 },
    });

    const events = await collectEvents(wrapped.invoke({
      prompt: 'x',
      model: 'm',
      cwd: '/tmp',
      supervisor: { profile: 'plan_phase' },
    }));
    const bailMsg = findBailError(events);
    const bail = bailMsg ? parseGlobalSupervisorBail(bailMsg) : null;

    expect(calls).toBe(4);
    expect(bail?.reason).toBe('deterministic_retry_blocked');
  });

  it('bails when max cycle limit is reached', async () => {
    let calls = 0;
    const messages = ['timeout alpha', 'timeout beta', 'timeout gamma'];

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        const msg = messages[Math.min(calls, messages.length - 1)]!;
        calls += 1;
        yield { type: 'error', message: msg };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      limits: { maxCycles: 2, maxRetries: 5 },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const bailMsg = findBailError(events);
    const bail = bailMsg ? parseGlobalSupervisorBail(bailMsg) : null;

    expect(calls).toBe(2);
    expect(bail?.reason).toBe('max_cycles_exceeded');
  });

  it('enforces maxTotalEvents global limit', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'text_delta', text: 'b' };
        yield { type: 'text_delta', text: 'c' };
        yield { type: 'done' };
      },
    };

    const wrapped = withGlobalSupervisor(runtime, {
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      limits: { maxTotalEvents: 2, maxCycles: 5, maxRetries: 5 },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const bailMsg = findBailError(events);
    const bail = bailMsg ? parseGlobalSupervisorBail(bailMsg) : null;

    expect(bail?.reason).toBe('max_events_exceeded');
    expect(bail?.failureKind).toBe('event_limit');
  });
});
