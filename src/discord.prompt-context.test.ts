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

// Mock bd-cli so plan/forge dispatch tests don't shell out.
vi.mock('./beads/bd-cli.js', () => ({
  bdCreate: vi.fn(async () => ({ id: 'ws-test-001', title: 'test', status: 'open' })),
  bdClose: vi.fn(async () => {}),
  bdUpdate: vi.fn(async () => {}),
  bdAddLabel: vi.fn(async () => {}),
}));

import { beadThreadCache } from './beads/bead-thread-cache.js';
import { bdCreate } from './beads/bd-cli.js';
import { createMessageCreateHandler } from './discord.js';
import { loadDurableMemory, saveDurableMemory, addItem } from './discord/durable-memory.js';
import { inlineContextFiles } from './discord/prompt-common.js';
import type { DurableMemoryStore } from './discord/durable-memory.js';

const mockedBdCreate = vi.mocked(bdCreate);

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

/** Create a temp .context/ dir with pa.md and pa-safety.md for test use. */
async function createPaContextDir(): Promise<string> {
  const contextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-ctx-'));
  await fs.writeFile(path.join(contextDir, 'pa.md'), '# PA context', 'utf-8');
  await fs.writeFile(path.join(contextDir, 'pa-safety.md'), '# PA safety rules', 'utf-8');
  return contextDir;
}

/** Build a mock DiscordChannelContext using the new pa-based structure. */
async function buildMockChannelContext(opts?: {
  channelEntries?: Map<string, { channelId: string; channelName: string; contextPath: string }>;
  channelFiles?: { name: string; content: string }[];
}) {
  const paContextDir = await createPaContextDir();
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-inline-'));
  const channelsDir = path.join(contentDir, 'discord', 'channels');
  await fs.mkdir(channelsDir, { recursive: true });

  for (const f of opts?.channelFiles ?? []) {
    await fs.writeFile(path.join(channelsDir, f.name), f.content, 'utf-8');
  }

  return {
    ctx: {
      contentDir,
      indexPath: path.join(contentDir, 'discord', 'DISCORD.md'),
      paContextFiles: [path.join(paContextDir, 'pa.md'), path.join(paContextDir, 'pa-safety.md')],
      channelsDir,
      byChannelId: opts?.channelEntries ?? new Map(),
      dmContextPath: path.join(channelsDir, 'dm.md'),
    },
    channelsDir,
    paContextDir,
  };
}

describe('prompt inlines context file contents', () => {
  it('guild channel inlines PA + channel context files', async () => {
    const queue = makeQueue();
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const { ctx, channelsDir } = await buildMockChannelContext({
      channelFiles: [{ name: 'general.md', content: '# General channel' }],
    });
    ctx.byChannelId = new Map([['chan', { channelId: 'chan', channelName: 'general', contextPath: path.join(channelsDir, 'general.md') }]]);

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
      discordChannelContext: ctx as any,
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ channelId: 'chan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    // PA file contents should be inlined.
    expect(seenPrompt).toContain('# PA context');
    expect(seenPrompt).toContain('# PA safety rules');
    expect(seenPrompt).toContain('# General channel');
    expect(seenPrompt).not.toContain('Context files (read with Read tool');
    expect(seenPrompt).toContain('User message:\nhello');

    // Boundary instruction appears between context sections and user message.
    const boundaryIdx = seenPrompt.indexOf('internal system context');
    const userMsgIdx = seenPrompt.indexOf('User message:');
    const paIdx = seenPrompt.indexOf('# PA context');
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeLessThan(userMsgIdx);
    expect(boundaryIdx).toBeGreaterThan(paIdx);
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

    const { ctx, channelsDir } = await buildMockChannelContext({
      channelFiles: [{ name: 'general.md', content: '# General channel context' }],
    });
    ctx.byChannelId = new Map([['parent', { channelId: 'parent', channelName: 'general', contextPath: path.join(channelsDir, 'general.md') }]]);

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
      discordChannelContext: ctx as any,
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({
      channelId: 'thread',
      channel: { send: vi.fn(async () => {}), isThread: () => true, parentId: 'parent', name: 'thread-name', id: 'thread' },
    }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('# General channel context');
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

    const { ctx, channelsDir } = await buildMockChannelContext({
      channelFiles: [{ name: 'dm.md', content: '# DM channel context' }],
    });
    ctx.dmContextPath = path.join(channelsDir, 'dm.md');

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
      discordChannelContext: ctx as any,
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('# DM channel context');
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
      streamStallWarningMs: 0,
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    expect(seenPrompt).toContain('Durable memory (user-specific notes):');
    expect(seenPrompt).toContain('[fact] User prefers TypeScript');
  });
});

describe('workspace PA files in prompt', () => {
  it('injects SOUL, IDENTITY, USER before PA context when files exist', async () => {
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

    const { ctx, channelsDir } = await buildMockChannelContext({
      channelFiles: [{ name: 'general.md', content: '# General' }],
    });
    ctx.byChannelId = new Map([['chan', { channelId: 'chan', channelName: 'general', contextPath: path.join(channelsDir, 'general.md') }]]);

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
      discordChannelContext: ctx as any,
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ channelId: 'chan' }));

    expect(runtime.invoke).toHaveBeenCalled();
    // PA file contents should be inlined before PA context module contents.
    const soulIdx = seenPrompt.indexOf('# Soul');
    const identIdx = seenPrompt.indexOf('# Identity');
    const userIdx = seenPrompt.indexOf('# User');
    const paIdx = seenPrompt.indexOf('--- pa.md ---');
    expect(soulIdx).toBeGreaterThan(-1);
    expect(identIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(soulIdx).toBeLessThan(paIdx);
    expect(identIdx).toBeLessThan(paIdx);
    expect(userIdx).toBeLessThan(paIdx);
  });

  it('intercepts with onboarding flow when IDENTITY.md has template marker', async () => {
    const queue = makeQueue();
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-prompt-'));
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), '# Bootstrap', 'utf-8');
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    // IDENTITY.md must contain template marker so onboarding is incomplete.
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# Identity\n*(pick something you like)*', 'utf-8');
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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({ guildId: null, channelId: 'dmchan' }));

    // When onboarding is incomplete, the onboarding flow intercepts the message
    // and the runtime is NOT invoked.
    expect(runtime.invoke).not.toHaveBeenCalled();
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
      streamStallWarningMs: 0,
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
      streamStallWarningMs: 0,
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
    streamStallWarningMs: 0,
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

describe('!memory remember threads Discord metadata into durable source', () => {
  it('stores guildId, channelId, messageId, and channelName', async () => {
    const queue = makeQueue();
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'should not run' } as any;
      }),
    } as any;

    const durableDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-integration-'));
    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-summary-'));

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
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
    }, queue);

    await handler(makeMsg({
      content: '!memory remember test fact',
      guildId: 'g1',
      channelId: 'ch1',
      id: 'msg1',
      channel: { send: vi.fn(async () => {}), isThread: () => false, name: 'dev' },
    }));

    const store = await loadDurableMemory(durableDir, '123');
    expect(store).not.toBeNull();
    expect(store!.items).toHaveLength(1);
    expect(store!.items[0].source.guildId).toBe('g1');
    expect(store!.items[0].source.channelId).toBe('ch1');
    expect(store!.items[0].source.messageId).toBe('msg1');
    expect(store!.items[0].source.channelName).toBe('dev');
  });
});

// ---------------------------------------------------------------------------
// inlineContextFiles required-file enforcement
// ---------------------------------------------------------------------------

describe('inlineContextFiles required option', () => {
  it('throws when a required file is missing', async () => {
    const missingPath = path.join(os.tmpdir(), 'nonexistent-file-' + Date.now() + '.md');
    await expect(
      inlineContextFiles([missingPath], { required: new Set([missingPath]) }),
    ).rejects.toThrow(/Required context file unreadable/);
  });

  it('includes required file content normally when present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-req-'));
    const filePath = path.join(dir, 'test.md');
    await fs.writeFile(filePath, '# Test content', 'utf-8');

    const result = await inlineContextFiles([filePath], { required: new Set([filePath]) });
    expect(result).toContain('# Test content');
  });

  it('silently skips non-required missing files', async () => {
    const missingPath = path.join(os.tmpdir(), 'nonexistent-file-' + Date.now() + '.md');
    const result = await inlineContextFiles([missingPath]);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Bead resolution dispatch wiring for !plan and !forge create
// ---------------------------------------------------------------------------

describe('bead resolution dispatch wiring', () => {
  beforeEach(() => {
    mockedCacheGet.mockReset().mockResolvedValue(null);
    mockedBdCreate.mockReset().mockResolvedValue({
      id: 'ws-test-001',
      title: 'test',
      status: 'open',
    });
  });

  function makePlanForgeParams(overrides?: Partial<any>) {
    const tmpDir = os.tmpdir();
    const workspaceCwd = path.join(tmpDir, `plan-forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const queue = makeQueue();
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const params: any = {
      allowUserIds: new Set(['123']),
      runtime,
      sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
      workspaceCwd,
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
      reactionRemoveHandlerEnabled: false,
      reactionMaxAgeMs: 86400000,
      streamStallWarningMs: 0,
      botDisplayName: 'TestBot',
      planCommandsEnabled: true,
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
    return { queue, runtime, params, workspaceCwd };
  }

  it('!plan create in bead forum thread resolves existingBeadId — skips bdCreate', async () => {
    mockedCacheGet.mockResolvedValue({
      id: 'existing-bead-42',
      title: 'Existing bead',
      status: 'open',
      priority: 2,
      owner: 'David',
    } as any);

    const { queue, params, workspaceCwd } = makePlanForgeParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!plan fix the thread bug',
      channelId: 'bead-thread-plan',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: BEAD_FORUM_ID,
        name: 'bead-thread',
        id: 'bead-thread-plan',
      },
    }));

    expect(mockedCacheGet).toHaveBeenCalledWith('bead-thread-plan', '/tmp/beads');
    expect(mockedBdCreate).not.toHaveBeenCalled();

    // Verify the plan file uses the existing bead ID
    const plansDir = path.join(workspaceCwd, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.endsWith('.md'));
    expect(planFile).toBeTruthy();
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('**Bead:** existing-bead-42');
  });

  it('!plan create in non-bead-forum thread does NOT resolve — calls bdCreate', async () => {
    const { queue, params } = makePlanForgeParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!plan fix something',
      channelId: 'other-thread',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: '99998888777766665555', // Different from BEAD_FORUM_ID
        name: 'other-thread',
        id: 'other-thread',
      },
    }));

    expect(mockedCacheGet).not.toHaveBeenCalled();
    expect(mockedBdCreate).toHaveBeenCalled();
  });

  it('!plan create when cache returns null falls through to bdCreate', async () => {
    mockedCacheGet.mockResolvedValue(null);

    const { queue, params } = makePlanForgeParams();
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!plan fix the thread bug',
      channelId: 'bead-thread-null',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: BEAD_FORUM_ID,
        name: 'bead-thread',
        id: 'bead-thread-null',
      },
    }));

    expect(mockedCacheGet).toHaveBeenCalledWith('bead-thread-null', '/tmp/beads');
    expect(mockedBdCreate).toHaveBeenCalled();
  });

  it('!plan create without beadCtx skips bead lookup entirely', async () => {
    const { queue, params } = makePlanForgeParams({ beadCtx: undefined });
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!plan fix the bug',
      channelId: 'bead-thread-no-ctx',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: BEAD_FORUM_ID,
        name: 'bead-thread',
        id: 'bead-thread-no-ctx',
      },
    }));

    expect(mockedCacheGet).not.toHaveBeenCalled();
    expect(mockedBdCreate).toHaveBeenCalled();
  });

  it('!forge create in bead forum thread resolves existingBeadId', async () => {
    mockedCacheGet.mockResolvedValue({
      id: 'existing-forge-bead',
      title: 'Forge bead',
      status: 'open',
      priority: 2,
      owner: 'David',
    } as any);

    const { queue, params } = makePlanForgeParams({ forgeCommandsEnabled: true });
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!forge fix the thread bug',
      channelId: 'bead-thread-forge',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: BEAD_FORUM_ID,
        name: 'bead-thread',
        id: 'bead-thread-forge',
      },
    }));

    // Verify the bead lookup happened for the forge path
    expect(mockedCacheGet).toHaveBeenCalledWith('bead-thread-forge', '/tmp/beads');
  });

  it('!forge create in non-bead-forum thread does NOT resolve existingBeadId', async () => {
    const { queue, params } = makePlanForgeParams({ forgeCommandsEnabled: true });
    const handler = createMessageCreateHandler(params, queue);

    await handler(makeMsg({
      content: '!forge fix something',
      channelId: 'other-forge-thread',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: '99998888777766665555',
        name: 'other-thread',
        id: 'other-forge-thread',
      },
    }));

    // beadThreadCache.get should NOT be called — forum ID mismatch short-circuits
    expect(mockedCacheGet).not.toHaveBeenCalled();
  });
});
