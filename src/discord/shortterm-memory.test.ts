import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';

import {
  loadShortTermMemory,
  saveShortTermMemory,
  appendEntry,
  buildExcerptSummary,
  selectEntriesForInjection,
  isChannelPublic,
  formatShortTermSection,
  buildShortTermMemorySection,
} from './shortterm-memory.js';
import type { ShortTermStore, ShortTermEntry } from './shortterm-memory.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'shortterm-memory-test-'));
}

function makeEntry(overrides: Partial<ShortTermEntry> = {}): ShortTermEntry {
  return {
    timestamp: Date.now(),
    sessionKey: 'discord:guild:123:456',
    channelName: 'general',
    summary: 'User asked about APIs | Bot suggested REST',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('loadShortTermMemory', () => {
  it('returns null for missing file', async () => {
    const dir = await makeTmpDir();
    expect(await loadShortTermMemory(dir, 'nonexistent')).toBeNull();
  });

  it('parses valid store', async () => {
    const dir = await makeTmpDir();
    const store: ShortTermStore = { version: 1, entries: [] };
    await fs.writeFile(path.join(dir, 'guild1-user1.json'), JSON.stringify(store), 'utf8');
    expect(await loadShortTermMemory(dir, 'guild1-user1')).toEqual(store);
  });

  it('returns null on malformed JSON', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'bad.json'), '{nope', 'utf8');
    expect(await loadShortTermMemory(dir, 'bad')).toBeNull();
  });

  it('rejects path traversal', async () => {
    const dir = await makeTmpDir();
    await expect(loadShortTermMemory(dir, '../evil')).rejects.toThrow(/Invalid guildUserId/);
  });

  it('returns store unchanged for version-1 store (migration no-op)', async () => {
    const dir = await makeTmpDir();
    const store: ShortTermStore = { version: 1, entries: [] };
    await fs.writeFile(path.join(dir, 'guild1-user1.json'), JSON.stringify(store), 'utf8');
    expect(await loadShortTermMemory(dir, 'guild1-user1')).toEqual(store);
  });

  it('returns null for unsupported version', async () => {
    const dir = await makeTmpDir();
    const store = { version: 99, entries: [] };
    await fs.writeFile(path.join(dir, 'guild1-user1.json'), JSON.stringify(store), 'utf8');
    expect(await loadShortTermMemory(dir, 'guild1-user1')).toBeNull();
  });
});

describe('saveShortTermMemory', () => {
  it('creates file and parent directory', async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, 'sub');
    const store: ShortTermStore = { version: 1, entries: [makeEntry()] };
    await saveShortTermMemory(nested, 'guild1-user1', store);

    const raw = await fs.readFile(path.join(nested, 'guild1-user1.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(store);
  });
});

// ---------------------------------------------------------------------------
// appendEntry
// ---------------------------------------------------------------------------

describe('appendEntry', () => {
  it('appends and prunes expired entries', async () => {
    const dir = await makeTmpDir();
    const guildUserId = 'g1-u1';
    const maxAgeMs = 60_000; // 1 minute

    // Add an old entry.
    const old: ShortTermStore = {
      version: 1,
      entries: [makeEntry({ timestamp: Date.now() - 120_000, channelName: 'old' })],
    };
    await saveShortTermMemory(dir, guildUserId, old);

    // Append a new entry.
    await appendEntry(dir, guildUserId, makeEntry({ channelName: 'new' }), { maxEntries: 20, maxAgeMs });

    const store = await loadShortTermMemory(dir, guildUserId);
    expect(store!.entries).toHaveLength(1);
    expect(store!.entries[0].channelName).toBe('new');
  });

  it('persists channelId when provided', async () => {
    const dir = await makeTmpDir();
    const guildUserId = 'g1-u1';

    await appendEntry(dir, guildUserId, makeEntry({ channelId: 'ch123' }), {
      maxEntries: 20,
      maxAgeMs: 3600_000,
    });

    const store = await loadShortTermMemory(dir, guildUserId);
    expect(store!.entries[0].channelId).toBe('ch123');
  });

  it('enforces maxEntries cap', async () => {
    const dir = await makeTmpDir();
    const guildUserId = 'g1-u1';

    for (let i = 0; i < 5; i++) {
      await appendEntry(dir, guildUserId, makeEntry({ channelName: `ch${i}` }), {
        maxEntries: 3,
        maxAgeMs: 3600_000,
      });
    }

    const store = await loadShortTermMemory(dir, guildUserId);
    expect(store!.entries).toHaveLength(3);
    // Should keep the 3 most recent (ch2, ch3, ch4).
    expect(store!.entries[0].channelName).toBe('ch2');
    expect(store!.entries[2].channelName).toBe('ch4');
  });
});

// ---------------------------------------------------------------------------
// buildExcerptSummary
// ---------------------------------------------------------------------------

describe('buildExcerptSummary', () => {
  it('truncates long messages', () => {
    const long = 'x'.repeat(500);
    const result = buildExcerptSummary(long, long, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('User:');
    expect(result).toContain('Bot:');
  });

  it('handles short messages', () => {
    const result = buildExcerptSummary('hi', 'hello', 200);
    expect(result).toBe('User: hi | Bot: hello');
  });

  it('handles empty strings', () => {
    const result = buildExcerptSummary('', '', 200);
    expect(result).toBe('User:  | Bot: ');
  });
});

// ---------------------------------------------------------------------------
// selectEntriesForInjection
// ---------------------------------------------------------------------------

describe('selectEntriesForInjection', () => {
  it('filters by age and respects maxChars', () => {
    const now = Date.now();
    const store: ShortTermStore = {
      version: 1,
      entries: [
        makeEntry({ timestamp: now - 1000, channelName: 'recent' }),
        makeEntry({ timestamp: now - 7200_000, channelName: 'expired' }), // 2 hrs old
      ],
    };

    const entries = selectEntriesForInjection(store, 10000, 3600_000); // 1hr max age
    expect(entries).toHaveLength(1);
    expect(entries[0].channelName).toBe('recent');
  });

  it('returns empty with maxChars = 0', () => {
    const store: ShortTermStore = {
      version: 1,
      entries: [makeEntry()],
    };
    expect(selectEntriesForInjection(store, 0, 3600_000)).toHaveLength(0);
  });

  it('returns empty for store with no entries', () => {
    const store: ShortTermStore = { version: 1, entries: [] };
    expect(selectEntriesForInjection(store, 10000, 3600_000)).toEqual([]);
  });

  it('sorts by recency (newest first)', () => {
    const now = Date.now();
    const store: ShortTermStore = {
      version: 1,
      entries: [
        makeEntry({ timestamp: now - 5000, channelName: 'older' }),
        makeEntry({ timestamp: now - 1000, channelName: 'newer' }),
      ],
    };
    const entries = selectEntriesForInjection(store, 10000, 3600_000);
    expect(entries[0].channelName).toBe('newer');
    expect(entries[1].channelName).toBe('older');
  });

  it('skips oversized newest entry and includes smaller older entries that fit', () => {
    const now = Date.now();
    const store: ShortTermStore = {
      version: 1,
      entries: [
        makeEntry({
          timestamp: now - 1000,
          channelName: 'newer',
          summary: 'x'.repeat(600),
        }),
        makeEntry({
          timestamp: now - 2000,
          channelName: 'older',
          summary: 'small summary',
        }),
      ],
    };

    const entries = selectEntriesForInjection(store, 120, 3600_000);
    expect(entries).toHaveLength(1);
    expect(entries[0].channelName).toBe('older');
  });
});

// ---------------------------------------------------------------------------
// formatShortTermSection
// ---------------------------------------------------------------------------

describe('formatShortTermSection', () => {
  it('formats entries as bullet list', () => {
    const entries = [
      makeEntry({ timestamp: Date.now() - 900_000, channelName: 'general', summary: 'Talked about APIs' }),
    ];
    const result = formatShortTermSection(entries);
    expect(result).toContain('#general');
    expect(result).toContain('Talked about APIs');
    expect(result).toMatch(/\d+ min ago/);
  });
});

// ---------------------------------------------------------------------------
// isChannelPublic
// ---------------------------------------------------------------------------

describe('isChannelPublic', () => {
  function makeGuild(everyonePerms: bigint) {
    const everyone = {
      id: 'everyone-role-id',
    };
    return {
      roles: { everyone },
    } as any;
  }

  function makeTextChannel(permsForEveryone: bigint, opts?: { isThread?: boolean; parent?: any }) {
    return {
      type: 0, // GuildText
      isThread: () => opts?.isThread ?? false,
      parent: opts?.parent ?? null,
      permissionsFor: (role: any) => new PermissionsBitField(permsForEveryone),
    };
  }

  it('returns true for public channel (@everyone has ViewChannel)', () => {
    const guild = makeGuild(PermissionFlagsBits.ViewChannel);
    const channel = makeTextChannel(PermissionFlagsBits.ViewChannel);
    expect(isChannelPublic(channel, guild)).toBe(true);
  });

  it('returns false for private channel (@everyone lacks ViewChannel)', () => {
    const guild = makeGuild(0n);
    const channel = makeTextChannel(0n);
    expect(isChannelPublic(channel, guild)).toBe(false);
  });

  it('returns false for DMs (no guild)', () => {
    expect(isChannelPublic({}, null as any)).toBe(false);
  });

  it('returns true for thread in public parent', () => {
    const guild = makeGuild(PermissionFlagsBits.ViewChannel);
    const parent = makeTextChannel(PermissionFlagsBits.ViewChannel);
    const thread = {
      type: 11, // PublicThread
      isThread: () => true,
      parent,
      permissionsFor: () => new PermissionsBitField(0n),
    };
    expect(isChannelPublic(thread, guild)).toBe(true);
  });

  it('returns false for thread in private parent', () => {
    const guild = makeGuild(0n);
    const parent = makeTextChannel(0n);
    const thread = {
      type: 11, // PublicThread
      isThread: () => true,
      parent,
    };
    expect(isChannelPublic(thread, guild)).toBe(false);
  });

  it('returns false for thread with no parent', () => {
    const guild = makeGuild(0n);
    const thread = {
      type: 11,
      isThread: () => true,
      parent: null,
    };
    expect(isChannelPublic(thread, guild)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildShortTermMemorySection
// ---------------------------------------------------------------------------

describe('buildShortTermMemorySection', () => {
  it('returns empty when disabled', async () => {
    const result = await buildShortTermMemorySection({
      enabled: false,
      shortTermDataDir: '/tmp',
      guildId: 'g1',
      userId: 'u1',
      maxChars: 1000,
      maxAgeMs: 3600_000,
    });
    expect(result).toBe('');
  });

  it('returns empty when guildId is empty', async () => {
    const result = await buildShortTermMemorySection({
      enabled: true,
      shortTermDataDir: '/tmp',
      guildId: '',
      userId: 'u1',
      maxChars: 1000,
      maxAgeMs: 3600_000,
    });
    expect(result).toBe('');
  });

  it('returns formatted section when data exists', async () => {
    const dir = await makeTmpDir();
    const store: ShortTermStore = {
      version: 1,
      entries: [makeEntry({ timestamp: Date.now() - 60_000, channelName: 'dev' })],
    };
    await saveShortTermMemory(dir, 'g1-u1', store);

    const result = await buildShortTermMemorySection({
      enabled: true,
      shortTermDataDir: dir,
      guildId: 'g1',
      userId: 'u1',
      maxChars: 1000,
      maxAgeMs: 3600_000,
    });
    expect(result).toContain('#dev');
  });

  it('returns empty when no entries within maxAge', async () => {
    const dir = await makeTmpDir();
    const store: ShortTermStore = {
      version: 1,
      entries: [makeEntry({ timestamp: Date.now() - 7200_000 })], // 2 hrs old
    };
    await saveShortTermMemory(dir, 'g1-u1', store);

    const result = await buildShortTermMemorySection({
      enabled: true,
      shortTermDataDir: dir,
      guildId: 'g1',
      userId: 'u1',
      maxChars: 1000,
      maxAgeMs: 3600_000, // 1 hour
    });
    expect(result).toBe('');
  });
});
