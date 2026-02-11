import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

import { createMessageCreateHandler } from './discord.js';
import { hasQueryAction, QUERY_ACTION_TYPES } from './discord/action-categories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
}

function makeMsg(overrides: Partial<any> = {}) {
  const replyObj = { edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const guild = makeMockGuild([
    { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
    { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Dev' },
  ]);
  return {
    author: { id: '123', bot: false, displayName: 'User', username: 'user' },
    guildId: 'guild',
    guild,
    channelId: 'chan',
    channel: { send: vi.fn(async () => ({ edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) })), isThread: () => false, name: 'general' },
    content: 'list all channels',
    reply: vi.fn(async () => replyObj),
    id: 'msg1',
    client: {} as any,
    ...overrides,
  };
}

function makeMockGuild(channels: Array<{ id: string; name: string; type: ChannelType; parentName?: string }>) {
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parent: ch.parentName ? { name: ch.parentName } : null,
    });
  }
  return {
    channels: {
      cache: {
        find: (fn: (ch: any) => boolean) => {
          for (const ch of cache.values()) if (fn(ch)) return ch;
          return undefined;
        },
        values: () => cache.values(),
        get size() { return cache.size; },
      },
      create: vi.fn(async (opts: any) => ({ name: opts.name, id: 'new-id' })),
    },
  } as any;
}

function baseParams(runtimeOverride: any, overrides: Partial<any> = {}) {
  return {
    allowUserIds: new Set(['123']),
    botDisplayName: 'TestBot',
    runtime: runtimeOverride,
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
    discordActionsChannels: true,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsBeads: false,
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
    actionFollowupDepth: 3,
    reactionHandlerEnabled: false,
    reactionMaxAgeMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasQueryAction unit tests
// ---------------------------------------------------------------------------

describe('hasQueryAction', () => {
  it('returns true when a query action type is present', () => {
    expect(hasQueryAction(['channelList'])).toBe(true);
    expect(hasQueryAction(['readMessages', 'sendMessage'])).toBe(true);
    expect(hasQueryAction(['beadShow'])).toBe(true);
  });

  it('returns false when only mutation types are present', () => {
    expect(hasQueryAction(['channelCreate'])).toBe(false);
    expect(hasQueryAction(['sendMessage', 'channelDelete'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(hasQueryAction([])).toBe(false);
  });
});

describe('QUERY_ACTION_TYPES', () => {
  it('contains all expected query types', () => {
    const expected = [
      'channelList', 'channelInfo', 'threadListArchived',
      'readMessages', 'fetchMessage', 'listPins',
      'memberInfo', 'roleInfo', 'searchMessages', 'eventList',
      'beadList', 'beadShow',
    ];
    for (const t of expected) {
      expect(QUERY_ACTION_TYPES.has(t)).toBe(true);
    }
  });

  it('does not contain mutation types', () => {
    const mutations = ['channelCreate', 'channelDelete', 'sendMessage', 'beadCreate', 'beadClose'];
    for (const t of mutations) {
      expect(QUERY_ACTION_TYPES.has(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-follow-up integration tests
// ---------------------------------------------------------------------------

describe('auto-follow-up for query actions', () => {
  it('triggers follow-up when a query action (channelList) is present', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          // First call: emit a channelList action.
          yield { type: 'text_final', text: 'Here are the channels:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
        } else {
          // Follow-up call: just respond with analysis.
          yield { type: 'text_final', text: 'I can see there are 2 channels in the server.' } as any;
        }
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    // Second call should have auto-follow-up prompt.
    const secondPrompt = runtime.invoke.mock.calls[1][0].prompt;
    expect(secondPrompt).toContain('[Auto-follow-up]');
    expect(secondPrompt).toContain('Done:');
  });

  it('does NOT trigger follow-up for mutation-only actions', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'Creating channel:\n<discord-action>{"type":"channelCreate","name":"test"}</discord-action>' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });

  it('triggers follow-up when mixed query+mutation actions are present', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'text_final',
            text: 'Listing and creating:\n<discord-action>{"type":"channelList"}</discord-action>\n<discord-action>{"type":"channelCreate","name":"new-ch"}</discord-action>',
          } as any;
        } else {
          yield { type: 'text_final', text: 'Done analyzing the channel list.' } as any;
        }
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    // Should follow up because channelList (query) was present and succeeded.
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
  });

  it('respects depth limit (no infinite loops)', async () => {
    // Each invoke produces a channelList action, would loop forever without depth limit.
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'Checking:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(
      baseParams(runtime, { actionFollowupDepth: 2 }),
      makeQueue(),
    );
    await handler(makeMsg());

    // Initial invoke + 2 follow-ups = 3 total.
    expect(runtime.invoke).toHaveBeenCalledTimes(3);
  });

  it('does not follow up when depth is 0 (feature disabled)', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'List:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(
      baseParams(runtime, { actionFollowupDepth: 0 }),
      makeQueue(),
    );
    await handler(makeMsg());

    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });

  it('suppresses trivially short follow-up responses', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text_final', text: 'Listing:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
        } else {
          // Trivially short response with no actions.
          yield { type: 'text_final', text: 'Got it.' } as any;
        }
      }),
    } as any;

    const msg = makeMsg();
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(msg);

    // Should invoke twice (initial + follow-up), but the follow-up message should be deleted.
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    // The follow-up placeholder is created via channel.send, and should have delete() called.
    const sendResult = await msg.channel.send.mock.results[0]?.value;
    if (sendResult) {
      expect(sendResult.delete).toHaveBeenCalled();
    }
  });

  it('does not suppress a substantial follow-up response', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text_final', text: 'Listing:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
        } else {
          yield { type: 'text_final', text: 'Based on the channel list, I can see you have a Dev category with a general channel, plus a random channel at the top level.' } as any;
        }
      }),
    } as any;

    const msg = makeMsg();
    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(msg);

    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    // The follow-up message should be edited (not deleted).
    const sendResult = await msg.channel.send.mock.results[0]?.value;
    if (sendResult) {
      expect(sendResult.edit).toHaveBeenCalled();
      expect(sendResult.delete).not.toHaveBeenCalled();
    }
  });

  it('follow-up runs inside queue (serialization preserved)', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text_final', text: 'Listing:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
        } else {
          yield { type: 'text_final', text: 'Analysis of channels complete with detailed information.' } as any;
        }
      }),
    } as any;

    const queue = makeQueue();
    const handler = createMessageCreateHandler(baseParams(runtime), queue);
    await handler(makeMsg());

    // Queue.run is called once for the entire message handling (including follow-ups).
    expect(queue.run).toHaveBeenCalledTimes(1);
  });

  it('does not follow up when query action fails', async () => {
    // Guild with no channels — channelList still succeeds with empty list.
    // Use a channelInfo with bad ID to get a failure.
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'Info:\n<discord-action>{"type":"channelInfo","channelId":"nonexistent"}</discord-action>' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    // channelInfo for a non-existent channel fails -> no follow-up.
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });
});
