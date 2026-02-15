import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';

import { createMessageCreateHandler } from './discord.js';
import { hasQueryAction, QUERY_ACTION_TYPES } from './discord/action-categories.js';
import { inFlightReplyCount, _resetForTest as resetInFlight } from './discord/inflight-replies.js';

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
    actionFollowupDepth: 3,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 24 * 60 * 60 * 1000,
    streamStallWarningMs: 0,
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

  it('suppresses sendMessage Done line from posted message but keeps it in follow-up prompt', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          // First call: emit a channelList (query) + sendMessage action.
          yield {
            type: 'text_final',
            text: 'Here you go:\n<discord-action>{"type":"channelList"}</discord-action>\n<discord-action>{"type":"sendMessage","channel":"general","content":"hello"}</discord-action>',
          } as any;
        } else {
          yield { type: 'text_final', text: 'Analysis complete with enough length to avoid suppression threshold for testing.' } as any;
        }
      }),
    } as any;

    // Build a guild mock that supports both cache.get() and cache.find() with a sendable channel.
    const generalCh = {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      parent: { name: 'Dev' },
      send: vi.fn(async () => ({})),
    };
    const catCh = {
      id: 'cat1',
      name: 'Dev',
      type: ChannelType.GuildCategory,
      parent: null,
    };
    const channelsMap = new Map<string, any>([
      ['ch1', generalCh],
      ['cat1', catCh],
    ]);
    const guild = {
      channels: {
        cache: {
          get: (id: string) => channelsMap.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of channelsMap.values()) if (fn(ch)) return ch;
            return undefined;
          },
          values: () => channelsMap.values(),
          get size() { return channelsMap.size; },
        },
        create: vi.fn(async (opts: any) => ({ name: opts.name, id: 'new-id' })),
      },
    } as any;

    const handler = createMessageCreateHandler(
      baseParams(runtime, { discordActionsMessaging: true }),
      makeQueue(),
    );
    const msg = makeMsg({ guild });
    await handler(msg);

    expect(runtime.invoke).toHaveBeenCalledTimes(2);

    // The follow-up prompt should contain the sendMessage Done line (all results unfiltered).
    const secondPrompt = runtime.invoke.mock.calls[1][0].prompt;
    expect(secondPrompt).toContain('[Auto-follow-up]');
    expect(secondPrompt).toContain('Done: Sent message');

    // The posted message (first reply edit) should NOT contain 'Done: Sent message'.
    const replyObj = await msg.reply.mock.results[0]?.value;
    if (replyObj) {
      const allEditContents = replyObj.edit.mock.calls.map((c: any[]) =>
        typeof c[0] === 'string' ? c[0] : c[0]?.content ?? '',
      );
      const postedContent = allEditContents[allEditContents.length - 1];
      expect(postedContent).not.toContain('Done: Sent message');
    }
  });

  it('suppresses sendMessage targeting parent forum when in a bead thread', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield {
          type: 'text_final',
          text: 'Here is my response.\n<discord-action>{"type":"sendMessage","channel":"forum1","content":"hello"}</discord-action>',
        } as any;
      }),
    } as any;

    // Build a guild with a forum channel and thread channel in the cache.
    const forumCh = {
      id: 'forum1',
      name: 'beads',
      type: ChannelType.GuildForum,
      parent: null,
      send: vi.fn(async () => ({})),
    };
    const threadCh = {
      id: 'thread1',
      name: 'my-bead',
      type: ChannelType.PublicThread,
      parentId: 'forum1',
      parent: { name: 'beads' },
      isThread: () => true,
      joinable: false,
      joined: true,
      send: vi.fn(async () => ({ edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) })),
    };
    const channelsMap = new Map<string, any>([
      ['forum1', forumCh],
      ['thread1', threadCh],
    ]);
    const guild = {
      channels: {
        cache: {
          get: (id: string) => channelsMap.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of channelsMap.values()) if (fn(ch)) return ch;
            return undefined;
          },
          values: () => channelsMap.values(),
          get size() { return channelsMap.size; },
        },
        create: vi.fn(async (opts: any) => ({ name: opts.name, id: 'new-id' })),
      },
    } as any;

    const handler = createMessageCreateHandler(
      baseParams(runtime, { discordActionsMessaging: true }),
      makeQueue(),
    );
    const msg = makeMsg({
      guild,
      channel: threadCh,
      channelId: 'thread1',
    });
    await handler(msg);

    // The reply should contain the prose text.
    const replyObj = await msg.reply.mock.results[0]?.value;
    if (replyObj) {
      const allEditContents = replyObj.edit.mock.calls.map((c: any[]) =>
        typeof c[0] === 'string' ? c[0] : c[0]?.content ?? '',
      );
      const postedContent = allEditContents[allEditContents.length - 1];
      // Prose should be present.
      expect(postedContent).toContain('Here is my response.');
      // Should NOT contain a Failed: line (the forum sendMessage was suppressed, not errored).
      expect(postedContent).not.toContain('Failed:');
    }
    // Forum channel's .send() should NOT have been called.
    expect(forumCh.send).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// In-flight reply cleanup verification
// ---------------------------------------------------------------------------

describe('in-flight reply registry cleanup', () => {
  afterEach(() => {
    resetInFlight();
  });

  it('no leaked registry entries after normal completion', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'Hello there!' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    expect(inFlightReplyCount()).toBe(0);
  });

  it('no leaked registry entries after follow-up completes', async () => {
    let callCount = 0;
    const runtime = {
      invoke: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text_final', text: 'Listing:\n<discord-action>{"type":"channelList"}</discord-action>' } as any;
        } else {
          yield { type: 'text_final', text: 'Analysis complete with sufficient length to avoid suppression threshold limits.' } as any;
        }
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    expect(inFlightReplyCount()).toBe(0);
  });

  it('no leaked registry entries after runtime error', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'error', message: 'runtime crashed' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(baseParams(runtime), makeQueue());
    await handler(makeMsg());

    expect(inFlightReplyCount()).toBe(0);
  });

  it('no leaked registry entries on requireChannelContext early return', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'should not reach' } as any;
      }),
    } as any;

    const handler = createMessageCreateHandler(
      baseParams(runtime, { requireChannelContext: true }),
      makeQueue(),
    );
    await handler(makeMsg());

    // Runtime should not have been invoked (early return before invoke).
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(inFlightReplyCount()).toBe(0);
  });
});
