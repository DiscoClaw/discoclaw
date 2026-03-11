import { describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './message-coordinator.js';

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
    mcpStatus: {
      status: 'found',
      servers: [
        { name: 'filesystem', type: 'stdio' },
        { name: 'remote-db', type: 'url' },
      ],
    },
    mcpWarnings: 2,
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

describe('message coordinator !mcp command', () => {
  it('replies with server status for !mcp and does not enqueue', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!mcp');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('MCP Status'),
    }));
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Server count: 2'),
    }));
  });

  it('replies with server status for !mcp list and does not enqueue', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!mcp list');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('- remote-db: url'),
    }));
  });

  it('replies with help text for !mcp help and does not enqueue', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!mcp help');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('!mcp commands'),
    }));
  });

  it('rejects unsupported subcommands and does not enqueue', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!mcp reload');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Unknown `!mcp` subcommand. Valid usage: `!mcp`, `!mcp list`, `!mcp help`.',
    }));
  });

  it('does not intercept prefix collisions like !mcps', async () => {
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(makeParams(), queue as any);
    const msg = makeMessage('!mcps');

    await handler(msg as any);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(queue.run).toHaveBeenCalledOnce();
  });
});
