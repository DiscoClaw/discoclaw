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

  it('maps author fields', () => {
    const result = toPlatformMessage(
      makeMsg({ authorId: 'u-99', authorUsername: 'dave', authorDisplayName: 'Dave', authorBot: false }),
    );

    expect(result.author.id).toBe('u-99');
    expect(result.author.username).toBe('dave');
    expect(result.author.displayName).toBe('Dave');
    expect(result.author.bot).toBe(false);
  });

  it('marks bot authors correctly', () => {
    const result = toPlatformMessage(makeMsg({ authorBot: true }));
    expect(result.author.bot).toBe(true);
  });

  it('isDm is false for guild messages', () => {
    const result = toPlatformMessage(makeMsg({ guildId: 'guild-1' }));
    expect(result.isDm).toBe(false);
    expect(result.guildId).toBe('guild-1');
  });

  it('isDm is true when guildId is null', () => {
    const result = toPlatformMessage(makeMsg({ guildId: null }));
    expect(result.isDm).toBe(true);
    expect(result.guildId).toBeNull();
  });

  it('threadId and threadParentId are null for non-thread channels', () => {
    const result = toPlatformMessage(makeMsg({ isThread: false }));
    expect(result.threadId).toBeNull();
    expect(result.threadParentId).toBeNull();
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
    expect(result.author.displayName).toBe('dave123');
  });
});
