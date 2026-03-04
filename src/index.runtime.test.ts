import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';
import {
  collectActiveProviders,
  registerRuntimeWithGlobalPolicies,
  resolveFastRuntime,
  wrapRuntimeWithGlobalPolicies,
} from './index.runtime.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { GLOBAL_SUPERVISOR_ENABLED_ENV } from './runtime/global-supervisor.js';
import type { ConcurrencyLimiter } from './runtime/concurrency-limit.js';
import type { EngineEvent, RuntimeAdapter } from './runtime/types.js';

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

function extractGlobalSupervisorAudit(events: EngineEvent[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const evt of events) {
    if (evt.type !== 'log_line') continue;
    try {
      const parsed = JSON.parse(evt.line) as Record<string, unknown>;
      if (parsed['source'] === 'global_supervisor') out.push(parsed);
    } catch {
      // ignore non-JSON log lines
    }
  }
  return out;
}

function configEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'token',
    DISCORD_ALLOW_USER_IDS: '123',
    DISCOCLAW_CRON_FORUM: '1000000000000000001',
    DISCOCLAW_TASKS_FORUM: '1000000000000000002',
    ...overrides,
  };
}

function makeRuntime(id: RuntimeAdapter['id']): RuntimeAdapter {
  return {
    id,
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'text_final', text: id };
      yield { type: 'done' };
    },
  };
}

describe('wrapRuntimeWithGlobalPolicies', () => {
  it('keeps behavior unchanged when global supervisor env is off', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };

    const wrapped = wrapRuntimeWithGlobalPolicies({
      runtime,
      maxConcurrentInvocations: 1,
      env: {},
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractGlobalSupervisorAudit(events);
    expect(events).toEqual([
      { type: 'text_final', text: 'ok' },
      { type: 'done' },
    ]);
    expect(audit).toHaveLength(0);
  });

  it('routes invocations through global supervisor when enabled', async () => {
    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: 'error', message: 'OpenAI API error: 429 rate limit' };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text_final', text: 'success on retry' };
        yield { type: 'done' };
      },
    };

    const wrapped = wrapRuntimeWithGlobalPolicies({
      runtime,
      maxConcurrentInvocations: 1,
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    const events = await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractGlobalSupervisorAudit(events);

    expect(calls).toBe(2);
    expect(audit.some((a) => a['phase'] === 'plan')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'retry')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'complete')).toBe(true);
    expect(events.some((e) => e.type === 'text_final' && e.text === 'success on retry')).toBe(true);
  });

  it('applies wrappers in fixed order: concurrency limiter outside supervisor loop', async () => {
    let calls = 0;
    let acquireCalls = 0;
    let releaseCalls = 0;
    const limiter: ConcurrencyLimiter = {
      max: 1,
      async acquire() {
        acquireCalls += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseCalls += 1;
        };
      },
    };

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: 'error', message: 'temporary timeout' };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };

    const wrapped = wrapRuntimeWithGlobalPolicies({
      runtime,
      maxConcurrentInvocations: 1,
      limiter,
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    await collectEvents(wrapped.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    expect(calls).toBe(2);
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });
});

describe('registerRuntimeWithGlobalPolicies', () => {
  it('registers the wrapped runtime and returns the registered adapter', async () => {
    const runtimeRegistry = new RuntimeRegistry();
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'registered' };
        yield { type: 'done' };
      },
    };

    const registered = registerRuntimeWithGlobalPolicies({
      name: 'openai',
      runtimeRegistry,
      runtime,
      maxConcurrentInvocations: 0,
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
    });

    expect(runtimeRegistry.get('openai')).toBe(registered);

    const events = await collectEvents(registered.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractGlobalSupervisorAudit(events);
    expect(audit.some((a) => a['phase'] === 'plan')).toBe(true);
    expect(events.some((e) => e.type === 'text_final' && e.text === 'registered')).toBe(true);
  });

  it('applies parsed supervisor limits and audit stream via registration options', async () => {
    const runtimeRegistry = new RuntimeRegistry();
    const { config } = parseConfig(configEnv({
      DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED: '1',
      DISCOCLAW_GLOBAL_SUPERVISOR_AUDIT_STREAM: 'stdout',
      DISCOCLAW_GLOBAL_SUPERVISOR_MAX_CYCLES: '5',
      DISCOCLAW_GLOBAL_SUPERVISOR_MAX_RETRIES: '0',
      DISCOCLAW_GLOBAL_SUPERVISOR_MAX_ESCALATION_LEVEL: '3',
      DISCOCLAW_GLOBAL_SUPERVISOR_MAX_TOTAL_EVENTS: '1200',
      DISCOCLAW_GLOBAL_SUPERVISOR_MAX_WALL_TIME_MS: '45000',
    }));

    let calls = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        calls += 1;
        yield { type: 'error', message: 'OpenAI API error: 429 rate limit' };
        yield { type: 'done' };
      },
    };

    const registered = registerRuntimeWithGlobalPolicies({
      name: 'openai',
      runtimeRegistry,
      runtime,
      maxConcurrentInvocations: 0,
      env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      globalSupervisorEnabled: config.globalSupervisorEnabled,
      globalSupervisorAuditStream: config.globalSupervisorAuditStream,
      globalSupervisorLimits: {
        maxCycles: config.globalSupervisorMaxCycles,
        maxRetries: config.globalSupervisorMaxRetries,
        maxEscalationLevel: config.globalSupervisorMaxEscalationLevel,
        maxTotalEvents: config.globalSupervisorMaxTotalEvents,
        maxWallTimeMs: config.globalSupervisorMaxWallTimeMs,
      },
    });

    const events = await collectEvents(registered.invoke({ prompt: 'x', model: 'm', cwd: '/tmp' }));
    const audit = extractGlobalSupervisorAudit(events);

    expect(calls).toBe(1);
    expect(events.some((evt) => evt.type === 'log_line' && evt.stream === 'stdout')).toBe(true);
    expect(audit.some((a) => a['phase'] === 'decide' && a['decision'] === 'bail' && a['reason'] === 'max_retries_exceeded')).toBe(true);
  });
});

describe('resolveFastRuntime', () => {
  it('returns primary runtime when DISCOCLAW_FAST_RUNTIME is unset', () => {
    const runtimeRegistry = new RuntimeRegistry();
    const primary = makeRuntime('codex');
    runtimeRegistry.register('codex', primary);
    const resolved = resolveFastRuntime({
      primaryRuntimeName: 'codex',
      primaryRuntime: primary,
      runtimeRegistry,
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(resolved).toBe(primary);
  });

  it('resolves DISCOCLAW_FAST_RUNTIME to a registered runtime', () => {
    const runtimeRegistry = new RuntimeRegistry();
    const primary = makeRuntime('codex');
    const fast = makeRuntime('openai');
    runtimeRegistry.register('codex', primary);
    runtimeRegistry.register('openai', fast);
    const resolved = resolveFastRuntime({
      primaryRuntimeName: 'codex',
      primaryRuntime: primary,
      fastRuntime: 'openai',
      runtimeRegistry,
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(resolved).toBe(fast);
  });

  it('falls back to primary runtime when DISCOCLAW_FAST_RUNTIME is unknown', () => {
    const runtimeRegistry = new RuntimeRegistry();
    const primary = makeRuntime('codex');
    runtimeRegistry.register('codex', primary);
    const resolved = resolveFastRuntime({
      primaryRuntimeName: 'codex',
      primaryRuntime: primary,
      fastRuntime: 'openai',
      runtimeRegistry,
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(resolved).toBe(primary);
  });
});

describe('collectActiveProviders', () => {
  it('includes fast runtime provider when it differs from primary', () => {
    const providers = collectActiveProviders({
      primaryRuntimeId: 'codex',
      fastRuntime: makeRuntime('openai'),
      forgeCommandsEnabled: false,
      drafterRuntime: undefined,
      auditorRuntime: undefined,
    });
    expect(providers).toEqual(new Set(['codex', 'openai']));
  });
});
