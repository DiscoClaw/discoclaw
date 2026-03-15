import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './message-coordinator.js';
import { globalTraceStore } from '../observability/trace-store.js';
import type { RunTrace } from '../observability/trace-store.js';

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

function makeMessage(content: string, channelId = 'dm-1') {
  const channel = {
    id: channelId,
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
    channelId,
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
    const listRecentForChannel = vi.spyOn(globalTraceStore, 'listRecentForChannel').mockReturnValue([
      {
        traceId: 'message_12345678-1234-1234-1234-123456789abc',
        sessionKey: 'discord:dm:user-1',
        channelId: 'dm-1',
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
    expect(listRecentForChannel).toHaveBeenCalledWith(10, 'dm-1');
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('message_12345678-1234-1234-1234-123456789abc'),
    }));
  });

  it('replies with MCP status without queueing', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const params = makeParams();
    params.mcpStatus = {
      status: 'found',
      servers: [
        { name: 'filesystem', type: 'stdio' },
        { name: 'remote-db', type: 'url' },
      ],
    };
    params.mcpWarnings = 2;
    const handler = createMessageCreateHandler(params, queue as any);
    const msg = makeMessage('!mcp');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('MCP Status'),
    }));
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Server count: 2'),
    }));
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('- remote-db: url'),
    }));
  });

  it('replies with an empty list when traces only exist in a different channel', async () => {
    const otherChannelTraces: RunTrace[] = [
      {
        traceId: 'message_other-channel',
        sessionKey: 'discord:dm:user-1',
        channelId: 'dm-2',
        flow: 'message',
        startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
        outcome: 'success',
        durationMs: 1200,
        events: [{ type: 'invoke_start', at: new Date('2026-03-08T10:00:00.000Z').getTime(), summary: 'started' }],
      },
    ];
    const listRecentForChannel = vi
      .spyOn(globalTraceStore, 'listRecentForChannel')
      .mockImplementation((_limit, channelId) => (channelId === 'dm-2' ? otherChannelTraces : []));

    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!trace', 'dm-1');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(listRecentForChannel).toHaveBeenCalledWith(10, 'dm-1');
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '```text\nRecent traces\n(none)\n```',
    }));
  });

  it('replies with not found for unknown trace IDs without queueing', async () => {
    const getTraceForChannel = vi
      .spyOn(globalTraceStore, 'getTraceForChannel')
      .mockReturnValue(undefined);

    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!trace message:123:456');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(getTraceForChannel).toHaveBeenCalledWith('message:123:456', 'dm-1');
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '```text\nTrace message:123:456 not found.\n```',
    }));
  });

  it('replies with not found when the trace belongs to a different channel', async () => {
    const otherChannelTrace: RunTrace = {
      traceId: 'message_other-channel',
      sessionKey: 'discord:dm:user-1',
      channelId: 'dm-2',
      flow: 'message',
      startedAt: new Date('2026-03-08T10:00:00.000Z').getTime(),
      outcome: 'success',
      durationMs: 1200,
      events: [{ type: 'invoke_start', at: new Date('2026-03-08T10:00:00.000Z').getTime(), summary: 'started' }],
    };
    const getTraceForChannel = vi
      .spyOn(globalTraceStore, 'getTraceForChannel')
      .mockImplementation((traceId, channelId) => (
        traceId === otherChannelTrace.traceId && channelId === 'dm-2'
          ? otherChannelTrace
          : undefined
      ));

    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage(`!trace ${otherChannelTrace.traceId}`, 'dm-1');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(getTraceForChannel).toHaveBeenCalledWith(otherChannelTrace.traceId, 'dm-1');
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: `\`\`\`text\nTrace ${otherChannelTrace.traceId} not found.\n\`\`\``,
    }));
  });
});
