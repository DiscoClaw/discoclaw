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
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: '/tmp/summaries',
      durableMemoryEnabled: false,
      durableDataDir: '/tmp/durable',
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
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
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: '/tmp/summaries',
      durableMemoryEnabled: false,
      durableDataDir: '/tmp/durable',
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
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
});
