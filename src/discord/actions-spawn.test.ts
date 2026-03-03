import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  SPAWN_ACTION_TYPES,
  executeSpawnAction,
  executeSpawnActions,
  spawnActionsPromptSection,
} from './actions-spawn.js';
import type { SpawnContext } from './actions-spawn.js';
import type { ActionContext, ActionCategoryFlags } from './actions.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Mock abort-registry
// ---------------------------------------------------------------------------

vi.mock('./abort-registry.js', () => ({
  registerAbort: vi.fn(() => {
    const controller = new AbortController();
    return { signal: controller.signal, dispose: vi.fn() };
  }),
}));

import { registerAbort } from './abort-registry.js';
const mockRegisterAbort = vi.mocked(registerAbort);

// ---------------------------------------------------------------------------
// Mock prompt-common utilities
// ---------------------------------------------------------------------------

vi.mock('./prompt-common.js', () => ({
  resolveEffectiveTools: vi.fn(async () => ({
    effectiveTools: ['Bash', 'Read'],
    permissionTier: 'env',
    permissionNote: undefined,
    runtimeCapabilityNote: undefined,
  })),
  loadWorkspacePaFiles: vi.fn(async () => []),
  buildContextFiles: vi.fn(() => []),
  inlineContextFiles: vi.fn(async () => ''),
  buildPromptPreamble: vi.fn((_ctx: string) => '[ROOT_POLICY]'),
}));

import { resolveEffectiveTools as _resolveEffectiveTools } from './prompt-common.js';
const mockResolveEffectiveTools = vi.mocked(_resolveEffectiveTools);

// ---------------------------------------------------------------------------
// Mock actions module (parseDiscordActions, executeDiscordActions, appendActionResults)
// ---------------------------------------------------------------------------

vi.mock('./actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions.js')>();
  return {
    ...actual,
    parseDiscordActions: vi.fn((_text: string, _flags: ActionCategoryFlags) => ({
      cleanText: _text,
      actions: [],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    })),
    executeDiscordActions: vi.fn(async () => []),
    appendActionResults: vi.fn((body: string) => body),
  };
});

import { parseDiscordActions, executeDiscordActions, appendActionResults } from './actions.js';
const mockParseDiscordActions = vi.mocked(parseDiscordActions);
const mockExecuteDiscordActions = vi.mocked(executeDiscordActions);
const mockAppendActionResults = vi.mocked(appendActionResults);

// ---------------------------------------------------------------------------
// Mock output-common
// ---------------------------------------------------------------------------

vi.mock('./output-common.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./output-common.js')>();
  return {
    ...actual,
    appendUnavailableActionTypesNotice: vi.fn((text: string) => text),
    appendParseFailureNotice: vi.fn((text: string) => text),
  };
});

import { appendUnavailableActionTypesNotice, appendParseFailureNotice } from './output-common.js';
const mockAppendUnavailableNotice = vi.mocked(appendUnavailableActionTypesNotice);
const mockAppendParseFailureNotice = vi.mocked(appendParseFailureNotice);

// ---------------------------------------------------------------------------
// Mock transport-client
// ---------------------------------------------------------------------------

vi.mock('./transport-client.js', () => ({
  DiscordTransportClient: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockChannel() {
  return {
    id: 'ch-general',
    name: 'general',
    type: ChannelType.GuildText,
    send: vi.fn(async () => ({ id: 'sent-1' })),
  };
}

function makeCtx(channel?: ReturnType<typeof makeMockChannel>): ActionContext {
  const ch = channel ?? makeMockChannel();
  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => id === ch.id ? ch : undefined,
          find: (fn: (c: any) => boolean) => fn(ch) ? ch : undefined,
        },
      },
    } as any,
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
    runtimeTools: ['Bash', 'Read', 'Write'],
    workspaceCwd: '/tmp/workspace',
    useGroupDirCwd: false,
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
    it('posts agent text output to target channel', async () => {
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Say hello' },
        makeCtx(channel),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Agent output' }),
      );
    });

    it('returns summary indicating agent posted to channel', async () => {
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Say hello' },
        makeCtx(channel),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('#general');
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

    it('fails when channel is not found', async () => {
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'nonexistent', prompt: 'Do something' },
        makeCtx(),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not found');
    });

    it('fails when channel is a non-text type', async () => {
      const forumChannel = { id: 'ch-forum', name: 'ideas', type: ChannelType.GuildForum, send: vi.fn() };
      const ctx: ActionContext = {
        guild: {
          channels: {
            cache: {
              get: (id: string) => id === forumChannel.id ? forumChannel : undefined,
              find: (fn: (c: any) => boolean) => fn(forumChannel) ? forumChannel : undefined,
            },
          },
        } as any,
        client: {} as any,
        channelId: 'test-channel',
        messageId: 'test-message',
      };
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'ideas', prompt: 'Do something' },
        ctx,
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('forum');
      }
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

    it('prefers text_final over accumulated text_delta and posts to channel', async () => {
      const runtime = makeRuntime([
        { type: 'text_delta', text: 'partial ' },
        { type: 'text_delta', text: 'output' },
        { type: 'text_final', text: 'Final output' },
        { type: 'done' },
      ]);
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(channel),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Final output' }),
      );
    });

    it('accumulates multiple text_delta events and posts combined text to channel', async () => {
      const runtime = makeRuntime([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done' },
      ]);
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Greet' },
        makeCtx(channel),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Hello world' }),
      );
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

    it('posts fallback message with label to channel when agent outputs nothing', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something', label: 'silent-agent' },
        makeCtx(channel),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('silent-agent') }),
      );
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('no output') }),
      );
    });

    it('uses "agent" as default label in fallback message', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(channel),
        makeSpawnCtx({ runtime }),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('agent') }),
      );
    });

    it('invokes runtime with correct model, cwd, and prompt', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime, model: 'claude-opus-4-6', workspaceCwd: '/my/cwd' });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something specific' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
          cwd: '/my/cwd',
          prompt: expect.stringContaining('Do something specific'),
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

    it('posts output without allowed mentions', async () => {
      const channel = makeMockChannel();
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Say hello' },
        makeCtx(channel),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ allowedMentions: expect.objectContaining({ parse: [] }) }),
      );
    });

    it('handles channel.send error as error result', async () => {
      const channel = { ...makeMockChannel(), send: vi.fn(async () => { throw new Error('Missing Access'); }) };
      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
        makeCtx(channel),
        makeSpawnCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Missing Access');
    });

    it('passes tools and addDirs to runtime.invoke when context is configured', async () => {
      mockResolveEffectiveTools.mockResolvedValueOnce({
        effectiveTools: ['Bash', 'Read'],
        permissionTier: 'env',
        permissionNote: undefined,
        runtimeCapabilityNote: undefined,
      });
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({
        runtime,
        useGroupDirCwd: true,
        discordChannelContext: {
          contentDir: '/tmp/content',
          indexPath: '/tmp/content/discord/DISCORD.md',
          paContextFiles: [],
          channelsDir: '/tmp/content/discord/channels',
          byChannelId: new Map(),
          dmContextPath: '/tmp/content/discord/channels/dm.md',
        },
      });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
        makeCtx(),
        spawnCtx,
      );

      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ['Bash', 'Read'],
          addDirs: ['/tmp/workspace', '/tmp/content'],
        }),
      );
    });

    it('includes root policy preamble in the prompt passed to runtime.invoke', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Test task' },
        makeCtx(),
        spawnCtx,
      );

      const invokeCall = (runtime.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(invokeCall.prompt).toContain('[ROOT_POLICY]');
      expect(invokeCall.prompt).toContain('Test task');
    });

    it('falls back to base runtimeTools when resolveEffectiveTools throws', async () => {
      mockResolveEffectiveTools.mockRejectedValueOnce(new Error('permission error'));
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({ runtime });

      const result = await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
        makeCtx(),
        spawnCtx,
      );

      expect(result.ok).toBe(true);
      expect(runtime.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ tools: ['Bash', 'Read', 'Write'] }),
      );
    });

    it('omits addDirs when useGroupDirCwd is false and no discordChannelContext', async () => {
      const runtime = makeRuntime([{ type: 'done' }]);
      const spawnCtx = makeSpawnCtx({
        runtime,
        useGroupDirCwd: false,
        discordChannelContext: undefined,
      });

      await executeSpawnAction(
        { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
        makeCtx(),
        spawnCtx,
      );

      const invokeCall = (runtime.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(invokeCall.addDirs).toBeUndefined();
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

  it('warns about no conversation history (context isolation)', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('no conversation history');
  });

  it('includes a usage example block', () => {
    const section = spawnActionsPromptSection();
    expect(section).toContain('<discord-action>');
    expect(section).toContain('spawnAgent');
  });
});

// ---------------------------------------------------------------------------
// Action parsing on spawn output
// ---------------------------------------------------------------------------

function makeActionFlags(): ActionCategoryFlags {
  return {
    channels: false,
    messaging: true,
    guild: false,
    moderation: false,
    polls: false,
    tasks: true,
    crons: false,
    botProfile: false,
    forge: false,
    plan: false,
    memory: false,
    defer: false,
    config: false,
  };
}

describe('executeSpawnAction — action parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock implementations
    mockParseDiscordActions.mockImplementation((_text, _flags) => ({
      cleanText: _text,
      actions: [],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    }));
    mockExecuteDiscordActions.mockResolvedValue([]);
    mockAppendActionResults.mockImplementation((body) => body);
    mockAppendUnavailableNotice.mockImplementation((text) => text);
    mockAppendParseFailureNotice.mockImplementation((text) => text);
  });

  it('parses action blocks and strips them from posted text', async () => {
    const rawOutput = 'Here is some text\n<discord-action>{"type":"taskCreate","title":"test"}</discord-action>\nMore text';
    const runtime = makeRuntime([
      { type: 'text_delta', text: rawOutput },
      { type: 'done' },
    ]);

    mockParseDiscordActions.mockReturnValueOnce({
      cleanText: 'Here is some text\n\nMore text',
      actions: [{ type: 'taskCreate', title: 'test' } as any],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    mockExecuteDiscordActions.mockResolvedValueOnce([{ ok: true, summary: 'Task created' }]);
    mockAppendActionResults.mockReturnValueOnce('Here is some text\n\nMore text\nDone: Task created');

    const channel = makeMockChannel();
    const result = await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Create a task' },
      makeCtx(channel),
      makeSpawnCtx({ runtime, actionFlags: makeActionFlags() }),
    );

    expect(result.ok).toBe(true);
    expect(mockParseDiscordActions).toHaveBeenCalledWith(rawOutput, expect.objectContaining({ messaging: true }));
    expect(mockExecuteDiscordActions).toHaveBeenCalledTimes(1);
    // The posted text should be the cleaned text with results appended
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Here is some text') }),
    );
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('<discord-action>') }),
    );
  });

  it('appends action results to posted output', async () => {
    const runtime = makeRuntime([
      { type: 'text_delta', text: 'Some output' },
      { type: 'done' },
    ]);

    mockParseDiscordActions.mockReturnValueOnce({
      cleanText: 'Some output',
      actions: [{ type: 'taskCreate', title: 'test' } as any],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    mockExecuteDiscordActions.mockResolvedValueOnce([{ ok: true, summary: 'Task created: test' }]);
    mockAppendActionResults.mockReturnValueOnce('Some output\nDone: Task created: test');

    const channel = makeMockChannel();
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(channel),
      makeSpawnCtx({ runtime, actionFlags: makeActionFlags() }),
    );

    expect(mockAppendActionResults).toHaveBeenCalledWith(
      'Some output',
      expect.arrayContaining([expect.objectContaining({ type: 'taskCreate' })]),
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Done: Task created: test') }),
    );
  });

  it('posts raw text unchanged when actionFlags is not provided (backward compat)', async () => {
    const rawOutput = 'Raw text with <discord-action>{"type":"taskCreate"}</discord-action>';
    const runtime = makeRuntime([
      { type: 'text_delta', text: rawOutput },
      { type: 'done' },
    ]);

    const channel = makeMockChannel();
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do something' },
      makeCtx(channel),
      makeSpawnCtx({ runtime }), // no actionFlags
    );

    // parseDiscordActions should NOT be called
    expect(mockParseDiscordActions).not.toHaveBeenCalled();
    // The raw text (including action blocks) should be posted as-is
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: rawOutput }),
    );
  });

  it('posts cleaned text with error appended when action execution fails', async () => {
    const runtime = makeRuntime([
      { type: 'text_delta', text: 'Agent text' },
      { type: 'done' },
    ]);

    mockParseDiscordActions.mockReturnValueOnce({
      cleanText: 'Agent text',
      actions: [{ type: 'taskCreate', title: 'test' } as any],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    mockExecuteDiscordActions.mockResolvedValueOnce([{ ok: false, error: 'Missing permissions' }]);
    mockAppendActionResults.mockReturnValueOnce('Agent text\nFailed: Missing permissions');

    const channel = makeMockChannel();
    const result = await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Create task' },
      makeCtx(channel),
      makeSpawnCtx({ runtime, actionFlags: makeActionFlags() }),
    );

    expect(result.ok).toBe(true); // The spawn itself succeeded
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Failed: Missing permissions') }),
    );
  });

  it('does not parse action blocks inside code fences', async () => {
    const rawOutput = '```\n<discord-action>{"type":"taskCreate"}</discord-action>\n```';
    const runtime = makeRuntime([
      { type: 'text_delta', text: rawOutput },
      { type: 'done' },
    ]);

    // parseDiscordActions should return no actions (block is inside code fence)
    mockParseDiscordActions.mockReturnValueOnce({
      cleanText: rawOutput,
      actions: [],
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const channel = makeMockChannel();
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Show example' },
      makeCtx(channel),
      makeSpawnCtx({ runtime, actionFlags: makeActionFlags() }),
    );

    expect(mockExecuteDiscordActions).not.toHaveBeenCalled();
    // Text should be posted as-is (code fence preserved)
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: rawOutput }),
    );
  });
});

// ---------------------------------------------------------------------------
// Abort registry integration
// ---------------------------------------------------------------------------

describe('executeSpawnAction — abort registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers in abort registry and passes signal to runtime.invoke', async () => {
    const abortSignal = new AbortController().signal;
    const dispose = vi.fn();
    mockRegisterAbort.mockReturnValueOnce({ signal: abortSignal, dispose });

    const runtime = makeRuntime([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(mockRegisterAbort).toHaveBeenCalledOnce();
    // Key should start with 'spawn-'
    const key = mockRegisterAbort.mock.calls[0]![0];
    expect(key).toMatch(/^spawn-/);

    // Signal should be passed through to runtime.invoke
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortSignal }),
    );
  });

  it('calls dispose after successful completion', async () => {
    const dispose = vi.fn();
    mockRegisterAbort.mockReturnValueOnce({ signal: new AbortController().signal, dispose });

    const runtime = makeRuntime([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('calls dispose after runtime error event', async () => {
    const dispose = vi.fn();
    mockRegisterAbort.mockReturnValueOnce({ signal: new AbortController().signal, dispose });

    const runtime = makeRuntime([{ type: 'error', message: 'boom' }]);
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('calls dispose after runtime throws', async () => {
    const dispose = vi.fn();
    mockRegisterAbort.mockReturnValueOnce({ signal: new AbortController().signal, dispose });

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        throw new Error('connection failed');
      }),
    };

    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not register abort when recursion depth blocks execution', async () => {
    await executeSpawnAction(
      { type: 'spawnAgent', channel: 'general', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx({ depth: 1 }),
    );

    expect(mockRegisterAbort).not.toHaveBeenCalled();
  });

  it('does not register abort for validation failures', async () => {
    await executeSpawnAction(
      { type: 'spawnAgent', channel: '', prompt: 'Do task' },
      makeCtx(),
      makeSpawnCtx(),
    );

    expect(mockRegisterAbort).not.toHaveBeenCalled();
  });

  it('registers separate abort entries for each agent in parallel batch', async () => {
    const disposes: ReturnType<typeof vi.fn>[] = [];
    mockRegisterAbort.mockImplementation(() => {
      const d = vi.fn();
      disposes.push(d);
      return { signal: new AbortController().signal, dispose: d };
    });

    const runtime = makeRuntime([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    await executeSpawnActions(
      [
        { type: 'spawnAgent', channel: 'general', prompt: 'First' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Second' },
        { type: 'spawnAgent', channel: 'general', prompt: 'Third' },
      ],
      makeCtx(),
      makeSpawnCtx({ runtime }),
    );

    // Each agent should register independently
    expect(mockRegisterAbort).toHaveBeenCalledTimes(3);
    // All should be disposed after completion
    for (const d of disposes) {
      expect(d).toHaveBeenCalledOnce();
    }
  });
});
