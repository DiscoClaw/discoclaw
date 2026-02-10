import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMessageCreateHandler } from './discord.js';
import { saveDurableMemory, addItem } from './discord/durable-memory.js';
import type { DurableMemoryStore } from './discord/durable-memory.js';

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
}

function makeMsg(overrides: Partial<any>) {
  const replyObj = { edit: vi.fn(async () => {}) };
  return {
    author: { id: '123', bot: false },
    guildId: 'guild',
    channelId: 'chan',
    channel: { send: vi.fn(async () => {}), isThread: () => false, name: 'general' },
    content: 'hello',
    reply: vi.fn(async () => replyObj),
    ...overrides,
  };
}

describe('prompt includes correct context file paths', () => {
  it('guild channel uses channel context file', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const discordChannelContext = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      baseDir: '/content/discord/base',
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md'],
      baseCoreLinkFromChannel: '../base/core.md',
      baseSafetyLinkFromChannel: '../base/safety.md',
      channelsDir: '/content/discord/channels',
      byChannelId: new Map([['chan', { channelId: 'chan', channelName: 'general', contextPath: '/content/discord/channels/general.md' }]]),
      dmContextPath: '/content/discord/channels/dm.md',
    };

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: false,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordChannelContext: discordChannelContext as any,
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

    await handler(makeMsg({ channelId: 'chan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('- /content/discord/base/core.md');
    expect(seenPrompt).toContain('- /content/discord/base/safety.md');
    expect(seenPrompt).toContain('- /content/discord/channels/general.md');
    expect(seenPrompt).toContain('User message:\nhello');
  });

  it('thread uses parent channel context file', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const discordChannelContext = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      baseDir: '/content/discord/base',
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md'],
      baseCoreLinkFromChannel: '../base/core.md',
      baseSafetyLinkFromChannel: '../base/safety.md',
      channelsDir: '/content/discord/channels',
      byChannelId: new Map([['parent', { channelId: 'parent', channelName: 'general', contextPath: '/content/discord/channels/general.md' }]]),
      dmContextPath: '/content/discord/channels/dm.md',
    };

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: false,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordChannelContext: discordChannelContext as any,
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

    await handler(makeMsg({
      channelId: 'thread',
      channel: { send: vi.fn(async () => {}), isThread: () => true, parentId: 'parent', name: 'thread-name', id: 'thread' },
    }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('- /content/discord/channels/general.md');
  });

  it('DM uses dm context file', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const discordChannelContext = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      baseDir: '/content/discord/base',
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md'],
      baseCoreLinkFromChannel: '../base/core.md',
      baseSafetyLinkFromChannel: '../base/safety.md',
      channelsDir: '/content/discord/channels',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/channels/dm.md',
    };

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: true,
      autoIndexChannelContext: false,
      autoJoinThreads: false,
      useRuntimeSessions: true,
      discordChannelContext: discordChannelContext as any,
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

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('- /content/discord/channels/dm.md');
  });
});

describe('durable memory injection into prompt', () => {
  it('injects durable section when enabled and store has items', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    // Seed a durable memory file on disk.
    const durableDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-integration-'));
    const store: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(store, 'User prefers TypeScript', { type: 'manual' }, 200);
    await saveDurableMemory(durableDir, '123', store);

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: false,
      autoIndexChannelContext: false,
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
      durableMemoryEnabled: true,
      durableDataDir: durableDir,
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
    }, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('Durable memory (user-specific notes):');
    expect(seenPrompt).toContain('[fact] User prefers TypeScript');
  });
});

describe('memory command interception', () => {
  it('!memory show returns early without invoking runtime', async () => {
    const queue = makeQueue();
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'should not run' } as any;
      }),
    } as any;
    const sessionManager = { getOrCreate: vi.fn(async () => 'sess') } as any;

    const durableDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-integration-'));
    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-summary-'));

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager,
      workspaceCwd: '/tmp',
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: false,
      autoIndexChannelContext: false,
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
      summaryDataDir: summaryDir,
      durableMemoryEnabled: true,
      durableDataDir: durableDir,
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: true,
    }, queue);

    const msg = makeMsg({ guildId: null, channelId: 'dmchan', content: '!memory show' });
    await handler(msg);

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreate).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Durable memory:'));
  });
});
