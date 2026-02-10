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
// channelList
// ---------------------------------------------------------------------------

describe('channelList', () => {
  it('channels grouped by category include IDs', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Dev' },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction({ type: 'channelList' }, ctx);

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('#general (id:ch1)');
  });

  it('uncategorized channels include IDs', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'random', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction({ type: 'channelList' }, ctx);

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('#random (id:ch1)');
  });

  it('categories themselves excluded from output', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Dev' },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction({ type: 'channelList' }, ctx);

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    // Category name appears as a grouping label, not as a channel entry
    expect(summary).not.toContain('#Dev');
    expect(summary).not.toContain('(id:cat1)');
  });

  it('empty server returns (no channels)', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction({ type: 'channelList' }, ctx);

    expect(result).toEqual({ ok: true, summary: '(no channels)' });
  });
});

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
      { type: 'channelEdit', channelId: 'nope', name: 'x' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });

  it('fails when no fields provided', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelEdit', channelId: 'ch1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'channelEdit requires at least one of name or topic' });
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

// ---------------------------------------------------------------------------
// threadListArchived
// ---------------------------------------------------------------------------

describe('threadListArchived', () => {
  function makeMockForumGuild(threads: Array<{ id: string; name: string }>) {
    const threadMap = new Map<string, any>();
    for (const t of threads) {
      threadMap.set(t.id, { id: t.id, name: t.name });
    }

    const forumChannel = {
      id: 'forum1',
      name: 'beads',
      type: ChannelType.GuildForum,
      parent: null,
      threads: {
        fetchArchived: vi.fn(async () => ({ threads: threadMap })),
      },
    };

    const cache = new Map<string, any>();
    cache.set('forum1', forumChannel);

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
            get size() { return cache.size; },
          },
          create: vi.fn(async (opts: any) => ({ name: opts.name, id: 'new-id' })),
        },
      } as any,
      forumChannel,
    };
  }

  it('lists archived threads in a forum channel', async () => {
    const { guild } = makeMockForumGuild([
      { id: 't1', name: 'Thread Alpha' },
      { id: 't2', name: 'Thread Beta' },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'threadListArchived', channelId: 'forum1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('Archived threads in #beads (2)');
    expect(summary).toContain('• Thread Alpha (id:t1)');
    expect(summary).toContain('• Thread Beta (id:t2)');
  });

  it('returns message when no archived threads', async () => {
    const { guild } = makeMockForumGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'threadListArchived', channelId: 'forum1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'No archived threads in #beads' });
  });

  it('passes limit to fetchArchived', async () => {
    const { guild, forumChannel } = makeMockForumGuild([]);
    const ctx = makeCtx(guild);

    await executeChannelAction(
      { type: 'threadListArchived', channelId: 'forum1', limit: 10 },
      ctx,
    );

    expect(forumChannel.threads.fetchArchived).toHaveBeenCalledWith({ limit: 10, fetchAll: true });
  });

  it('fails when channel not found', async () => {
    const { guild } = makeMockForumGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'threadListArchived', channelId: 'nope' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });

  it('fails for non-forum/text channel', async () => {
    const guild = makeMockGuild([
      { id: 'voice1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'threadListArchived', channelId: 'voice1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel #voice-chat is not a forum or text channel' });
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
