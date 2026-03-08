import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './message-coordinator.js';
import { globalTraceStore } from '../observability/trace-store.js';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

function makeParams() {
  const metrics = { increment: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    allowUserIds: new Set(['user-1']),
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
    botDisplayName: 'Discoclaw',
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime: { id: 'claude', capabilities: {} },
    sessionManager: {} as any,
    workspaceCwd: '/tmp/workspace',
    projectCwd: '/tmp/workspace',
    groupsDir: '/tmp/workspace',
    useGroupDirCwd: false,
    runtimeModel: 'capable',
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'fast',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 6,
    summaryDataDir: '/tmp/workspace',
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/workspace',
    durableInjectMaxChars: 2000,
    durableMaxItems: 100,
    memoryCommandsEnabled: false,
    planCommandsEnabled: false,
    forgeCommandsEnabled: false,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/workspace',
    shortTermMaxEntries: 0,
    shortTermMaxAgeMs: 0,
    shortTermInjectMaxChars: 0,
    streamStallWarningMs: 10_000,
    actionFollowupDepth: 1,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 0,
    healthCommandsEnabled: false,
    metrics,
    log,
  } as any;
}

function makeMessage(content: string) {
  const channel = {
    id: 'dm-1',
    name: 'dm',
    send: vi.fn(async () => ({})),
    isThread: () => false,
  };

  return {
    id: 'm1',
    type: 0,
    content,
    author: { id: 'user-1', bot: false },
    guildId: null,
    guild: null,
    channelId: 'dm-1',
    channel,
    client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    reply: vi.fn(async () => ({})),
  };
}

describe('message coordinator !trace command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replies with recent traces without queueing and includes full trace IDs', async () => {
    vi.spyOn(globalTraceStore, 'listRecent').mockReturnValue([
      {
        traceId: 'message_12345678-1234-1234-1234-123456789abc',
        sessionKey: 'discord:dm:user-1',
        flow: 'message',
        startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
        outcome: 'success',
        durationMs: 1200,
        events: [{ type: 'invoke_start', at: new Date('2026-03-08T10:00:00.000Z').getTime(), summary: 'started' }],
      },
    ]);

    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!trace');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('message_12345678-1234-1234-1234-123456789abc'),
    }));
  });

  it('replies with not found for unknown trace IDs without queueing', async () => {
    vi.spyOn(globalTraceStore, 'getTrace').mockReturnValue(undefined);

    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!trace message:123:456');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '```text\nTrace message:123:456 not found.\n```',
    }));
  });
});
