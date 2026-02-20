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
      edit: vi.fn(async function (this: any, opts: any) { if ('parent' in opts) this.parentId = opts.parent; if ('name' in opts) this.name = opts.name; }),
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
      availableTags: [],
      setParent: vi.fn(async function (this: any, pid: string) { this.parentId = pid; }),
      edit: vi.fn(async function (this: any, o: any) {
        if ('parent' in o) this.parentId = o.parent;
        if ('name' in o) this.name = o.name;
        if ('availableTags' in o) {
          this.availableTags = o.availableTags.map((t: any, i: number) => ({
            ...t,
            id: t.id ?? `tag-${this.id}-${i}`,
            name: t.name,
            moderated: t.moderated ?? false,
            emoji: t.emoji ?? null,
          }));
        }
      }),
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

  it('bootstraps bead status tags when beadsTagMapPath is provided', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bead-tags-'));
    try {
      const tagMapPath = path.join(tmpDir, 'tag-map.json');
      await fs.writeFile(tagMapPath, '{"open": "", "in_progress": "", "blocked": "", "closed": ""}', 'utf8');

      const guild = makeMockGuild([]);
      const res = await ensureSystemScaffold({ guild, ensureBeads: true, beadsTagMapPath: tagMapPath });
      expect(res?.beadsForumId).toBeTruthy();

      // The beads forum should have had edit() called with availableTags.
      const beadsForum = (guild.__cache as Map<string, any>).get(res!.beadsForumId!);
      expect(beadsForum).toBeDefined();
      expect(beadsForum.edit).toHaveBeenCalledWith(
        expect.objectContaining({ availableTags: expect.any(Array) }),
      );

      // The tag map file should have been updated with IDs.
      const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
      const updatedMap = JSON.parse(updatedRaw);
      expect(updatedMap.open).toBeTruthy();
      expect(updatedMap.in_progress).toBeTruthy();
      expect(updatedMap.blocked).toBeTruthy();
      expect(updatedMap.closed).toBeTruthy();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips bead tag bootstrap when beadsTagMapPath is not provided', async () => {
    const guild = makeMockGuild([]);
    const res = await ensureSystemScaffold({ guild, ensureBeads: true });
    expect(res?.beadsForumId).toBeTruthy();

    // The beads forum edit should NOT have been called with availableTags
    // (only the create call happens, no subsequent tag bootstrap).
    const beadsForum = (guild.__cache as Map<string, any>).get(res!.beadsForumId!);
    // edit is called 0 times since there's no tag map path to bootstrap from.
    expect(beadsForum.edit).not.toHaveBeenCalled();
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

  it('falls back to name lookup / creation when existingId is stale (not found)', async () => {
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
    // Should have warned about stale ID and fallen through to creation.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: '9999999999999999999' }),
      expect.stringContaining('not found in guild'),
    );
    // Should have created a new crons forum via fallback.
    expect(res?.cronsForumId).toBeDefined();
    const createCalls = guild.__create.mock.calls;
    const cronCreateCalls = createCalls.filter((c: any) => c[0]?.name === 'crons');
    expect(cronCreateCalls).toHaveLength(1);
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

  it('reconciles name drift when channel found by existingId has a stale name', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: '1000000000000000001', name: 'crons ・ 3', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: '1000000000000000002', name: 'beads-6', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await ensureSystemScaffold({
      guild,
      ensureBeads: true,
      existingCronsId: '1000000000000000001',
      existingBeadsId: '1000000000000000002',
    }, log as any);
    expect(res).not.toBeNull();
    expect(res?.cronsForumId).toBe('1000000000000000001');
    expect(res?.beadsForumId).toBe('1000000000000000002');

    // Names should have been reconciled back to canonical.
    const cronsCh = (guild.__cache as Map<string, any>).get('1000000000000000001');
    const beadsCh = (guild.__cache as Map<string, any>).get('1000000000000000002');
    expect(cronsCh.name).toBe('crons');
    expect(beadsCh.name).toBe('tasks');

    // Should have logged name reconciliation.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crons', was: 'crons ・ 3' }),
      expect.stringContaining('reconciled name'),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tasks', was: 'beads-6' }),
      expect.stringContaining('reconciled name'),
    );
  });

  it('reconciles name drift when channel found by name-based lookup (stripped suffix)', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: 'crons-1', name: 'crons ・ 5', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await ensureSystemScaffold({ guild, ensureBeads: false }, log as any);
    expect(res).not.toBeNull();
    expect(res?.cronsForumId).toBe('crons-1');

    // Name should have been reconciled.
    const cronsCh = (guild.__cache as Map<string, any>).get('crons-1');
    expect(cronsCh.name).toBe('crons');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crons', was: 'crons ・ 5' }),
      expect.stringContaining('reconciled name'),
    );
  });

  it('does not reconcile name when it already matches canonical', async () => {
    const guild = makeMockGuild([
      { id: 'cat-sys', name: 'System', type: ChannelType.GuildCategory },
      { id: '1000000000000000001', name: 'crons', type: ChannelType.GuildForum, parentId: 'cat-sys' },
      { id: 'status-1', name: 'status', type: ChannelType.GuildText, parentId: 'cat-sys' },
    ]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await ensureSystemScaffold({
      guild,
      ensureBeads: false,
      existingCronsId: '1000000000000000001',
    }, log as any);

    // edit should not have been called for name reconciliation.
    const cronsCh = (guild.__cache as Map<string, any>).get('1000000000000000001');
    expect(cronsCh.edit).not.toHaveBeenCalledWith(expect.objectContaining({ name: expect.anything() }));
    // Should not have logged name reconciliation.
    const nameReconcileCalls = log.info.mock.calls.filter(
      (c: any) => typeof c[1] === 'string' && c[1].includes('reconciled name'),
    );
    expect(nameReconcileCalls).toHaveLength(0);
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

  it('clears stale IDs that do not exist on the forum', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"open": "stale-id-999", "closed": ""}', 'utf8');

    let forumTags: any[] = [];
    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: forumTags,
      edit: vi.fn(async (opts: any) => {
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

    const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await ensureForumTags(guild, 'forum-1', tagMapPath, { log: logMock as any });
    // Both tags should be created (stale ID was cleared).
    expect(result).toBe(2);

    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    expect(updatedMap.open).toBeTruthy();
    expect(updatedMap.open).not.toBe('stale-id-999');
    expect(updatedMap.closed).toBeTruthy();
  });

  it('clears swapped IDs that map to wrong tag name', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    // "open" has the ID that actually belongs to "closed" on the forum.
    await fs.writeFile(tagMapPath, '{"open": "tag-closed-id", "closed": "tag-open-id"}', 'utf8');

    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: [
        { id: 'tag-open-id', name: 'open', moderated: false, emoji: null },
        { id: 'tag-closed-id', name: 'closed', moderated: false, emoji: null },
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

    const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await ensureForumTags(guild, 'forum-1', tagMapPath, { log: logMock as any });
    // No new tags created — they already exist, IDs just needed backfill after clearing swapped ones.
    expect(result).toBe(0);

    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    // After clearing swapped IDs, they should be backfilled with the correct IDs.
    expect(updatedMap.open).toBe('tag-open-id');
    expect(updatedMap.closed).toBe('tag-closed-id');
  });

  it('preserves valid IDs without clearing them', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"open": "tag-open-id", "closed": "tag-closed-id"}', 'utf8');

    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: [
        { id: 'tag-open-id', name: 'open', moderated: false, emoji: null },
        { id: 'tag-closed-id', name: 'closed', moderated: false, emoji: null },
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
    expect(result).toBe(0);
    expect(forum.edit).not.toHaveBeenCalled();

    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    expect(updatedMap.open).toBe('tag-open-id');
    expect(updatedMap.closed).toBe('tag-closed-id');
  });

  it('prioritizes status tags over content tags when slots are limited', async () => {
    // Forum already has 18 tags — only 2 slots left.
    const existingForumTags = Array.from({ length: 18 }, (_, i) => ({
      id: `existing-${i}`,
      name: `tag-${i}`,
      moderated: false,
      emoji: null,
    }));

    const tagMapPath = path.join(tmpDir, 'tags.json');
    // 4 status tags + 2 content tags = 6, but only 2 slots.
    await fs.writeFile(tagMapPath, JSON.stringify({
      feature: '', bug: '', open: '', in_progress: '', blocked: '', closed: '',
    }), 'utf8');

    let forumTags = [...existingForumTags];
    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: forumTags,
      edit: vi.fn(async (opts: any) => {
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

    // The 2 created tags should be the highest-priority status tags (open, in_progress),
    // not blocked/closed or content tags — verifying deterministic lifecycle-priority ordering.
    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    // open and in_progress should have IDs (created first by lifecycle priority).
    expect(updatedMap.open).toBeTruthy();
    expect(updatedMap.in_progress).toBeTruthy();
    // blocked and closed should NOT have IDs (not enough slots).
    expect(updatedMap.blocked).toBe('');
    expect(updatedMap.closed).toBe('');
    // Content tags should NOT have IDs (not enough slots).
    expect(updatedMap.feature).toBe('');
    expect(updatedMap.bug).toBe('');
  });

  it('merges new keys from seed file via options.seedPath', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"open": "existing-id", "closed": ""}', 'utf8');

    const seedPath = path.join(tmpDir, 'seed.json');
    await fs.writeFile(seedPath, '{"open": "", "closed": "", "feature": "", "bug": ""}', 'utf8');

    let forumTags: any[] = [
      { id: 'existing-id', name: 'open', moderated: false, emoji: null },
    ];
    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: forumTags,
      edit: vi.fn(async (opts: any) => {
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

    const result = await ensureForumTags(guild, 'forum-1', tagMapPath, { seedPath });
    // closed, feature, bug should be created (open already exists with valid ID).
    expect(result).toBe(3);

    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    // open should keep its existing ID.
    expect(updatedMap.open).toBe('existing-id');
    // New keys from seed should have been merged and created.
    expect(updatedMap.feature).toBeTruthy();
    expect(updatedMap.bug).toBeTruthy();
    expect(updatedMap.closed).toBeTruthy();
  });

  it('does not overwrite existing keys when merging from seed', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{"open": "my-id"}', 'utf8');

    const seedPath = path.join(tmpDir, 'seed.json');
    // Seed has open with empty ID — should NOT overwrite the existing "my-id".
    await fs.writeFile(seedPath, '{"open": ""}', 'utf8');

    const forum = {
      id: 'forum-1',
      name: 'beads',
      type: ChannelType.GuildForum,
      availableTags: [
        { id: 'my-id', name: 'open', moderated: false, emoji: null },
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

    const result = await ensureForumTags(guild, 'forum-1', tagMapPath, { seedPath });
    expect(result).toBe(0);

    const updatedRaw = await fs.readFile(tagMapPath, 'utf8');
    const updatedMap = JSON.parse(updatedRaw);
    expect(updatedMap.open).toBe('my-id');
  });

  it('accepts options bag for backward compatibility', async () => {
    const tagMapPath = path.join(tmpDir, 'tags.json');
    await fs.writeFile(tagMapPath, '{}', 'utf8');

    const guild = makeMockGuild([]);
    // Calling with no options (undefined) should still work.
    const result = await ensureForumTags(guild, 'forum-1', tagMapPath);
    expect(result).toBe(0);
  });
});

