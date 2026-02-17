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
      setParent: vi.fn(async () => {}),
      setPosition: vi.fn(async () => {}),
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
// channelCreate types
// ---------------------------------------------------------------------------

describe('channelCreate', () => {
  it('creates a text channel by default', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: ChannelType.GuildText }),
    );
  });

  it('creates a voice channel', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'voice-chat', channelType: 'voice' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: ChannelType.GuildVoice }),
    );
  });

  it('creates an announcement channel', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'news', channelType: 'announcement' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: ChannelType.GuildAnnouncement }),
    );
  });

  it('creates a stage channel', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'stage-talk', channelType: 'stage' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: ChannelType.GuildStageVoice }),
    );
  });

  it('creates under a parent category', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'dev-chat', parent: 'Dev' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('under Dev');
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: 'cat1' }),
    );
  });

  it('fails when parent category not found', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelCreate', name: 'test', parent: 'NonExistent' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Category "NonExistent" not found' });
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
// channelMove
// ---------------------------------------------------------------------------

describe('channelMove', () => {
  it('moves channel to a category by name', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Projects', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: 'Projects' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Moved #general: moved to Projects' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setParent).toHaveBeenCalledWith('cat1');
  });

  it('moves channel to a category by ID', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Projects', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: 'cat1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setParent).toHaveBeenCalledWith('cat1');
  });

  it('removes channel from category with empty string', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Old' },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: '' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Moved #general: removed from category' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setParent).toHaveBeenCalledWith(null);
  });

  it('sets channel position', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', position: 3 },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Moved #general: position → 3' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setPosition).toHaveBeenCalledWith(3);
  });

  it('moves and repositions in one call', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: 'Dev', position: 0 },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Moved #general: moved to Dev, position → 0' });
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setParent).toHaveBeenCalledWith('cat1');
    expect(ch.setPosition).toHaveBeenCalledWith(0);
  });

  it('fails when neither parent nor position given', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'channelMove requires at least one of parent or position' });
  });

  it('fails when channel not found', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'nope', parent: 'Dev' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Channel "nope" not found' });
  });

  it('fails when category not found', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: 'NonExistent' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Category "NonExistent" not found' });
  });

  it('resolves category name case-insensitively', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Projects', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'channelMove', channelId: 'ch1', parent: 'projects' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const ch = guild.channels.cache.get('ch1');
    expect(ch.setParent).toHaveBeenCalledWith('cat1');
  });
});

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

// ---------------------------------------------------------------------------
// threadEdit
// ---------------------------------------------------------------------------

describe('threadEdit', () => {
  function makeThreadCtx(opts: {
    threadId: string;
    threadName: string;
    guildId: string;
    parentType: ChannelType;
    appliedTags?: string[];
    inCache?: boolean;
  }) {
    const thread = {
      id: opts.threadId,
      name: opts.threadName,
      guildId: opts.guildId,
      isThread: () => true,
      parent: { type: opts.parentType },
      appliedTags: opts.appliedTags ?? [],
      edit: vi.fn(async () => {}),
    };

    const channelsCache = new Map<string, any>();

    const client = {
      channels: {
        cache: {
          get: (id: string) => (opts.inCache !== false && id === opts.threadId ? thread : undefined),
        },
        fetch: vi.fn(async (id: string) => {
          if (id === opts.threadId) return thread;
          throw new Error('Unknown channel');
        }),
      },
    } as any;

    const guild = makeMockGuild([]);
    (guild as any).id = opts.guildId;

    return {
      thread,
      ctx: { ...makeCtx(guild), client } as any,
    };
  }

  it('edits appliedTags on a forum thread (cache hit)', async () => {
    const { thread, ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'My Thread', guildId: 'g1',
      parentType: ChannelType.GuildForum, inCache: true,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['tag1', 'tag2'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('appliedTags → [tag1, tag2]');
    expect(thread.edit).toHaveBeenCalledWith({ appliedTags: ['tag1', 'tag2'] });
  });

  it('edits thread name only', async () => {
    const { thread, ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'Old Name', guildId: 'g1',
      parentType: ChannelType.GuildForum, inCache: true,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', name: 'New Name' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('name → New Name');
    expect(thread.edit).toHaveBeenCalledWith({ name: 'New Name' });
  });

  it('edits both appliedTags and name', async () => {
    const { thread, ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'Old Name', guildId: 'g1',
      parentType: ChannelType.GuildForum, inCache: true,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['tag1'], name: 'New Name' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(thread.edit).toHaveBeenCalledWith({ appliedTags: ['tag1'], name: 'New Name' });
  });

  it('fetches thread from API when not in cache', async () => {
    const { thread, ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'My Thread', guildId: 'g1',
      parentType: ChannelType.GuildForum, inCache: false,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['tag1'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ctx.client.channels.fetch).toHaveBeenCalledWith('t1');
    expect(thread.edit).toHaveBeenCalled();
  });

  it('fails when thread not found', async () => {
    const guild = makeMockGuild([]);
    (guild as any).id = 'g1';
    const client = {
      channels: {
        cache: { get: () => undefined },
        fetch: vi.fn(async () => { throw new Error('Unknown'); }),
      },
    } as any;
    const ctx = { ...makeCtx(guild), client } as any;

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 'missing', appliedTags: ['tag1'] },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Thread "missing" not found' });
  });

  it('fails when thread belongs to a different guild', async () => {
    const { ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'My Thread', guildId: 'other-guild',
      parentType: ChannelType.GuildForum, inCache: true,
    });
    // ctx.guild.id is set by makeCtx which uses makeMockGuild — override it
    (ctx.guild as any).id = 'this-guild';

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['tag1'] },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Thread "t1" does not belong to this guild' });
  });

  it('rejects appliedTags when parent is not a forum channel', async () => {
    const { ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'My Thread', guildId: 'g1',
      parentType: ChannelType.GuildText, inCache: true,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['tag1'] },
      ctx,
    );

    expect(result).toEqual({
      ok: false,
      error: 'Thread "t1" is not in a forum channel — appliedTags only applies to forum threads',
    });
  });

  it('rejects appliedTags exceeding 5', async () => {
    const { ctx } = makeThreadCtx({
      threadId: 't1', threadName: 'My Thread', guildId: 'g1',
      parentType: ChannelType.GuildForum, inCache: true,
    });

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1', appliedTags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'appliedTags exceeds Discord maximum of 5 (got 6)' });
  });

  it('fails when neither appliedTags nor name provided', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);

    const result = await executeChannelAction(
      { type: 'threadEdit', threadId: 't1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'threadEdit requires at least one of appliedTags or name' });
  });
});
