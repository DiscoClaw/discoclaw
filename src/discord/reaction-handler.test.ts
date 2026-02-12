import { describe, expect, it, vi, afterEach } from 'vitest';
import { createReactionAddHandler, createReactionRemoveHandler } from './reaction-handler.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';
import type { BotParams, StatusRef } from '../discord.js';
import { inFlightReplyCount, _resetForTest as resetInFlight } from './inflight-replies.js';

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

function mockReplyObject() {
  return { edit: vi.fn().mockResolvedValue(undefined) };
}

function mockMessage(overrides?: Record<string, any>) {
  const replyObj = mockReplyObject();
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
    reply: vi.fn().mockResolvedValue(replyObj),
    _replyObj: replyObj,
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
    discordActionsBotProfile: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'haiku',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 5,
    summaryDataDir: '/tmp/summary',
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
    statusChannel: undefined,
    toolAwareStreaming: false,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: true,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 24 * 60 * 60 * 1000,
    streamStallWarningMs: 0,
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
    // Immediate placeholder reply.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
    // Final output via edit on the reply object.
    const replyObj = reaction.message._replyObj;
    const lastEditCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    expect(lastEditCall[0].content).toContain('Reaction response!');
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

  it('image attachments are downloaded and passed to runtime.invoke', async () => {
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

    // Mock global fetch for the image download
    const originalFetch = globalThis.fetch;
    const imgData = Buffer.from('fake-png');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imgData.buffer.slice(imgData.byteOffset, imgData.byteOffset + imgData.byteLength)),
    }) as any;

    try {
      const reaction = mockReaction();
      reaction.message.attachments = {
        size: 1,
        values: () => [{
          url: 'https://cdn.discordapp.com/attachments/123/456/photo.png',
          name: 'photo.png',
          contentType: 'image/png',
          size: 100,
        }] as any,
      };
      await handler(reaction as any, mockUser() as any);

      // Images should be passed in invoke params, not as URL text in prompt
      const invokeParams = invokeSpy.mock.calls[0][0];
      expect(invokeParams.images).toBeDefined();
      expect(invokeParams.images).toHaveLength(1);
      expect(invokeParams.images[0].mediaType).toBe('image/png');
      // Prompt should NOT contain the raw URL
      expect(invokeParams.prompt).not.toContain('https://cdn.discordapp.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    // Placeholder posted first.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
    // Final output via edit.
    const replyObj = reaction.message._replyObj;
    const lastEditCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    const replyContent: string = lastEditCall[0].content;
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
      beadSyncComplete: vi.fn(),
    };
    const statusRef: StatusRef = { current: statusPoster };
    const params = makeParams({ runtime: makeMockRuntimeError('timeout reached') });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue, statusRef);

    const reaction = mockReaction();
    await handler(reaction as any, mockUser() as any);

    expect(params.log?.error).toHaveBeenCalled();
    expect(statusPoster.runtimeError).toHaveBeenCalledOnce();
    // Placeholder first, then error via edit on the reply object.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
    const replyObj = reaction.message._replyObj;
    const lastEditCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    expect(lastEditCall[0].content).toContain('Runtime error: timeout reached');
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
    // Placeholder reply posted.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
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

  it('swallows 50083 (thread archived) without triggering handlerError', async () => {
    const statusPoster = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
      beadSyncComplete: vi.fn(),
    };
    const statusRef: StatusRef = { current: statusPoster };
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue, statusRef);

    // Make reply.edit throw a Discord 50083 "Thread is archived" error.
    const err50083 = Object.assign(new Error('Thread is archived'), { code: 50083 });
    const replyObj = { edit: vi.fn().mockRejectedValue(err50083) };
    const msg = mockMessage();
    msg._replyObj = replyObj;
    msg.reply = vi.fn().mockResolvedValue(replyObj);
    const reaction = mockReaction({ message: msg });

    await handler(reaction as any, mockUser() as any);

    expect(statusPoster.handlerError).not.toHaveBeenCalled();
    expect(params.log?.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
      expect.stringContaining('reply skipped (thread archived by action)'),
    );
  });

  it('text file attachments are downloaded and inlined in the prompt', async () => {
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

    const originalFetch = globalThis.fetch;
    const fileContent = 'const x = 42;';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(fileContent).buffer),
    }) as any;

    try {
      const reaction = mockReaction();
      reaction.message.attachments = {
        size: 1,
        values: () => [{
          url: 'https://cdn.discordapp.com/attachments/123/456/example.ts',
          name: 'example.ts',
          contentType: null,
          size: 100,
        }] as any,
      };
      await handler(reaction as any, mockUser() as any);

      const invokeParams = invokeSpy.mock.calls[0][0];
      expect(invokeParams.prompt).toContain('[Attached file: example.ts]');
      expect(invokeParams.prompt).toContain('const x = 42;');
      expect(invokeParams.prompt).not.toContain('https://cdn.discordapp.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('unsupported non-image attachment types produce notes in the prompt', async () => {
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

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('should not be called')) as any;

    try {
      const reaction = mockReaction();
      reaction.message.attachments = {
        size: 1,
        values: () => [{
          url: 'https://cdn.discordapp.com/attachments/123/456/archive.zip',
          name: 'archive.zip',
          contentType: 'application/zip',
          size: 5000,
        }] as any,
      };
      await handler(reaction as any, mockUser() as any);

      const invokeParams = invokeSpy.mock.calls[0][0];
      expect(invokeParams.prompt).toContain('[Unsupported attachment: archive.zip (application/zip)]');
      expect(invokeParams.prompt).not.toContain('https://cdn.discordapp.com');
      // fetch should NOT have been called (unsupported type is classified before download)
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('mixed image and text attachments: images passed as ImageData, text inlined in prompt', async () => {
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

    const originalFetch = globalThis.fetch;
    const fileContent = 'hello = true';
    const imgData = Buffer.from('fake-png');
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('.toml')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(fileContent).buffer),
        });
      }
      // Image path: downloadAttachment does buffer.toString('base64') with no content validation
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(imgData.buffer.slice(imgData.byteOffset, imgData.byteOffset + imgData.byteLength)),
      });
    }) as any;

    try {
      const reaction = mockReaction();
      reaction.message.attachments = {
        size: 2,
        values: () => [
          {
            url: 'https://cdn.discordapp.com/attachments/123/456/photo.png',
            name: 'photo.png',
            contentType: 'image/png',
            size: 100,
          },
          {
            url: 'https://cdn.discordapp.com/attachments/123/456/config.toml',
            name: 'config.toml',
            contentType: null,
            size: 50,
          },
        ] as any,
      };
      await handler(reaction as any, mockUser() as any);

      const invokeParams = invokeSpy.mock.calls[0][0];
      // Image should be in images array
      expect(invokeParams.images).toBeDefined();
      expect(invokeParams.images).toHaveLength(1);
      expect(invokeParams.images[0].mediaType).toBe('image/png');
      // Text file should be inlined in prompt
      expect(invokeParams.prompt).toContain('[Attached file: config.toml]');
      expect(invokeParams.prompt).toContain('hello = true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('text attachment download failure is caught and handler continues', async () => {
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

    // Mock fetch to throw — downloadTextAttachments catches per-file errors internally
    // and surfaces them as textResult.errors entries rather than throwing
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network collapsed')) as any;

    try {
      const reaction = mockReaction();
      reaction.message.attachments = {
        size: 1,
        values: () => [{
          url: 'https://cdn.discordapp.com/attachments/123/456/example.ts',
          name: 'example.ts',
          contentType: null,
          size: 100,
        }] as any,
      };
      await handler(reaction as any, mockUser() as any);

      // Handler should still invoke the runtime (graceful degradation)
      expect(invokeSpy).toHaveBeenCalledOnce();
      const invokeParams = invokeSpy.mock.calls[0][0];
      // File contents should not be present (download failed)
      expect(invokeParams.prompt).not.toContain('[Attached file:');
      // The error is caught per-file inside downloadTextAttachments, so it surfaces
      // as a textResult.errors entry logged via info, not the outer catch's warn
      expect(invokeParams.prompt).toContain('example.ts: download failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still triggers handlerError for non-50083 Discord errors', async () => {
    const statusPoster = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
      beadSyncComplete: vi.fn(),
    };
    const statusRef: StatusRef = { current: statusPoster };
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue, statusRef);

    const err50013 = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const replyObj = { edit: vi.fn().mockRejectedValue(err50013) };
    const msg = mockMessage();
    msg._replyObj = replyObj;
    msg.reply = vi.fn().mockResolvedValue(replyObj);
    const reaction = mockReaction({ message: msg });

    await handler(reaction as any, mockUser() as any);

    expect(statusPoster.handlerError).toHaveBeenCalledOnce();
  });
});

describe('createReactionRemoveHandler', () => {
  it('ignores self-reactions (bot reacting to its own)', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    const reaction = mockReaction();
    const user = mockUser({ id: 'bot-1' });
    await handler(reaction as any, user as any);

    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores non-allowlisted users', async () => {
    const params = makeParams({ allowUserIds: new Set(['other-user']) });
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores reactions in non-allowed channels', async () => {
    const params = makeParams({ allowChannelIds: new Set(['other-channel']) });
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores DM reactions (guildId null)', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    const reaction = mockReaction({
      message: mockMessage({ guildId: null }),
    });
    await handler(reaction as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('ignores stale messages older than reactionMaxAgeMs', async () => {
    const params = makeParams({ reactionMaxAgeMs: 1000 });
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    const reaction = mockReaction({
      message: mockMessage({ createdTimestamp: Date.now() - 5000 }),
    });
    await handler(reaction as any, mockUser() as any);
    expect(queue.run).not.toHaveBeenCalled();
  });

  it('happy path — allowlisted user unreacts, runtime responds, reply posted', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    expect(queue.run).toHaveBeenCalledOnce();
    // Immediate placeholder reply.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
    // Final output via edit on the reply object.
    const replyObj = reaction.message._replyObj;
    const lastEditCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    expect(lastEditCall[0].content).toContain('Reaction response!');
  });

  it('prompt contains "removed their" and does NOT contain "reacted with"', async () => {
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
    const handler = createReactionRemoveHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('removed their');
    expect(prompt).not.toContain('reacted with');
  });

  it('increments discord.reaction_remove.received metric', async () => {
    const { MetricsRegistry } = await import('../observability/metrics.js');
    const metrics = new MetricsRegistry();
    const params = makeParams({ metrics });
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

    await handler(mockReaction() as any, mockUser() as any);

    const snap = metrics.snapshot();
    expect(snap.counters['discord.reaction_remove.received']).toBe(1);
  });

  it('handles partial reaction fetch failure gracefully', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue);

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
    const handler = createReactionRemoveHandler(params, queue);

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
      beadSyncComplete: vi.fn(),
    };
    const statusRef: StatusRef = { current: statusPoster };
    const params = makeParams({ runtime: makeMockRuntimeError('timeout reached') });
    const queue = mockQueue();
    const handler = createReactionRemoveHandler(params, queue, statusRef);

    const reaction = mockReaction();
    await handler(reaction as any, mockUser() as any);

    expect(params.log?.error).toHaveBeenCalled();
    expect(statusPoster.runtimeError).toHaveBeenCalledOnce();
    // Placeholder first, then error via edit.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    expect(reaction.message.reply.mock.calls[0][0].content).toMatch(/Thinking/);
    const replyObj = reaction.message._replyObj;
    const lastEditCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    expect(lastEditCall[0].content).toContain('Runtime error: timeout reached');
  });
});

describe('streaming behavior', () => {
  it('emits multiple edits for text_delta events (throttled)', async () => {
    vi.useFakeTimers();
    try {
      const runtime: RuntimeAdapter = {
        id: 'claude_code',
        capabilities: new Set(['streaming_text']),
        async *invoke(): AsyncIterable<EngineEvent> {
          yield { type: 'text_delta', text: 'Hello ' };
          yield { type: 'text_delta', text: 'world' };
          yield { type: 'text_final', text: 'Hello world' };
          yield { type: 'done' };
        },
      };
      const params = makeParams({ runtime });
      const queue = mockQueue();
      const handler = createReactionAddHandler(params, queue);
      const reaction = mockReaction();

      await handler(reaction as any, mockUser() as any);

      const replyObj = reaction.message._replyObj;
      // At least the forced final edit should have happened.
      expect(replyObj.edit).toHaveBeenCalled();
      // Last edit should contain final text.
      const lastCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
      expect(lastCall[0].content).toContain('Hello world');
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams log_line events into delta text', async () => {
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'log_line', stream: 'stdout', line: 'building...' };
        yield { type: 'log_line', stream: 'stderr', line: 'warn: deprecated' };
        yield { type: 'text_final', text: 'Done' };
        yield { type: 'done' };
      },
    };
    const params = makeParams({ runtime });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    const replyObj = reaction.message._replyObj;
    // Some intermediate edit should contain the log lines.
    const allEditContents = replyObj.edit.mock.calls.map((c: any) => c[0].content);
    const hasStdout = allEditContents.some((c: string) => c.includes('[stdout]'));
    const hasStderr = allEditContents.some((c: string) => c.includes('[stderr]'));
    expect(hasStdout).toBe(true);
    expect(hasStderr).toBe(true);
  });

  it('cleans up stale placeholder on handler error after reply was created', async () => {
    // Runtime that throws after yielding nothing.
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        throw new Error('unexpected crash');
      },
    };
    const params = makeParams({ runtime });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    // Placeholder was posted.
    expect(reaction.message.reply).toHaveBeenCalledOnce();
    // Reply should be edited with error message (not left as "Thinking.").
    const replyObj = reaction.message._replyObj;
    expect(replyObj.edit).toHaveBeenCalled();
    const lastCall = replyObj.edit.mock.calls[replyObj.edit.mock.calls.length - 1];
    expect(lastCall[0].content).toMatch(/error|unexpected/i);
  });
});

describe('in-flight reply registry cleanup', () => {
  afterEach(() => {
    resetInFlight();
  });

  it('no leaked registry entries after normal completion', async () => {
    const params = makeParams();
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    expect(inFlightReplyCount()).toBe(0);
  });

  it('no leaked registry entries after runtime error', async () => {
    const params = makeParams({ runtime: makeMockRuntimeError('timeout') });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    expect(inFlightReplyCount()).toBe(0);
  });

  it('no leaked registry entries on handler exception', async () => {
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        throw new Error('unexpected crash');
      },
    };
    const params = makeParams({ runtime });
    const queue = mockQueue();
    const handler = createReactionAddHandler(params, queue);
    const reaction = mockReaction();

    await handler(reaction as any, mockUser() as any);

    expect(inFlightReplyCount()).toBe(0);
  });
});
