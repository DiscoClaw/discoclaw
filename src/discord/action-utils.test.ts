import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { resolveChannel, findChannelRaw, describeChannelType } from './action-utils.js';

function makeGuild(channels: any[]) {
  return {
    channels: {
      cache: {
        get: vi.fn((id: string) => channels.find((c) => String(c.id) === String(id))),
        find: vi.fn((pred: (c: any) => boolean) => channels.find((c) => pred(c))),
      },
    },
  } as any;
}

describe('resolveChannel', () => {
  it('does not treat voice channels as sendable targets', () => {
    const voice = { id: '123', name: 'voice', type: ChannelType.GuildVoice };
    const guild = makeGuild([voice]);

    const out = resolveChannel(guild, '123');
    expect(out).toBeUndefined();
    expect(guild.channels.cache.find).not.toHaveBeenCalled();
  });

  it('does not resolve forum channels by name', () => {
    const forum = { id: 'f1', name: 'general', type: ChannelType.GuildForum };
    const text = { id: 't1', name: 'other', type: ChannelType.GuildText, send: vi.fn() };
    const guild = makeGuild([forum, text]);

    const out = resolveChannel(guild, 'general');
    expect(out).toBeUndefined();
  });
});

describe('findChannelRaw', () => {
  it('finds a forum channel by ID', () => {
    const forum = { id: '123', name: 'beads', type: ChannelType.GuildForum };
    const guild = makeGuild([forum]);

    const out = findChannelRaw(guild, '123');
    expect(out).toBe(forum);
  });

  it('finds a forum channel by name', () => {
    const forum = { id: '123', name: 'beads', type: ChannelType.GuildForum };
    const guild = makeGuild([forum]);

    const out = findChannelRaw(guild, 'beads');
    expect(out).toBe(forum);
  });

  it('returns undefined for nonexistent channel', () => {
    const guild = makeGuild([]);
    expect(findChannelRaw(guild, '999')).toBeUndefined();
  });
});

describe('describeChannelType', () => {
  it('returns "forum" for forum channels', () => {
    expect(describeChannelType({ type: ChannelType.GuildForum })).toBe('forum');
  });

  it('returns "voice" for voice channels', () => {
    expect(describeChannelType({ type: ChannelType.GuildVoice })).toBe('voice');
  });

  it('returns "unsupported" for unknown types', () => {
    expect(describeChannelType({ type: 999 })).toBe('unsupported');
  });
});

