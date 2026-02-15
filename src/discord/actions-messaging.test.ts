import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { executeMessagingAction } from './actions-messaging.js';
import type { MessagingActionRequest } from './actions-messaging.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockChannel(overrides: Partial<any> = {}) {
  const messages = new Map<string, any>();
  return {
    id: overrides.id ?? 'ch1',
    name: overrides.name ?? 'general',
    type: overrides.type ?? ChannelType.GuildText,
    send: vi.fn(async () => ({ id: 'sent-1' })),
    messages: {
      fetch: vi.fn(async (arg: any) => {
        if (typeof arg === 'string') {
          const m = messages.get(arg);
          if (!m) throw new Error('Unknown message');
          return m;
        }
        // Return a collection-like map for bulk fetch.
        return overrides.fetchedMessages ?? new Map();
      }),
      fetchPinned: vi.fn(async () => overrides.pinnedMessages ?? new Map()),
    },
    threads: {
      create: vi.fn(async (opts: any) => ({ name: opts.name, id: 'thread-1' })),
    },
    ...(overrides.extraProps ?? {}),
  };
}

function makeMockMessage(id: string, overrides: Partial<any> = {}) {
  const { author: authorName, ...rest } = overrides;
  return {
    id,
    content: rest.content ?? 'Hello',
    author: { username: authorName ?? 'testuser' },
    createdAt: new Date('2025-01-15T12:00:00Z'),
    createdTimestamp: new Date('2025-01-15T12:00:00Z').getTime(),
    react: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
    unpin: vi.fn(async () => {}),
    startThread: vi.fn(async (opts: any) => ({ name: opts.name, id: 'thread-from-msg' })),
    ...rest,
  };
}

function makeCtx(channels: any[]): ActionContext {
  const cache = new Map<string, any>();
  for (const ch of channels) cache.set(ch.id, ch);

  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of cache.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
          values: () => cache.values(),
        },
      },
    } as any,
    client: {} as any,
    channelId: 'ch1',
    messageId: 'msg1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('sends a message to a resolved channel', async () => {
    const ch = makeMockChannel({ name: 'general' });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: '#general', content: 'Hello!' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Sent message to #general' });
    expect(ch.send).toHaveBeenCalledWith({ content: 'Hello!', allowedMentions: { parse: [] } });
  });

  it('sends a reply when replyTo is set', async () => {
    const ch = makeMockChannel({ name: 'general' });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'general', content: 'Reply!', replyTo: 'msg-123' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ch.send).toHaveBeenCalledWith({
      content: 'Reply!',
      allowedMentions: { parse: [] },
      reply: { messageReference: 'msg-123' },
    });
  });

  it('fails when channel not found', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: '#nonexistent', content: 'Hi' },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'Channel "#nonexistent" not found' });
  });

  it('rejects content exceeding 2000 chars', async () => {
    const ch = makeMockChannel({ name: 'general' });
    const ctx = makeCtx([ch]);
    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: '#general', content: 'x'.repeat(2001) },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('2000 character limit');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('rejects empty content', async () => {
    const ch = makeMockChannel({ name: 'general' });
    const ctx = makeCtx([ch]);
    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: '#general', content: '   ' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('non-empty string');
  });

  it('returns descriptive error when targeting a forum channel by ID', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'forum1', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).toContain('threadCreate');
    expect((result as any).error).not.toContain('not found');
  });

  it('returns descriptive error when targeting a forum channel by name', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'beads', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).not.toContain('not found');
  });

  it('silently suppresses sendMessage to parent forum when inside a child thread', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const thread = makeMockChannel({ id: 'thread1', name: 'my-bead', type: ChannelType.PublicThread, extraProps: { parentId: 'forum1' } });
    const ctx = makeCtx([forum, thread]);
    ctx.channelId = 'thread1';

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'forum1', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Suppressed');
    expect(forum.send).not.toHaveBeenCalled();
  });

  it('silently suppresses sendMessage to parent forum by name when inside a child thread', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const thread = makeMockChannel({ id: 'thread1', name: 'my-bead', type: ChannelType.PublicThread, extraProps: { parentId: 'forum1' } });
    const ctx = makeCtx([forum, thread]);
    ctx.channelId = 'thread1';

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'beads', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Suppressed');
  });

  it('still errors when targeting a forum channel from a non-child channel', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const otherChannel = makeMockChannel({ id: 'ch2', name: 'general', type: ChannelType.GuildText });
    const ctx = makeCtx([forum, otherChannel]);
    ctx.channelId = 'ch2';

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'forum1', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).toContain('threadCreate');
  });

  it('returns descriptive error when targeting a voice channel by ID', async () => {
    const voice = makeMockChannel({ id: 'v1', name: 'voice', type: ChannelType.GuildVoice });
    const ctx = makeCtx([voice]);

    const result = await executeMessagingAction(
      { type: 'sendMessage', channel: 'v1', content: 'Hello' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('voice channel');
    expect((result as any).error).not.toContain('not found');
  });
});

describe('react', () => {
  it('adds a reaction to a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'react', channelId: 'ch1', messageId: 'msg1', emoji: '👍' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Reacted with 👍' });
    expect(msg.react).toHaveBeenCalledWith('👍');
  });
});

describe('unreact', () => {
  it('removes bot reaction from a message', async () => {
    const removeFn = vi.fn(async () => {});
    const msg = makeMockMessage('msg1');
    (msg as any).reactions = {
      resolve: vi.fn((emoji: string) => ({
        users: { remove: removeFn },
      })),
    };
    const ch = makeMockChannel({ id: 'ch1' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);
    ctx.client = { user: { id: 'bot-user-id' } } as any;

    const result = await executeMessagingAction(
      { type: 'unreact', channelId: 'ch1', messageId: 'msg1', emoji: '👍' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Removed reaction 👍' });
    expect((msg as any).reactions.resolve).toHaveBeenCalledWith('👍');
    expect(removeFn).toHaveBeenCalledWith('bot-user-id');
  });

  it('fails when reaction not found on message', async () => {
    const msg = makeMockMessage('msg1');
    (msg as any).reactions = {
      resolve: vi.fn(() => null),
    };
    const ch = makeMockChannel({ id: 'ch1' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'unreact', channelId: 'ch1', messageId: 'msg1', emoji: '🔥' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Reaction "🔥" not found on message' });
  });
});

describe('readMessages', () => {
  it('reads and formats messages', async () => {
    const msg1 = makeMockMessage('m1', { content: 'First', author: 'alice' });
    const msg2 = makeMockMessage('m2', { content: 'Second', author: 'bob' });
    const fetchedMessages = new Map([['m1', msg1], ['m2', msg2]]);
    const ch = makeMockChannel({ name: 'general', fetchedMessages });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'readMessages', channel: '#general', limit: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('[alice] First');
    expect(summary).toContain('[bob] Second');
  });

  it('returns descriptive error when targeting a forum channel by ID', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'readMessages', channel: 'forum1', limit: 5 },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).not.toContain('not found');
  });

  it('returns descriptive error when targeting a forum channel by name', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'readMessages', channel: 'beads', limit: 5 },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).not.toContain('not found');
  });

  it('clamps limit to 20', async () => {
    const ch = makeMockChannel({ name: 'general', fetchedMessages: new Map() });
    const ctx = makeCtx([ch]);

    await executeMessagingAction(
      { type: 'readMessages', channel: '#general', limit: 50 },
      ctx,
    );

    expect(ch.messages.fetch).toHaveBeenCalledWith({ limit: 20 });
  });
});

describe('fetchMessage', () => {
  it('fetches and formats a single message', async () => {
    const msg = makeMockMessage('msg1', { content: 'Fetched message', author: 'alice' });
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'fetchMessage', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('[alice]: Fetched message');
    expect((result as any).summary).toContain('#general');
  });
});

describe('editMessage', () => {
  it('edits a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'editMessage', channelId: 'ch1', messageId: 'msg1', content: 'Updated' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Edited message in #general' });
    expect(msg.edit).toHaveBeenCalledWith({ content: 'Updated', allowedMentions: { parse: [] } });
  });

  it('rejects content exceeding 2000 chars', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'editMessage', channelId: 'ch1', messageId: 'msg1', content: 'x'.repeat(2001) },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('2000 character limit');
  });
});

describe('deleteMessage', () => {
  it('deletes a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'deleteMessage', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Deleted message in #general' });
    expect(msg.delete).toHaveBeenCalled();
  });
});

describe('bulkDelete', () => {
  it('bulk deletes messages', async () => {
    const deleted = new Map([['m1', {}], ['m2', {}], ['m3', {}]]);
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    (ch as any).bulkDelete = vi.fn(async () => deleted);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'bulkDelete', channelId: 'ch1', count: 10 },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Bulk deleted 3 messages in #general' });
    expect((ch as any).bulkDelete).toHaveBeenCalledWith(10, true);
  });

  it('rejects count below 2', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'bulkDelete', channelId: 'ch1', count: 1 },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'bulkDelete count must be an integer between 2 and 100' });
  });

  it('rejects count above 100', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'bulkDelete', channelId: 'ch1', count: 101 },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'bulkDelete count must be an integer between 2 and 100' });
  });

  it('rejects non-integer count', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'bulkDelete', channelId: 'ch1', count: 5.5 },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'bulkDelete count must be an integer between 2 and 100' });
  });

  it('fails when channel not found', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'bulkDelete', channelId: 'nope', count: 5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found');
  });
});

describe('crosspost', () => {
  it('crossposts a message in an announcement channel', async () => {
    const msg = makeMockMessage('msg1');
    (msg as any).crosspost = vi.fn(async () => {});
    const ch = makeMockChannel({ id: 'ch1', name: 'announcements', type: ChannelType.GuildAnnouncement });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'crosspost', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Published message to followers of #announcements' });
    expect((msg as any).crosspost).toHaveBeenCalled();
  });

  it('fails when channel is not an announcement channel', async () => {
    const ch = makeMockChannel({ id: 'ch1', name: 'general', type: ChannelType.GuildText });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'crosspost', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel #general is not an announcement channel' });
  });

  it('fails when channel not found', async () => {
    const ctx = makeCtx([]);
    const result = await executeMessagingAction(
      { type: 'crosspost', channelId: 'nope', messageId: 'msg1' },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });
});

describe('threadCreate', () => {
  it('creates a thread from a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'threadCreate', channelId: 'ch1', name: 'Discussion', messageId: 'msg1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Discussion');
    expect(msg.startThread).toHaveBeenCalledWith({ name: 'Discussion', autoArchiveDuration: 1440 });
  });

  it('creates a standalone thread', async () => {
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'threadCreate', channelId: 'ch1', name: 'New Thread' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('New Thread');
    expect(ch.threads.create).toHaveBeenCalledWith({ name: 'New Thread', autoArchiveDuration: 1440 });
  });
});

describe('pinMessage / unpinMessage', () => {
  it('pins a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'pinMessage', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Pinned message in #general' });
    expect(msg.pin).toHaveBeenCalled();
  });

  it('unpins a message', async () => {
    const msg = makeMockMessage('msg1');
    const ch = makeMockChannel({ id: 'ch1', name: 'general' });
    ch.messages.fetch = vi.fn(async () => msg);
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'unpinMessage', channelId: 'ch1', messageId: 'msg1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Unpinned message in #general' });
    expect(msg.unpin).toHaveBeenCalled();
  });
});

describe('listPins', () => {
  it('lists pinned messages', async () => {
    const pinned = new Map([
      ['p1', { id: 'p1', content: 'Important', author: { username: 'alice' } }],
    ]);
    const ch = makeMockChannel({ name: 'general', pinnedMessages: pinned });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'listPins', channel: '#general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('[alice] Important');
  });

  it('returns descriptive error when targeting a forum channel by ID', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'listPins', channel: 'forum1' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).not.toContain('not found');
  });

  it('returns descriptive error when targeting a forum channel by name', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'beads', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeMessagingAction(
      { type: 'listPins', channel: 'beads' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect((result as any).error).not.toContain('not found');
  });

  it('returns empty message when no pins', async () => {
    const ch = makeMockChannel({ name: 'general' });
    const ctx = makeCtx([ch]);

    const result = await executeMessagingAction(
      { type: 'listPins', channel: '#general' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'No pinned messages in #general' });
  });
});
