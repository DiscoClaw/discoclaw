import { describe, expect, it } from 'vitest';
import { toPlatformMessage } from './platform-message.js';
import type { PlatformMessage } from './platform-message.js';

/** Build a minimal fake discord.js Message for testing. */
function makeMsg(opts: {
  id?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  authorBot?: boolean;
  channelId?: string;
  guildId?: string | null;
  isThread?: boolean;
  threadId?: string;
  threadParentId?: string;
  type?: number;
  attachments?: Map<string, any>;
  embeds?: any[];
}): any {
  const isThread = opts.isThread ?? false;

  const channel: any = {
    isThread: () => isThread,
    id: opts.threadId ?? 'ch-1',
    parentId: opts.threadParentId ?? null,
  };

  return {
    id: opts.id ?? 'msg-1',
    content: opts.content ?? 'hello',
    author: {
      id: opts.authorId ?? 'user-1',
      username: opts.authorUsername ?? 'testuser',
      displayName: opts.authorDisplayName ?? 'Test User',
      bot: opts.authorBot ?? false,
    },
    channelId: opts.channelId ?? 'ch-1',
    guildId: opts.guildId !== undefined ? opts.guildId : 'guild-1',
    channel,
    type: opts.type ?? 0,
    attachments: opts.attachments ?? new Map(),
    embeds: opts.embeds ?? [],
  };
}

describe('toPlatformMessage', () => {
  it('maps basic fields', () => {
    const result: PlatformMessage = toPlatformMessage(makeMsg({}));

    expect(result.id).toBe('msg-1');
    expect(result.content).toBe('hello');
    expect(result.channelId).toBe('ch-1');
    expect(result.guildId).toBe('guild-1');
    expect(result.type).toBe(0);
  });

  it('maps author fields to flat properties', () => {
    const result = toPlatformMessage(
      makeMsg({ authorId: 'u-99', authorUsername: 'dave', authorDisplayName: 'Dave', authorBot: false }),
    );

    expect(result.authorId).toBe('u-99');
    expect(result.authorName).toBe('dave');
    expect(result.authorDisplayName).toBe('Dave');
    expect(result.isBot).toBe(false);
  });

  it('marks bot authors correctly', () => {
    const result = toPlatformMessage(makeMsg({ authorBot: true }));
    expect(result.isBot).toBe(true);
  });

  it('isDm is false for guild messages', () => {
    const result = toPlatformMessage(makeMsg({ guildId: 'guild-1' }));
    expect(result.isDm).toBe(false);
    expect(result.guildId).toBe('guild-1');
  });

  it('isDm is true when guildId is null', () => {
    const result = toPlatformMessage(makeMsg({ guildId: null }));
    expect(result.isDm).toBe(true);
    expect(result.guildId).toBeUndefined();
  });

  it('threadId and threadParentId are undefined for non-thread channels', () => {
    const result = toPlatformMessage(makeMsg({ isThread: false }));
    expect(result.threadId).toBeUndefined();
    expect(result.threadParentId).toBeUndefined();
  });

  it('populates threadId and threadParentId for thread channels', () => {
    const result = toPlatformMessage(
      makeMsg({ isThread: true, threadId: 'thread-42', threadParentId: 'parent-7' }),
    );

    expect(result.threadId).toBe('thread-42');
    expect(result.threadParentId).toBe('parent-7');
  });

  it('coerces null content to empty string', () => {
    const msg = makeMsg({});
    msg.content = null;
    const result = toPlatformMessage(msg);
    expect(result.content).toBe('');
  });

  it('preserves message type', () => {
    const result = toPlatformMessage(makeMsg({ type: 19 }));
    expect(result.type).toBe(19);
  });

  it('falls back to username when displayName is absent', () => {
    const msg = makeMsg({ authorUsername: 'dave123' });
    msg.author.displayName = undefined;
    const result = toPlatformMessage(msg);
    expect(result.authorDisplayName).toBe('dave123');
  });

  it('maps attachments to AttachmentLike objects', () => {
    const att = { url: 'https://cdn.example.com/img.png', name: 'img.png', contentType: 'image/png', size: 1024 };
    const attachments = new Map([['att-1', att]]);
    const result = toPlatformMessage(makeMsg({ attachments }));

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({ url: att.url, name: att.name, contentType: att.contentType, size: att.size });
  });

  it('maps embeds extracting title, url, and description', () => {
    const embeds = [{ title: 'My Title', url: 'https://example.com', description: 'Some text' }];
    const result = toPlatformMessage(makeMsg({ embeds }));

    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]).toEqual({ title: 'My Title', url: 'https://example.com', description: 'Some text' });
  });

  it('returns empty arrays when attachments and embeds are empty', () => {
    const result = toPlatformMessage(makeMsg({ attachments: new Map(), embeds: [] }));
    expect(result.attachments).toEqual([]);
    expect(result.embeds).toEqual([]);
  });

  it('handles embed with all-nullish fields', () => {
    const embeds = [{ title: null, url: null, description: null }];
    const result = toPlatformMessage(makeMsg({ embeds }));

    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].title).toBeUndefined();
    expect(result.embeds[0].url).toBeUndefined();
    expect(result.embeds[0].description).toBeUndefined();
  });
});
