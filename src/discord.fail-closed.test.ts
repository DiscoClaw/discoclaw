import { describe, expect, it, vi } from 'vitest';

import { createMessageCreateHandler } from './discord.js';

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
}

describe('Discord handler (fail closed)', () => {
  it('does not respond when allowUserIds is empty', async () => {
    const queue = makeQueue();
    const handler = createMessageCreateHandler({
      allowUserIds: new Set(),
      runtime: { invoke: async function* () { yield { type: 'text_final', text: 'hi' } as any; } } as any,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: true,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordActionsEnabled: false,
      discordActionsChannels: true,
      discordActionsMessaging: false,
      discordActionsGuild: false,
      discordActionsModeration: false,
      discordActionsPolls: false,
      discordActionsBeads: false,
      discordActionsBotProfile: false,
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: '/tmp/summaries',
      summaryToDurableEnabled: false,
      shortTermMemoryEnabled: false,
      shortTermDataDir: '/tmp/shortterm',
      shortTermMaxEntries: 20,
      shortTermMaxAgeMs: 21600000,
      shortTermInjectMaxChars: 1000,
      durableMemoryEnabled: false,
      durableDataDir: '/tmp/durable',
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
      actionFollowupDepth: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      botDisplayName: 'TestBot',
    }, queue);

    const msg = {
      author: { id: '123', bot: false },
      guildId: 'guild',
      channelId: 'chan',
      channel: { send: vi.fn() },
      content: 'hello',
      reply: vi.fn(),
    };

    await handler(msg);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('does not respond in non-allowed guild channels when DISCORD_CHANNEL_IDS is set', async () => {
    const queue = makeQueue();
    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      allowChannelIds: new Set(['allowed']),
      runtime: { invoke: async function* () { yield { type: 'text_final', text: 'hi' } as any; } } as any,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: true,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordActionsEnabled: false,
      discordActionsChannels: true,
      discordActionsMessaging: false,
      discordActionsGuild: false,
      discordActionsModeration: false,
      discordActionsPolls: false,
      discordActionsBeads: false,
      discordActionsBotProfile: false,
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: '/tmp/summaries',
      summaryToDurableEnabled: false,
      shortTermMemoryEnabled: false,
      shortTermDataDir: '/tmp/shortterm',
      shortTermMaxEntries: 20,
      shortTermMaxAgeMs: 21600000,
      shortTermInjectMaxChars: 1000,
      durableMemoryEnabled: false,
      durableDataDir: '/tmp/durable',
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
      actionFollowupDepth: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      botDisplayName: 'TestBot',
    }, queue);

    const msg = {
      author: { id: '123', bot: false },
      guildId: 'guild',
      channelId: 'not-allowed',
      channel: { send: vi.fn() },
      content: 'hello',
      reply: vi.fn(),
    };

    await handler(msg);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('does not send Message Content Intent hint in non-allowed guild channels', async () => {
    const queue = makeQueue();
    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      allowChannelIds: new Set(['allowed']),
      runtime: { invoke: async function* () { yield { type: 'text_final', text: 'hi' } as any; } } as any,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: true,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordActionsEnabled: false,
      discordActionsChannels: true,
      discordActionsMessaging: false,
      discordActionsGuild: false,
      discordActionsModeration: false,
      discordActionsPolls: false,
      discordActionsBeads: false,
      discordActionsBotProfile: false,
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: '/tmp/summaries',
      summaryToDurableEnabled: false,
      shortTermMemoryEnabled: false,
      shortTermDataDir: '/tmp/shortterm',
      shortTermMaxEntries: 20,
      shortTermMaxAgeMs: 21600000,
      shortTermInjectMaxChars: 1000,
      durableMemoryEnabled: false,
      durableDataDir: '/tmp/durable',
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
      actionFollowupDepth: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      botDisplayName: 'TestBot',
    }, queue);

    const msg = {
      author: { id: '123', bot: false },
      guildId: 'guild',
      channelId: 'not-allowed',
      channel: { send: vi.fn() },
      content: '',
      attachments: { size: 0 },
      stickers: { size: 0 },
      embeds: [],
      mentions: { has: vi.fn(() => true) },
      client: { user: { id: 'bot-user' } },
      reply: vi.fn(),
    };

    await handler(msg);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(queue.run).not.toHaveBeenCalled();
  });
});
