import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SPAWN_ACTION_TYPES,
  executeSpawnAction,
  executeSpawnActions,
  spawnActionsPromptSection,
} from './actions-spawn.js';
import type { SpawnContext } from './actions-spawn.js';
import type { ActionContext } from './actions.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ActionContext {
  return {
    guild: {} as any,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

function makeRuntime(events: EngineEvent[]): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    invoke: vi.fn(async function* () {
      for (const event of events) {
        yield event;
      }
    }),
  };
}

function makeSpawnCtx(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    runtime: makeRuntime([{ type: 'text_delta', text: 'Agent output' }, { type: 'done' }]),
    model: 'claude-opus-4',
    cwd: '/tmp/workspace',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPAWN_ACTION_TYPES', () => {
  it('contains spawnAgent', () => {
    expect(SPAWN_ACTION_TYPES.has('spawnAgent')).toBe(true);
  });

  it('does not contain non-spawn types', () => {
    expect(SPAWN_ACTION_TYPES.has('forgeCreate')).toBe(false);
    expect(SPAWN_ACTION_TYPES.has('planRun')).toBe(false);
    expect(SPAWN_ACTION_TYPES.has('cronCreate')).toBe(false);
  });
});

describe('executeSpawnAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('spawnAgent', () => {
    it('returns agent text output as summary', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Say hello' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Agent output');
      }
    });

    it('fails on empty channel', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: '', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a non-empty channel');
    });

    it('fails on whitespace-only channel', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: '   ', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a non-empty channel');
    });

    it('fails on empty prompt', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: '' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a non-empty prompt');
    });

    it('fails on whitespace-only prompt', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: '   ' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a non-empty prompt');
    });

    it('blocks at recursion depth >= 1', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx({ depth: 1 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('recursion depth');
    });

    it('uses label in error messages on runtime error event', async () => {
      const runtime = makeRuntime([{ type: 'error', message: 'Runtime error' }]);
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something', label: 'my-agent' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('my-agent');
        expect(result.error).toContain('Runtime error');
      }
    });

    it('prefers text_final over accumulated text_delta', async () => {
      const runtime = makeRuntime([
        { type: 'text_delta', text: 'partial ' },
        { type: 'text_delta', text: 'output' },
        { type: 'text_final', text: 'Final output' },
        { type: 'done' },
      ]);
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.summary).toBe('Final output');
    });

    it('accumulates multiple text_delta events', async () => {
      const runtime = makeRuntime([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done' },
      ]);
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Greet' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.summary).toBe('Hello world');
    });

    it('handles runtime throw as error result', async () => {
      const runtime: RuntimeAdapter = {
        id: 'other',
        capabilities: new Set(),
        invoke: vi.fn(async function* () {
          throw new Error('connection failed');
        }),
      };
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('connection failed');
    });

    it('returns fallback message with label when agent outputs nothing', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something', label: 'silent-agent' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('silent-agent');
        expect(result.summary).toContain('no output');
      }
    });

    it('uses "agent" as default label in fallback message', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.summary).toContain('agent');
    });

    it('invokes runtime with correct model, cwd, and prompt', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime, model: 'claude-opus-4-6', cwd: '/my/cwd' });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something specific' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
          cwd: '/my/cwd',
          prompt: 'Do something specific',
        }),
      );
    });

    it('action.model overrides spawnCtx.model', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime, model: 'claude-haiku-4-5-20251001' });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Task', model: 'claude-opus-4-6' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-6' }),
      );
    });

    it('passes timeoutMs to runtime invocation', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime, timeoutMs: 30_000 });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Quick task' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
    });

    it('uses default timeout of 120_000 when not specified', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Task' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
    });
  });
});

describe('executeSpawnActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for no actions', async () => {
    const results = await executeSpawnActions([], makeCtx(), makeSpawnCtx());
    expect(results).toEqual([]);
  });

  it('runs a single agent and returns its result', async () => {
    const results = await executeSpawnActions(
      [{ type: 'spawnAgent', channel: 'general', prompt: 'Single task' }],
      makeCtx(),
      makeSpawnCtx(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });

  it('runs multiple agents and returns results in order', async () => {
    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        const n = ++callCount;
        yield { type: 'text_delta' as const, text: `result-${n}` };
        yield { type: 'done' as const };
      }),
    };
    const spawnCtx = makeSpawnCtx({ runtime });

    const results = await executeSpawnActions(
      [
        { type: 'spawnAgent', channel: 'general', prompt: 'First task' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Second task' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Third task' },
      ],
      makeCtx(),
      spawnCtx,
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('respects maxConcurrent limit per batch', async () => {
    let concurrentCount = 0;
    let maxSeen = 0;

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        concurrentCount++;
        maxSeen = Math.max(maxSeen, concurrentCount);
        yield { type: 'text_delta' as const, text: 'ok' };
        yield { type: 'done' as const };
        concurrentCount--;
      }),
    };

    await executeSpawnActions(
      Array.from({ length: 8 }, (_, i) => ({ type: 'spawnAgent' as const, channel: 'general', prompt: `Task ${i}` })),
      makeCtx(),
      makeSpawnCtx({ runtime, maxConcurrent: 3 }),
    );

    expect(maxSeen).toBeLessThanOrEqual(3);
  });

  it('uses default maxConcurrent of 4', async () => {
    let concurrentCount = 0;
    let maxSeen = 0;

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        concurrentCount++;
        maxSeen = Math.max(maxSeen, concurrentCount);
        yield { type: 'text_delta' as const, text: 'ok' };
        yield { type: 'done' as const };
        concurrentCount--;
      }),
    };

    await executeSpawnActions(
      Array.from({ length: 10 }, (_, i) => ({ type: 'spawnAgent' as const, channel: 'general', prompt: `Task ${i}` })),
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(maxSeen).toBeLessThanOrEqual(4);
  });

  it('collects errors without aborting other agents', async () => {
    let callIndex = 0;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        const i = callIndex++;
        if (i === 1) {
          yield { type: 'error' as const, message: 'agent-1 failed' };
        } else {
          yield { type: 'text_delta' as const, text: `result-${i}` };
          yield { type: 'done' as const };
        }
      }),
    };

    const results = await executeSpawnActions(
      [
        { type: 'spawnAgent', channel: 'general', prompt: 'First' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Second' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Third' },
      ],
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    if (!results[1]!.ok) expect(results[1]!.error).toContain('agent-1 failed');
    expect(results[2]!.ok).toBe(true);
  });

  it('all results are ok: false when depth >= 1 (recursion guard)', async () => {
    const results = await executeSpawnActions(
      [
        { type: 'spawnAgent', channel: 'general', prompt: 'First' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Second' },
      ],
      makeCtx(),
      makeSpawnCtx({ depth: 1 }),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
    for (const r of results) {
      if (!r.ok) expect(r.error).toContain('recursion depth');
    }
  });
});

describe('spawnActionsPromptSection', () => {
  it('returns non-empty prompt section containing spawnAgent', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('spawnAgent');
  });

  it('documents the channel field', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('channel');
  });

  it('documents the prompt field', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('prompt');
  });

  it('documents the model field', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('model');
  });

  it('documents the label field', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('label');
  });

  it('mentions parallel execution', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('parallel');
  });

  it('mentions recursion depth guard', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('recursion');
  });

  it('includes a usage example block', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('<discord-action>');
    expect(section).toContain('spawnAgent');
  });
});
