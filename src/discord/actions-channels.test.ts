import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { executeChannelAction } from './actions-channels.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGuild(channels: Array<{ id: string; name: string; type: ChannelType; parentName?: string; topic?: string; createdAt?: Date }>) {
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parent: ch.parentName ? { name: ch.parentName } : null,
      topic: ch.topic ?? null,
      createdAt: ch.createdAt ?? null,
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    });
  }

  return {
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
        get size() { return cache.size; },
      },
      create: vi.fn(async (opts: any) => ({
        name: opts.name,
        id: 'new-id',
      })),
    },
  } as any;
}

function makeCtx(guild: any): ActionContext {
  return {
    guild,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

// ---------------------------------------------------------------------------
// channelEdit
// ---------------------------------------------------------------------------

describe('channelEdit', () => {
  it('edits channel name and topic', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelEdit', channelId: 'ch1', name: 'renamed', topic: 'New topic' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Edited #general: name → renamed, topic updated' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.edit).toHaveBeenCalledWith({ name: 'renamed', topic: 'New topic' });
  });

  it('edits only the name', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelEdit', channelId: 'ch1', name: 'renamed' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const ch = guild.channels.cache.get('ch1');
    expect(ch.edit).toHaveBeenCalledWith({ name: 'renamed' });
  });

  it('fails when channel not found', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelEdit', channelId: 'nope' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });
});

// ---------------------------------------------------------------------------
// channelDelete
// ---------------------------------------------------------------------------

describe('channelDelete', () => {
  it('deletes a channel', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'to-delete', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelDelete', channelId: 'ch1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Deleted #to-delete' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.delete).toHaveBeenCalled();
  });

  it('fails when channel not found', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelDelete', channelId: 'nope' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });
});

// ---------------------------------------------------------------------------
// channelInfo
// ---------------------------------------------------------------------------

describe('channelInfo', () => {
  it('returns channel details', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Text', topic: 'Main channel' },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelInfo', channelId: 'ch1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('Name: #general');
    expect(summary).toContain('ID: ch1');
    expect(summary).toContain('Category: Text');
    expect(summary).toContain('Topic: Main channel');
  });

  it('fails when channel not found', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelInfo', channelId: 'nope' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });
});

// ---------------------------------------------------------------------------
// categoryCreate
// ---------------------------------------------------------------------------

describe('categoryCreate', () => {
  it('creates a category', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'categoryCreate', name: 'Projects' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Created category "Projects"' });
    expect(guild.channels.create).toHaveBeenCalledWith({
      name: 'Projects',
      type: ChannelType.GuildCategory,
      position: undefined,
    });
  });
});
