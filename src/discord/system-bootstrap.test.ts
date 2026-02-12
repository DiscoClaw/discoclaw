import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureSystemScaffold, ensureForumTags } from './system-bootstrap.js';

function makeMockGuild(channels: Array<{ id: string; name: string; type: ChannelType; parentId?: string | null }>) {
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parentId: ch.parentId ?? null,
      setParent: vi.fn(async function (this: any, pid: string) { this.parentId = pid; }),
      edit: vi.fn(async function (this: any, opts: any) { if ('parent' in opts) this.parentId = opts.parent; }),
    });
  }

  let seq = 0;
  const create = vi.fn(async (opts: any) => {
    const id = `new-${++seq}`;
    const ch: any = {
      id,
      name: opts.name,
      type: opts.type,
      parentId: opts.parent ?? null,
      setParent: vi.fn(async function (this: any, pid: string) { this.parentId = pid; }),
      edit: vi.fn(async function (this: any, o: any) { if ('parent' in o) this.parentId = o.parent; }),
    };
    cache.set(id, ch);
    return ch;
  });

  return {
    id: 'guild-1',
    channels: {
      cache: {
        find: (fn: (ch: any) => boolean) => {
          for (const ch of cache.values()) {
            if (fn(ch)) return ch;
          }
          return undefined;
        },
        values: () => cache.values(),
        get: (id: string) => cache.get(id),
      },
      create,
      fetch: vi.fn(async (id: string) => cache.get(id) ?? null),
    },
    __cache: cache,
    __create: create,
  } as any;
}

describe('ensureSystemScaffold', () => {
  it('creates System category, status text channel, and crons forum', async () => {
    const guild = makeMockGuild([]);
    const res = await ensureSystemScaffold({ guild, ensureBeads: false });
    expect(res).not.toBeNull();
    expect(res?.systemCategoryId).toBeTruthy();
    expect(res?.statusChannelId).toBeTruthy();
    expect(res?.cronsForumId).toBeTruthy();
    expect(res?.beadsForumId).toBeUndefined();

    // 3 creates: category + status + crons
    expect(guild.__create).toHaveBeenCalledTimes(3);
  });

  it('moves existing channels/forums under System', async () => {
    const guild = makeMockGuild([
      { id: 'cat-other', name: 'Other', type: ChannelType.GuildCategory },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-other' },
      { id: 'crons-1', name: 'crons', type: ChannelType.GuildForum, parentId: null },
    ]);

    const res = await ensureSystemScaffold({ guild, ensureBeads: false });
    expect(res?.systemCategoryId).toBeTruthy();
    expect(res?.statusChannelId).toBe('status-1');
    expect(res?.cronsForumId).toBe('crons-1');

    const statusCh = (guild.__cache as Map<string, any>).get('status-1');
    const cronsCh = (guild.__cache as Map<string, any>).get('crons-1');
    expect(statusCh.parentId).toBe(res?.systemCategoryId);
    expect(cronsCh.parentId).toBe(res?.systemCategoryId);
  });

  it('creates beads forum only when ensureBeads is true', async () => {
    const guild = makeMockGuild([]);
    const res = await ensureSystemScaffold({ guild, ensureBeads: true });
    expect(res?.beadsForumId).toBeTruthy();
    // 4 creates: category + status + crons + beads
    expect(guild.__create).toHaveBeenCalledTimes(4);
  });

  it('finds renamed forum by existingId and does NOT create a duplicate', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: '1000000000000000002', name: 'beads-6', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: '1000000000000000001', name: 'crons ・ 1', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const res = await ensureSystemScaffold({
      guild,
      ensureBeads: true,
      existingCronsId: '1000000000000000001',
      existingBeadsId: '1000000000000000002',
    });
    expect(res).not.toBeNull();
    expect(res?.cronsForumId).toBe('1000000000000000001');
    expect(res?.beadsForumId).toBe('1000000000000000002');
    // No new channels should have been created (only category existed already).
    expect(guild.__create).not.toHaveBeenCalled();
  });

  it('returns no ID and does NOT create when existingId has wrong channel type (fail closed)', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      // crons ID points to a text channel, not a forum.
      { id: '1000000000000000001', name: 'crons', type: ChannelType.GuildText, parentId: 'cat-sys' },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await ensureSystemScaffold({
      guild,
      ensureBeads: false,
      existingCronsId: '1000000000000000001',
    }, log as any);
    expect(res).not.toBeNull();
    // cronsForumId should be undefined because the type was wrong.
    expect(res?.cronsForumId).toBeUndefined();
    // Should have logged an error about wrong type.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: '1000000000000000001' }),
      expect.stringContaining('wrong channel type'),
    );
    // Should NOT have created a new crons forum.
    const createCalls = guild.__create.mock.calls;
    const cronCreateCalls = createCalls.filter((c: any) => c[0]?.name === 'crons');
    expect(cronCreateCalls).toHaveLength(0);
  });

  it('returns no ID when existingId is not found anywhere (fail closed, stale ID)', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await ensureSystemScaffold({
      guild,
      ensureBeads: false,
      existingCronsId: '9999999999999999999',
    }, log as any);
    expect(res).not.toBeNull();
    expect(res?.cronsForumId).toBeUndefined();
    // Should have logged error about not found.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: '9999999999999999999' }),
      expect.stringContaining('not found in guild'),
    );
    // Should NOT have created a new crons forum.
    const createCalls = guild.__create.mock.calls;
    const cronCreateCalls = createCalls.filter((c: any) => c[0]?.name === 'crons');
    expect(cronCreateCalls).toHaveLength(0);
  });

  it('finds channel by existingId via API fetch when not in cache', async () => {
    // Guild starts with only System category and status in cache.
    // The crons forum is NOT in cache but fetch() will return it.
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    // Simulate: the channel exists on Discord but isn't in the local cache.
    // Override fetch to return a channel object for the crons ID.
    const cronsChannel = {
      id: '1000000000000000001',
      name: 'crons ・ 3',
      type: ChannelType.GuildForum,
      parentId: null,
      setParent: vi.fn(async function (this: any, pid: string) { this.parentId = pid; }),
      edit: vi.fn(async function (this: any, opts: any) { if ('parent' in opts) this.parentId = opts.parent; }),
    };
    guild.channels.fetch = vi.fn(async (id: string) => {
      if (id === '1000000000000000001') return cronsChannel;
      return null;
    });

    const res = await ensureSystemScaffold({
      guild,
      ensureBeads: false,
      existingCronsId: '1000000000000000001',
    });
    expect(res).not.toBeNull();
    expect(res?.cronsForumId).toBe('1000000000000000001');
    // fetch should have been called with the ID.
    expect(guild.channels.fetch).toHaveBeenCalledWith('1000000000000000001');
    // Should NOT have created a new crons forum.
    expect(guild.__create).not.toHaveBeenCalled();
  });

  it('findByNameAndType: exact match takes precedence over stripped match', async () => {
    // Both "crons" and "crons ・ 1" exist — searching for "crons" should find the exact match.
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: 'crons-exact', name: 'crons', type: ChannelType.GuildForum },
      { id: 'crons-suffixed', name: 'crons ・ 1', type: ChannelType.GuildForum },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const res = await ensureSystemScaffold({ guild, ensureBeads: false });
    expect(res?.cronsForumId).toBe('crons-exact');
  });

  it('findByNameAndType: count-suffixed name matches search for base name', async () => {
    // Only "crons ・ 1" exists (no exact "crons") — should match via stripped suffix.
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: 'crons-suffixed', name: 'crons ・ 1', type: ChannelType.GuildForum },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const res = await ensureSystemScaffold({ guild, ensureBeads: false });
    expect(res?.cronsForumId).toBe('crons-suffixed');
    // Should NOT have created a new crons forum.
    const createCalls = guild.__create.mock.calls;
    const cronCreateCalls = createCalls.filter((c: any) => c[0]?.name === 'crons');
    expect(cronCreateCalls).toHaveLength(0);
  });
});

describe('ensureForumTags', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forum-tags-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 when tag map file does not exist', async () => {
    const guild = makeMockGuild([]);
    const result = await ensureForumTags(guild, 'forum-1', path.join(tmpDir, 'nonexistent.json'));
    expect(result).toBe(0);
  });

  it('returns 0 when forum channel does not exist', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"monitoring": "", "daily": ""}', 'utf8');

    const guild = makeMockGuild([]);
    const result = await ensureForumTags(guild, 'missing-forum', tagMapPath);
    expect(result).toBe(0);
  });

  it('creates missing tags on forum and writes IDs back to file', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"monitoring": "", "daily": ""}', 'utf8');

    // Create a mock forum with editable availableTags.
    let forumTags: any[] = [];
    const forum = {
      id: 'forum-1',
      name: 'crons',
      type: ChannelType.GuildForum,
      availableTags: forumTags,
      edit: vi.fn(async (opts: any) => {
        // Simulate Discord creating tags with IDs.
        forumTags = opts.availableTags.map((t: any, i: number) => ({
          ...t,
          id: t.id ?? `tag-new-${i}`,
          name: t.name,
          moderated: false,
          emoji: null,
        }));
        forum.availableTags = forumTags;
      }),
    };

    const cache = new Map<string, any>([['forum-1', forum]]);
    const guild = {
      id: 'guild-1',
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: () => undefined,
          values: () => cache.values(),
        },
      },
    } as any;

    const result = await ensureForumTags(guild, 'forum-1', tagMapPath);
    expect(result).toBe(2);
    expect(forum.edit).toHaveBeenCalled();

    // Verify the tag map file was updated with new IDs.
    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    expect(updatedMap.monitoring).toBeTruthy();
    expect(updatedMap.daily).toBeTruthy();
  });

  it('backfills existing tag IDs without creating duplicates', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"monitoring": "", "daily": "existing-tag-1"}', 'utf8');

    const forum = {
      id: 'forum-1',
      name: 'crons',
      type: ChannelType.GuildForum,
      availableTags: [
        { id: 'existing-tag-1', name: 'daily', moderated: false, emoji: null },
        { id: 'existing-tag-2', name: 'monitoring', moderated: false, emoji: null },
      ],
      edit: vi.fn(),
    };

    const cache = new Map<string, any>([['forum-1', forum]]);
    const guild = {
      id: 'guild-1',
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: () => undefined,
          values: () => cache.values(),
        },
      },
    } as any;

    const result = await ensureForumTags(guild, 'forum-1', tagMapPath);
    // monitoring already exists on the forum so it should be backfilled, not created.
    expect(result).toBe(0);
    expect(forum.edit).not.toHaveBeenCalled();

    // The tag map should have the backfilled ID for monitoring.
    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    expect(updatedMap.monitoring).toBe('existing-tag-2');
  });
});

