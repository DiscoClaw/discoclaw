import { describe, expect, it, vi } from 'vitest';

import { createMessageCreateHandler } from './discord.js';
import type { StatusRef } from './discord.js';

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
}

function makeMsg(overrides: Partial<any> = {}) {
  const replyObj = { edit: vi.fn(async () => {}) };
  return {
    author: { id: '123', bot: false, displayName: 'User', username: 'user' },
    guildId: 'guild',
    channelId: 'chan',
    channel: { send: vi.fn(async () => {}), isThread: () => false, name: 'general' },
    content: 'hello',
    reply: vi.fn(async () => replyObj),
    id: 'msg1',
    ...overrides,
  };
}

function baseParams(runtimeOverride: any) {
  return {
    allowUserIds: new Set(['123']),
    botDisplayName: 'TestBot',
    runtime: runtimeOverride,
    sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
    workspaceCwd: '/tmp',
    projectCwd: '/tmp',
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
    discordActionsTasks: false,
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
  };
}

function mockStatus() {
  return {
    online: vi.fn(async () => {}),
    offline: vi.fn(async () => {}),
    runtimeError: vi.fn(async () => {}),
    handlerError: vi.fn(async () => {}),
    actionFailed: vi.fn(async () => {}),
    taskSyncComplete: vi.fn(async () => {}),
  };
}

describe('status wiring in message handler', () => {
  it('calls runtimeError when runtime emits an error event', async () => {
    const runtime = {
      invoke: async function* () {
        yield { type: 'error', message: 'timed out' } as any;
      },
    } as any;
    const status = mockStatus();
    const statusRef: StatusRef = { current: status };
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue(), statusRef);

    await handler(makeMsg());

    expect(status.runtimeError).toHaveBeenCalledOnce();
    expect(status.runtimeError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
      'timed out',
    );
  });

  it('calls handlerError when an exception is thrown', async () => {
    const runtime = {
      invoke: async function* () {
        throw new Error('kaboom');
      },
    } as any;
    const status = mockStatus();
    const statusRef: StatusRef = { current: status };
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue(), statusRef);

    await handler(makeMsg());

    expect(status.handlerError).toHaveBeenCalledOnce();
    expect(status.handlerError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
      expect.any(Error),
    );
  });

  it('does not call status methods when statusRef.current is null', async () => {
    const runtime = {
      invoke: async function* () {
        yield { type: 'error', message: 'oops' } as any;
      },
    } as any;
    const statusRef: StatusRef = { current: null };
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue(), statusRef);

    // Should not throw even though status is null.
    await expect(handler(makeMsg())).resolves.toBeUndefined();
  });

  it('does not call status methods when statusRef is omitted', async () => {
    const runtime = {
      invoke: async function* () {
        yield { type: 'error', message: 'oops' } as any;
      },
    } as any;
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());

    await expect(handler(makeMsg())).resolves.toBeUndefined();
  });

  it('swallows 50083 (thread archived) without calling handlerError', async () => {
    const runtime = {
      invoke: async function* () {
        yield { type: 'text_final', text: 'Done' } as any;
      },
    } as any;
    const status = mockStatus();
    const statusRef: StatusRef = { current: status };
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue(), statusRef);

    // Make reply.edit throw a Discord 50083 "Thread is archived" error.
    const err50083 = Object.assign(new Error('Thread is archived'), { code: 50083 });
    const replyObj = { edit: vi.fn().mockRejectedValue(err50083), delete: vi.fn(async () => {}) };
    const msg = makeMsg();
    msg.reply = vi.fn(async () => replyObj);

    await handler(msg);

    expect(status.handlerError).not.toHaveBeenCalled();
  });

  it('still calls handlerError for non-50083 Discord errors', async () => {
    const runtime = {
      invoke: async function* () {
        yield { type: 'text_final', text: 'Done' } as any;
      },
    } as any;
    const status = mockStatus();
    const statusRef: StatusRef = { current: status };
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue(), statusRef);

    // A different Discord error (e.g. Missing Permissions = 50013).
    const err50013 = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const replyObj = { edit: vi.fn().mockRejectedValue(err50013) };
    const msg = makeMsg();
    msg.reply = vi.fn(async () => replyObj);

    await handler(msg);

    expect(status.handlerError).toHaveBeenCalledOnce();
  });
});
