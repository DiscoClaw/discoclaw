import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Mock the bead thread cache so integration tests can control bead lookups.
vi.mock('./beads/bead-thread-cache.js', () => ({
  beadThreadCache: {
    get: vi.fn().mockResolvedValue(null),
    invalidate: vi.fn(),
  },
}));

import { beadThreadCache } from './beads/bead-thread-cache.js';
import { createMessageCreateHandler } from './discord.js';
import { saveDurableMemory, addItem } from './discord/durable-memory.js';
import type { DurableMemoryStore } from './discord/durable-memory.js';

const mockedCacheGet = vi.mocked(beadThreadCache.get);

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
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md', '/content/discord/base/self-awareness.md'],
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
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md', '/content/discord/base/self-awareness.md'],
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
      baseFiles: ['/content/discord/base/core.md', '/content/discord/base/safety.md', '/content/discord/base/self-awareness.md'],
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

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('- /content/discord/channels/dm.md');
  });
});

describe('discord action flags are not frozen at handler creation', () => {
  it('beads prompt section appears after toggling discordActionsBeads on the same params object', async () => {
    const queue = makeQueue();
    const prompts: string[] = [];
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        prompts.push(p.prompt);
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const params: any = {
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
      discordActionsEnabled: true,
      discordActionsChannels: false,
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
    };

    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({ channelId: 'chan', content: 'first' }));
    expect(prompts[0]).toContain('## Discord Actions');
    expect(prompts[0]).not.toContain('beadCreate');

    params.discordActionsBeads = true;
    await handler(makeMsg({ channelId: 'chan', content: 'second' }));
    expect(prompts[1]).toContain('## Discord Actions');
    expect(prompts[1]).toContain('beadCreate');
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
      durableMemoryEnabled: true,
      durableDataDir: durableDir,
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: false,
      actionFollowupDepth: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('Durable memory (user-specific notes):');
    expect(seenPrompt).toContain('[fact] User prefers TypeScript');
  });
});

describe('workspace PA files in prompt', () => {
  it('injects SOUL, IDENTITY, USER before base context when files exist', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    // Create a temp workspace with PA files.
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-prompt-'));
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# Identity', 'utf-8');
    await fs.writeFile(path.join(workspace, 'USER.md'), '# User', 'utf-8');

    const discordChannelContext = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      baseDir: '/content/discord/base',
      baseFiles: ['/content/discord/base/core.md'],
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
      workspaceCwd: workspace,
      groupsDir: '/tmp',
      useGroupDirCwd: false,
      runtimeModel: 'opus',
      runtimeTools: [],
      runtimeTimeoutMs: 1000,
      requireChannelContext: false,
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

    await handler(makeMsg({ channelId: 'chan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    // PA files should appear before base context.
    const soulIdx = seenPrompt.indexOf('SOUL.md');
    const identIdx = seenPrompt.indexOf('IDENTITY.md');
    const userIdx = seenPrompt.indexOf('USER.md');
    const baseIdx = seenPrompt.indexOf('core.md');
    expect(soulIdx).toBeGreaterThan(-1);
    expect(identIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(soulIdx).toBeLessThan(baseIdx);
    expect(identIdx).toBeLessThan(baseIdx);
    expect(userIdx).toBeLessThan(baseIdx);
  });

  it('includes BOOTSTRAP.md when present, before SOUL', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-prompt-'));
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), '# Bootstrap', 'utf-8');
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# Identity', 'utf-8');
    await fs.writeFile(path.join(workspace, 'USER.md'), '# User', 'utf-8');

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: workspace,
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

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    const bootstrapIdx = seenPrompt.indexOf('BOOTSTRAP.md');
    const soulIdx = seenPrompt.indexOf('SOUL.md');
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(soulIdx);
  });

  it('includes TOOLS.md when present', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-prompt-'));
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    await fs.writeFile(path.join(workspace, 'TOOLS.md'), '# Tools', 'utf-8');

    const handler = createMessageCreateHandler({
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd: workspace,
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

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('TOOLS.md');
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
      discordActionsBeads: false,
      discordActionsBotProfile: false,
      messageHistoryBudget: 0,
      summaryEnabled: false,
      summaryModel: 'haiku',
      summaryMaxChars: 2000,
      summaryEveryNTurns: 5,
      summaryDataDir: summaryDir,
      summaryToDurableEnabled: false,
      shortTermMemoryEnabled: false,
      shortTermDataDir: '/tmp/shortterm',
      shortTermMaxEntries: 20,
      shortTermMaxAgeMs: 21600000,
      shortTermInjectMaxChars: 1000,
      durableMemoryEnabled: true,
      durableDataDir: durableDir,
      durableInjectMaxChars: 2000,
      durableMaxItems: 200,
      memoryCommandsEnabled: true,
      actionFollowupDepth: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      botDisplayName: 'TestBot',
    }, queue);

    const msg = makeMsg({ guildId: null, channelId: 'dmchan', content: '!memory show' });
    await handler(msg);

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreate).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Durable memory:'),
      allowedMentions: { parse: [] },
    }));
  });
});

// ---------------------------------------------------------------------------
// Bead context injection into prompt
// ---------------------------------------------------------------------------

const BEAD_FORUM_ID = '11112222333344445555';

function makeBeadParams(overrides?: Partial<any>) {
  const queue = makeQueue();
  let seenPrompt = '';
  const runtime = {
    invoke: vi.fn(async function* (p: any) {
      seenPrompt = p.prompt;
      yield { type: 'text_final', text: 'ok' } as any;
    }),
  } as any;

  const params: any = {
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
    discordActionsChannels: false,
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
    reactionMaxAgeMs: 86400000,
    botDisplayName: 'TestBot',
    beadCtx: {
      beadsCwd: '/tmp/beads',
      forumId: BEAD_FORUM_ID,
      tagMap: {},
      runtime: {} as any,
      autoTag: false,
      autoTagModel: 'haiku',
    },
    ...overrides,
  };
  return { queue, runtime, params, getPrompt: () => seenPrompt };
}

describe('bead context injection into prompt', () => {
  beforeEach(() => {
    mockedCacheGet.mockReset().mockResolvedValue(null);
  });

  it('includes bead section when message is from a bead forum thread', async () => {
    mockedCacheGet.mockResolvedValue({
      id: 'ws-042',
      title: 'Fix auth bug',
      status: 'in_progress',
      priority: 2,
      owner: 'David',
    } as any);

    const { queue, runtime, params, getPrompt } = makeBeadParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      channelId: 'bead-thread-1',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: BEAD_FORUM_ID,
        name: 'bead-thread',
        id: 'bead-thread-1',
      },
    }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(getPrompt()).toContain('Bead task context for this thread');
    expect(getPrompt()).toContain('ws-042');
    expect(getPrompt()).toContain('Fix auth bug');
  });

  it('does not include bead section for DMs', async () => {
    const { queue, runtime, params, getPrompt } = makeBeadParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(getPrompt()).not.toContain('Bead task context');
  });

  it('does not include bead section for non-bead thread channels', async () => {
    const { queue, runtime, params, getPrompt } = makeBeadParams();
    const handler = createMessageCreateHandler(params, queue);

    // Thread in a different parent channel (not the beads forum).
    await handler(makeMsg({
      channelId: 'other-thread-1',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: '99998888777766665555',
        name: 'other-thread',
        id: 'other-thread-1',
      },
    }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(getPrompt()).not.toContain('Bead task context');
    // Cache should not even be called — forum ID mismatch short-circuits.
    expect(mockedCacheGet).not.toHaveBeenCalled();
  });

  it('does not include bead section for non-thread guild channels', async () => {
    const { queue, runtime, params, getPrompt } = makeBeadParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({ channelId: 'regular-channel' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(getPrompt()).not.toContain('Bead task context');
    expect(mockedCacheGet).not.toHaveBeenCalled();
  });
});
