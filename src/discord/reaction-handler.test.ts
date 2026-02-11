import { describe, expect, it, vi } from 'vitest';
import { createReactionAddHandler } from './reaction-handler.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';
import type { BotParams, StatusRef } from '../discord.js';

function makeMockRuntime(response: string): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'text_final', text: response };
      yield { type: 'done' };
    },
  };
}

function makeMockRuntimeError(message: string): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'error', message };
      yield { type: 'done' };
    },
  };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockMessage(overrides?: Record<string, any>) {
  return {
    id: 'msg-1',
    content: 'Hello world',
    channelId: 'ch-1',
    guildId: 'guild-1',
    createdTimestamp: Date.now(),
    partial: false,
    author: {
      id: 'author-1',
      username: 'Alice',
      displayName: 'Alice',
    },
    client: {
      user: { id: 'bot-1' },
    },
    guild: {
      channels: {
        cache: { get: vi.fn(), find: vi.fn() },
      },
    },
    channel: {
      id: 'ch-1',
      name: 'general',
      isThread: () => false,
      send: vi.fn().mockResolvedValue(undefined),
    },
    attachments: { size: 0, values: () => [] },
    embeds: [],
    reply: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    ...overrides,
  };
}

function mockReaction(overrides?: Record<string, any>) {
  return {
    partial: false,
    emoji: { name: '👀' },
    message: mockMessage(),
    fetch: vi.fn(),
    ...overrides,
  };
}

function mockUser(overrides?: Record<string, any>) {
  return {
    id: 'user-1',
    username: 'David',
    displayName: 'David',
    partial: false,
    ...overrides,
  };
}

function mockQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  } as any;
}

function makeParams(overrides?: Partial<Omit<BotParams, 'token'>>): Omit<BotParams, 'token'> {
  return {
    allowUserIds: new Set(['user-1']),
    allowChannelIds: undefined,
    botDisplayName: 'TestBot',
    log: mockLog(),
    discordChannelContext: undefined,
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime: makeMockRuntime('Reaction response!'),
    sessionManager: { getOrCreate: vi.fn().mockResolvedValue('session-1') } as any,
    workspaceCwd: '/tmp/workspace',
    groupsDir: '/tmp/groups',
    useGroupDirCwd: false,
    runtimeModel: 'opus',
    runtimeTools: ['Bash', 'Read'],
    runtimeTimeoutMs: 30_000,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsBeads: false,
    discordActionsCrons: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'haiku',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 5,
    summaryDataDir: '/tmp/summary',
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/durable',
    durableInjectMaxChars: 2000,
    durableMaxItems: 200,
    memoryCommandsEnabled: false,
    statusChannel: undefined,
    toolAwareStreaming: false,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: true,
    reactionMaxAgeMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe('createReactionAddHandler', () => {
  it('ignores self-reactions (bot reacting to its own)', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction();
    // User ID matches bot ID.
    const user = mockUser({ id: 'bot-1' });
    await handler(reaction as any, user as any);

    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores non-allowlisted users', async () => {
    const params = makeParams({ allowUserIds: new Set(['other-user']) });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores reactions in non-allowed channels', async () => {
    const params = makeParams({ allowChannelIds: new Set(['other-channel']) });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores DM reactions (guildId null)', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction({
      message: mockMessage({ guildId: null }),
    });
    await handler(reaction as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores stale messages older than reactionMaxAgeMs', async () => {
    const params = makeParams({ reactionMaxAgeMs: 1000 });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction({
      message: mockMessage({ createdTimestamp: Date.now() - 5000 }),
    });
    await handler(reaction as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('happy path — allowlisted user reacts, runtime responds, reply posted', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    expect(queue.run).toHaveBeenCalledOnce();
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toContain('Reaction response!');
  });

  it('prompt includes emoji name, original message content, reacting user, and channel label', async () => {
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(p): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({ runtime });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction({ emoji: { name: '🔥' } });
    reaction.message.content = 'Some important message';
    reaction.message.channel.name = 'dev-chat';
    await handler(reaction as any, mockUser({ username: 'Bob', displayName: 'Bob' }) as any);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('🔥');
    expect(prompt).toContain('Some important message');
    expect(prompt).toContain('Bob');
    expect(prompt).toContain('#');
  });

  it('prompt includes attachment URLs when present', async () => {
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(p): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({ runtime });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction();
    reaction.message.attachments = {
      size: 1,
      values: () => [{ url: 'https://cdn.example.com/image.png' }] as any,
    };
    await handler(reaction as any, mockUser() as any);

    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('https://cdn.example.com/image.png');
  });

  it('prompt includes durable memory when enabled and store has items', async () => {
    // Write a real durable memory file so the handler loads it without mocking.
    const os = await import('node:os');
    const fsP = await import('node:fs/promises');
    const pathM = await import('node:path');
    const tmpDir = await fsP.mkdtemp(pathM.join(os.tmpdir(), 'durable-'));
    const store = {
      version: 1,
      updatedAt: Date.now(),
      items: [{
        id: 'test-1',
        kind: 'fact',
        text: 'User loves TypeScript',
        tags: [],
        status: 'active',
        source: { type: 'manual' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    };
    await fsP.writeFile(pathM.join(tmpDir, 'user-1.json'), JSON.stringify(store), 'utf8');

    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(p): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({ runtime, durableMemoryEnabled: true, durableDataDir: tmpDir });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    await handler(mockReaction() as any, mockUser() as any);

    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('Durable memory');
    expect(prompt).toContain('User loves TypeScript');

    await fsP.rm(tmpDir, { recursive: true });
  });

  it('Discord actions parsed and executed from response, results appended to output', async () => {
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'Here is my response\n\n<discord-action>{"type":"react","channelId":"ch-1","messageId":"msg-1","emoji":"✅"}</discord-action>' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({
      runtime,
      discordActionsEnabled: true,
      discordActionsMessaging: true,
    });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction();
    await handler(reaction as any, mockUser() as any);

    expect(reaction.message.reply).toHaveBeenCalledOnce();
    const replyContent: string = reaction.message.reply.mock.calls[0][0].content;
    // The action block should be stripped from the clean text.
    expect(replyContent).not.toContain('<discord-action>');
    // Action results (Done: or Failed:) should be appended.
    expect(replyContent).toMatch(/Done:|Failed:/);
  });

  it('fetches partial reaction before processing', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction({ partial: true });
    await handler(reaction as any, mockUser() as any);

    expect(reaction.fetch).toHaveBeenCalledOnce();
    expect(queue.run).toHaveBeenCalledOnce();
  });

  it('fetches partial message before processing', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const msg = mockMessage({ partial: true });
    const reaction = mockReaction({ message: msg });
    await handler(reaction as any, mockUser() as any);

    expect(msg.fetch).toHaveBeenCalledOnce();
    expect(queue.run).toHaveBeenCalledOnce();
  });

  it('handles partial reaction fetch failure gracefully', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const reaction = mockReaction({
      partial: true,
      fetch: vi.fn().mockRejectedValue(new Error('Unknown Reaction')),
    });
    await handler(reaction as any, mockUser() as any);

    expect(params.log?.warn).toHaveBeenCalled();
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('handles partial message fetch failure gracefully', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const msg = mockMessage({
      partial: true,
      fetch: vi.fn().mockRejectedValue(new Error('Unknown Message')),
    });
    const reaction = mockReaction({ message: msg });
    await handler(reaction as any, mockUser() as any);

    expect(params.log?.warn).toHaveBeenCalled();
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('handles runtime error (logged, status posted)', async () => {
    const statusPoster = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
    };
    const statusRef: StatusRef = { current: statusPoster };
    const params = makeParams({ runtime: makeMockRuntimeError('timeout reached') });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue, statusRef);

    const reaction = mockReaction();
    await handler(reaction as any, mockUser() as any);

    expect(params.log?.error).toHaveBeenCalled();
    expect(statusPoster.runtimeError).toHaveBeenCalledOnce();
    expect(reaction.message.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Runtime error: timeout reached') }),
    );
  });

  it('joins thread before replying when autoJoinThreads is enabled', async () => {
    const joinFn = vi.fn().mockResolvedValue(undefined);
    const params = makeParams({ autoJoinThreads: true });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    const threadChannel = {
      id: 'thread-1',
      name: 'my-thread',
      parentId: 'ch-1',
      isThread: () => true,
      joinable: true,
      joined: false,
      join: joinFn,
      parent: { name: 'general' },
      send: vi.fn().mockResolvedValue(undefined),
    };
    const reaction = mockReaction({
      message: mockMessage({ channel: threadChannel, channelId: 'thread-1' }),
    });
    await handler(reaction as any, mockUser() as any);

    expect(joinFn).toHaveBeenCalledOnce();
    expect(reaction.message.reply).toHaveBeenCalledOnce();
  });

  it('passes addDirs to runtime.invoke when useGroupDirCwd is active', async () => {
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(p): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({ runtime, useGroupDirCwd: true });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const invokeParams = invokeSpy.mock.calls[0][0];
    expect(invokeParams.addDirs).toBeDefined();
    expect(invokeParams.addDirs).toContain('/tmp/workspace');
  });

  it('passes session ID to runtime.invoke when useRuntimeSessions is enabled', async () => {
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(p): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const sessionManager = { getOrCreate: vi.fn().mockResolvedValue('ses-abc') };
    const params = makeParams({ runtime, useRuntimeSessions: true, sessionManager: sessionManager as any });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);

    expect(sessionManager.getOrCreate).toHaveBeenCalledOnce();
    expect(invokeSpy).toHaveBeenCalledOnce();
    expect(invokeSpy.mock.calls[0][0].sessionId).toBe('ses-abc');
  });
});
