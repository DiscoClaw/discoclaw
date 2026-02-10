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
    expect(ch.send).toHaveBeenCalledWith({ content: 'Hello!' });
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
    expect(msg.edit).toHaveBeenCalledWith('Updated');
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
