import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Guild } from 'discord.js';
import { appendActionResults, parseDiscordActions } from './actions.js';
import {
  LOOP_TICK_ALLOWED_ACTIONS,
  buildLoopTickActionFlags,
  configureLoopScheduler,
  executeLoopAction,
} from './actions-loop.js';
import type { ActionContext, DiscordActionResult } from './actions.js';
import type { EngineEvent } from '../runtime/types.js';

const resolveChannelMock = vi.fn();

vi.mock('./prompt-common.js', () => ({
  loadWorkspacePaFiles: vi.fn(async () => []),
  buildContextFiles: vi.fn(() => []),
  inlineContextFilesWithMeta: vi.fn(async () => ({ text: '', sections: [] })),
  resolveEffectiveTools: vi.fn(async () => ({
    effectiveTools: [],
    permissionNote: null,
    runtimeCapabilityNote: null,
  })),
  buildPromptPreamble: vi.fn(() => ''),
  buildOpenTasksSection: vi.fn(() => ''),
  buildPromptSectionEstimates: vi.fn(() => ({
    sections: {},
    totalChars: 0,
    totalEstTokens: 0,
  })),
}));

vi.mock('./channel-context.js', () => ({
  resolveDiscordChannelContext: vi.fn(() => ({ contextPath: undefined, channelName: 'general' })),
}));

vi.mock('./action-utils.js', () => ({
  resolveChannel: (...args: unknown[]) => resolveChannelMock(...args),
  fmtTime: (value: Date) => value.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
}));

vi.mock('../runtime/model-tiers.js', () => ({
  resolveModel: vi.fn((model: string) => model),
}));

function makeRuntime(events: EngineEvent[]) {
  return {
    id: 'other' as const,
    capabilities: new Set() as ReadonlySet<never>,
    async *invoke(): AsyncIterable<EngineEvent> {
      for (const event of events) yield event;
    },
  };
}

function makeContext(): ActionContext {
  return {
    guild: { id: 'guild-1' } as Guild,
    client: { token: 'dummy' } as Client,
    channelId: 'origin-thread-1',
    messageId: 'message-1',
    requesterId: 'user-1',
    confirmation: { mode: 'automated' },
  };
}

function makeChannel() {
  return {
    id: 'target-1',
    send: vi.fn(async (_opts: { content: string; allowedMentions: unknown }) => ({})),
  };
}

function configureForTick(opts?: {
  runtimeText?: string;
  executeResults?: DiscordActionResult[];
}) {
  const executeDiscordActions = vi.fn(async (..._args: unknown[]) => opts?.executeResults ?? []);
  const channel = makeChannel();
  resolveChannelMock.mockReturnValue(channel);

  const scheduler = configureLoopScheduler({
    minIntervalSeconds: 1,
    maxIntervalSeconds: 300,
    maxConcurrent: 3,
    state: {
      runtimeModel: 'fast',
    },
    runtime: makeRuntime([
      { type: 'text_final', text: opts?.runtimeText ?? '' } as EngineEvent,
      { type: 'done' } as EngineEvent,
    ]),
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    workspaceCwd: '/tmp/workspace',
    useGroupDirCwd: false,
    botDisplayName: 'Discoclaw',
    actionsApi: {
      parseDiscordActions,
      executeDiscordActions,
      buildTieredDiscordActionsPromptSection: vi.fn(() => ({
        prompt: '### Allowed loop tick actions',
        includedCategories: ['messaging', 'channels'],
        tierBuckets: { core: ['messaging', 'channels'], channelContextual: [], keywordTriggered: [] },
        keywordHits: [],
      })),
      appendActionResults,
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  return { scheduler, executeDiscordActions, channel };
}

describe('loop tick policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports the explicit loop tick allowlist and narrow category flags', () => {
    expect(buildLoopTickActionFlags()).toEqual({
      channels: true,
      messaging: true,
      guild: false,
      moderation: false,
      polls: false,
      tasks: true,
      crons: true,
      botProfile: false,
      forge: true,
      plan: true,
      memory: false,
      defer: false,
      loop: true,
      config: false,
      imagegen: false,
      voice: false,
      spawn: false,
    });

    expect([...LOOP_TICK_ALLOWED_ACTIONS]).toEqual([
      'readMessages',
      'fetchMessage',
      'listPins',
      'channelInfo',
      'threadListArchived',
      'taskList',
      'taskShow',
      'cronList',
      'cronShow',
      'forgeStatus',
      'planList',
      'planShow',
      'loopList',
    ]);
  });

  it('accepts allowed query actions during loop ticks', async () => {
    const { executeDiscordActions, channel } = configureForTick({
      runtimeText: '<discord-action>{"type":"readMessages","limit":5}</discord-action>',
      executeResults: [{ ok: true, summary: 'Read 5 messages' }],
    });

    const create = await executeLoopAction({
      type: 'loopCreate',
      channel: 'general',
      intervalSeconds: 5,
      prompt: 'Read recent messages and report',
      label: 'reader',
    }, makeContext());
    expect(create.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeDiscordActions).toHaveBeenCalledTimes(1);
    const firstExecuteCall = executeDiscordActions.mock.calls[0] as unknown as [unknown];
    expect(firstExecuteCall[0]).toEqual([{ type: 'readMessages', limit: 5 }]);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Done: Read 5 messages' }),
    );
  });

  it('rejects mutating actions from enabled parent categories during loop ticks', async () => {
    const { executeDiscordActions, channel } = configureForTick({
      runtimeText: [
        '<discord-action>{"type":"sendMessage","content":"hi"}</discord-action>',
        '<discord-action>{"type":"deleteMessage","messageId":"1"}</discord-action>',
        '<discord-action>{"type":"channelDelete","channel":"ops"}</discord-action>',
        '<discord-action>{"type":"roleAdd","role":"admin","member":"u1"}</discord-action>',
      ].join('\n'),
    });

    await executeLoopAction({
      type: 'loopCreate',
      channel: 'general',
      intervalSeconds: 5,
      prompt: 'Try a few actions',
      label: 'blocked-actions',
    }, makeContext());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeDiscordActions).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const sentCall = channel.send.mock.calls[0] as unknown as [{ content: string }];
    const sent = sentCall[0].content;
    expect(sent).toContain('sendMessage');
    expect(sent).toContain('deleteMessage');
    expect(sent).toContain('channelDelete');
    expect(sent).toContain('roleAdd');
  });

  it('posts plain-text loop tick output without requiring messaging actions', async () => {
    const { executeDiscordActions, channel } = configureForTick({
      runtimeText: 'Loop tick completed successfully.',
    });

    await executeLoopAction({
      type: 'loopCreate',
      channel: 'general',
      intervalSeconds: 5,
      prompt: 'Report loop status in plain text',
      label: 'status',
    }, makeContext());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeDiscordActions).not.toHaveBeenCalled();
    const sentCall = channel.send.mock.calls[0] as unknown as [{ content: string }];
    expect(sentCall[0]).toEqual(
      expect.objectContaining({ content: 'Loop tick completed successfully.' }),
    );
  });
});
