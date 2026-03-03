import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadDurableMemory,
  saveDurableMemory,
  deriveItemId,
  addItem,
  compactActiveItems,
  deprecateItems,
  selectItemsForInjection,
  formatDurableSection,
  scoreItem,
  blendedInjectionScore,
  recordHits,
  tokenize,
  keywordRelevance,
  CURRENT_VERSION,
} from './durable-memory.js';
import type { DurableMemoryStore, DurableItem } from './durable-memory.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'durable-memory-test-'));
}

function emptyStore(): DurableMemoryStore {
  return { version: 2, updatedAt: 0, items: [] };
}

function makeItem(overrides: Partial<DurableItem> = {}): DurableItem {
  return {
    id: 'durable-test1234',
    kind: 'fact',
    text: 'test item',
    tags: [],
    status: 'active',
    source: { type: 'manual' },
    createdAt: 1000,
    updatedAt: 1000,
    hitCount: 0,
    lastHitAt: 0,
    ...overrides,
  };
}

describe('loadDurableMemory', () => {
  it('returns null for missing file', async () => {
    const dir = await makeTmpDir();
    const result = await loadDurableMemory(dir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('parses valid store', async () => {
    const dir = await makeTmpDir();
    const store: DurableMemoryStore = { version: 2, updatedAt: 1000, items: [] };
    await fs.writeFile(path.join(dir, '12345.json'), JSON.stringify(store), 'utf8');
    const result = await loadDurableMemory(dir, '12345');
    expect(result).toEqual(store);
  });

  it('returns null on malformed JSON', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json!!!', 'utf8');
    const result = await loadDurableMemory(dir, 'bad');
    expect(result).toBeNull();
  });

  it('rejects path traversal in userId', async () => {
    const dir = await makeTmpDir();
    await expect(loadDurableMemory(dir, '../evil')).rejects.toThrow(/Invalid userId/);
  });

  it('migrates v1 store to v2 with hitCount and lastHitAt backfilled', async () => {
    const dir = await makeTmpDir();
    const v1Store = {
      version: 1,
      updatedAt: 1000,
      items: [
        {
          id: 'durable-abc12345',
          kind: 'fact',
          text: 'test item',
          tags: [],
          status: 'active',
          source: { type: 'manual' },
          createdAt: 500,
          updatedAt: 1000,
        },
      ],
    };
    await fs.writeFile(path.join(dir, 'user1.json'), JSON.stringify(v1Store), 'utf8');
    const result = await loadDurableMemory(dir, 'user1');
    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].hitCount).toBe(0);
    expect(result!.items[0].lastHitAt).toBe(0);
  });

  it('returns empty store for unsupported version', async () => {
    const dir = await makeTmpDir();
    const store = { version: 99, updatedAt: 1000, items: [] };
    await fs.writeFile(path.join(dir, 'user2.json'), JSON.stringify(store), 'utf8');
    const result = await loadDurableMemory(dir, 'user2');
    expect(result).toMatchObject({ version: CURRENT_VERSION, items: [] });
  });

  it('returns null for store missing version field', async () => {
    const dir = await makeTmpDir();
    const store = { updatedAt: 1000, items: [] };
    await fs.writeFile(path.join(dir, 'user3.json'), JSON.stringify(store), 'utf8');
    const result = await loadDurableMemory(dir, 'user3');
    expect(result).toBeNull();
  });
});

describe('saveDurableMemory — path traversal', () => {
  it('rejects path traversal in userId', async () => {
    const dir = await makeTmpDir();
    const store: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    await expect(saveDurableMemory(dir, '../evil', store)).rejects.toThrow(/Invalid userId/);
  });
});

describe('saveDurableMemory', () => {
  it('creates file, overwrites existing', async () => {
    const dir = await makeTmpDir();
    const store1: DurableMemoryStore = { version: 1, updatedAt: 1000, items: [] };
    await saveDurableMemory(dir, '12345', store1);
    const raw1 = await fs.readFile(path.join(dir, '12345.json'), 'utf8');
    expect(JSON.parse(raw1)).toEqual(store1);

    const store2: DurableMemoryStore = { version: 1, updatedAt: 2000, items: [] };
    await saveDurableMemory(dir, '12345', store2);
    const raw2 = await fs.readFile(path.join(dir, '12345.json'), 'utf8');
    expect(JSON.parse(raw2)).toEqual(store2);
  });

  it('creates parent directory', async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, 'a', 'b', 'c');
    const store: DurableMemoryStore = { version: 1, updatedAt: 1, items: [] };
    await saveDurableMemory(nested, 'user', store);
    const raw = await fs.readFile(path.join(nested, 'user.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(store);
  });
});

describe('deriveItemId', () => {
  it('produces consistent IDs for same input', () => {
    const id1 = deriveItemId('fact', 'I prefer TypeScript');
    const id2 = deriveItemId('fact', 'I prefer TypeScript');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^durable-[0-9a-f]{8}$/);
  });

  it('produces different IDs for different input', () => {
    const id1 = deriveItemId('fact', 'I prefer TypeScript');
    const id2 = deriveItemId('fact', 'I prefer JavaScript');
    expect(id1).not.toBe(id2);
  });

  it('normalizes whitespace', () => {
    const id1 = deriveItemId('fact', '  I   prefer   TypeScript  ');
    const id2 = deriveItemId('fact', 'I prefer TypeScript');
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different kinds with same text', () => {
    const factId = deriveItemId('fact', 'uses TypeScript');
    const toolId = deriveItemId('tool', 'uses TypeScript');
    const prefId = deriveItemId('preference', 'uses TypeScript');
    expect(factId).not.toBe(toolId);
    expect(factId).not.toBe(prefId);
    expect(toolId).not.toBe(prefId);
  });
});

describe('addItem', () => {
  it('creates new item with kind=fact', () => {
    const store = emptyStore();
    const result = addItem(store, 'User prefers TypeScript', { type: 'manual' }, 200);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].kind).toBe('fact');
    expect(result.items[0].text).toBe('User prefers TypeScript');
    expect(result.items[0].status).toBe('active');
    expect(result.items[0].id).toMatch(/^durable-/);
  });

  it('preserves explicit kind parameter', () => {
    const store = emptyStore();
    addItem(store, 'Uses VS Code', { type: 'summary' }, 200, 'tool');
    expect(store.items).toHaveLength(1);
    expect(store.items[0].kind).toBe('tool');
    expect(store.items[0].source.type).toBe('summary');
  });

  it('updates existing item with same derived ID (dedup)', () => {
    const store = emptyStore();
    addItem(store, 'User prefers TypeScript', { type: 'manual' }, 200);
    expect(store.items).toHaveLength(1);
    const originalCreatedAt = store.items[0].createdAt;

    addItem(store, 'User prefers TypeScript', { type: 'discord', channelId: 'ch1' }, 200);
    expect(store.items).toHaveLength(1);
    expect(store.items[0].source.type).toBe('discord');
    expect(store.items[0].createdAt).toBe(originalCreatedAt);
  });

  it('enforces maxItems cap (drops oldest deprecated first)', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'old-dep', status: 'deprecated', updatedAt: 100 }),
      makeItem({ id: 'old-active', status: 'active', text: 'old active', updatedAt: 200 }),
    );
    // maxItems=2, adding a third should drop the deprecated item
    addItem(store, 'new item', { type: 'manual' }, 2);
    expect(store.items).toHaveLength(2);
    expect(store.items.find((it) => it.id === 'old-dep')).toBeUndefined();
    expect(store.items.find((it) => it.id === 'old-active')).toBeDefined();
  });

  it('drops oldest active when no deprecated items remain', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'active1', status: 'active', text: 'first', updatedAt: 100 }),
      makeItem({ id: 'active2', status: 'active', text: 'second', updatedAt: 200 }),
    );
    addItem(store, 'third item', { type: 'manual' }, 2);
    expect(store.items).toHaveLength(2);
    expect(store.items.find((it) => it.id === 'active1')).toBeUndefined();
  });
});

describe('compactActiveItems', () => {
  it('demotes overflow active items when item threshold is exceeded', () => {
    const store = emptyStore();
    const now = Date.now();
    for (let i = 0; i < 26; i++) {
      store.items.push(
        makeItem({
          id: `item-${String(i).padStart(2, '0')}`,
          text: `active item ${i}`,
          status: 'active',
          createdAt: now - i * 1000,
          updatedAt: now - i * 1000,
          hitCount: 0,
          lastHitAt: 0,
        }),
      );
    }

    const summary = compactActiveItems(store, { maxActiveItems: 25, maxActiveChars: 100_000 });

    expect(summary.demotedCount).toBe(1);
    expect(summary.demotedByItemLimit).toBe(1);
    expect(summary.demotedByCharLimit).toBe(0);
    expect(summary.activeCount).toBe(25);
    expect(store.items.filter((it) => it.status === 'active')).toHaveLength(25);
    expect(store.items.filter((it) => it.status === 'deprecated')).toHaveLength(1);
  });

  it('demotes overflow active items when char threshold is exceeded', () => {
    const now = Date.now();
    const keep = makeItem({
      id: 'keep',
      text: 'Keep this concise durable memory item',
      status: 'active',
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
      hitCount: 5,
      lastHitAt: now - 500,
    });
    const demote = makeItem({
      id: 'demote',
      text: 'Demote this never-hit durable memory item because the char budget is too tight',
      status: 'active',
      createdAt: now - 2_000,
      updatedAt: now - 2_000,
      hitCount: 0,
      lastHitAt: 0,
    });

    const store = emptyStore();
    store.items.push(keep, demote);
    const keepChars = formatDurableSection([keep]).length;

    const summary = compactActiveItems(store, {
      maxActiveItems: 10,
      maxActiveChars: keepChars,
    });

    expect(summary.demotedCount).toBe(1);
    expect(summary.demotedByItemLimit).toBe(0);
    expect(summary.demotedByCharLimit).toBe(1);
    expect(summary.activeChars).toBeLessThanOrEqual(keepChars);
    expect(store.items.find((it) => it.id === 'keep')?.status).toBe('active');
    expect(store.items.find((it) => it.id === 'demote')?.status).toBe('deprecated');
  });

  it('deterministically demotes never-hit items first', () => {
    const now = Date.now();
    function buildCandidates(): { neverA: DurableItem; neverB: DurableItem; hit: DurableItem } {
      return {
        neverA: makeItem({
          id: 'never-a',
          text: 'never a',
          status: 'active',
          createdAt: now - 1_000,
          updatedAt: now - 1_000,
          hitCount: 0,
          lastHitAt: 0,
        }),
        neverB: makeItem({
          id: 'never-b',
          text: 'never b',
          status: 'active',
          createdAt: now - 1_000,
          updatedAt: now - 1_000,
          hitCount: 0,
          lastHitAt: 0,
        }),
        hit: makeItem({
          id: 'hit',
          text: 'high value',
          status: 'active',
          createdAt: now - 1_000,
          updatedAt: now - 1_000,
          hitCount: 8,
          lastHitAt: now - 500,
        }),
      };
    }

    const first = buildCandidates();
    const storeA = emptyStore();
    storeA.items.push(first.neverB, first.neverA, first.hit);
    compactActiveItems(storeA, { maxActiveItems: 2, maxActiveChars: 10_000 });
    const demotedA = storeA.items.filter((it) => it.status === 'deprecated').map((it) => it.id);

    const second = buildCandidates();
    const storeB = emptyStore();
    storeB.items.push(second.neverA, second.neverB, second.hit);
    compactActiveItems(storeB, { maxActiveItems: 2, maxActiveChars: 10_000 });
    const demotedB = storeB.items.filter((it) => it.status === 'deprecated').map((it) => it.id);

    expect(demotedA).toEqual(['never-a']);
    expect(demotedB).toEqual(['never-a']);
    expect(storeA.items.find((it) => it.id === 'hit')?.status).toBe('active');
    expect(storeB.items.find((it) => it.id === 'hit')?.status).toBe('active');
  });

  it('does nothing when active set is exactly at item and char thresholds', () => {
    const first = makeItem({ id: 'a', text: 'alpha item', status: 'active', updatedAt: 1000 });
    const second = makeItem({ id: 'b', text: 'beta item', status: 'active', updatedAt: 2000 });
    const store = emptyStore();
    store.updatedAt = 777;
    store.items.push(first, second);
    const exactChars = formatDurableSection([first, second]).length;
    const beforeUpdatedAts = store.items.map((it) => it.updatedAt);

    const summary = compactActiveItems(store, {
      maxActiveItems: 2,
      maxActiveChars: exactChars,
    });

    expect(summary.demotedCount).toBe(0);
    expect(summary.demotedByItemLimit).toBe(0);
    expect(summary.demotedByCharLimit).toBe(0);
    expect(summary.activeCount).toBe(2);
    expect(summary.activeChars).toBe(exactChars);
    expect(store.updatedAt).toBe(777);
    expect(store.items.map((it) => it.status)).toEqual(['active', 'active']);
    expect(store.items.map((it) => it.updatedAt)).toEqual(beforeUpdatedAts);
  });
});

describe('deprecateItems', () => {
  it('matches by 60% text-length threshold', () => {
    const store = emptyStore();
    // text = "TypeScript" (10 chars), substring = "TypeScrip" (9 chars) -> 90% >= 60%
    store.items.push(makeItem({ text: 'TypeScript', status: 'active' }));
    const { deprecatedCount } = deprecateItems(store, 'TypeScrip');
    expect(deprecatedCount).toBe(1);
    expect(store.items[0].status).toBe('deprecated');
  });

  it('does not match when substring is too short', () => {
    const store = emptyStore();
    // text = "TypeScript" (10 chars), substring = "Type" (4 chars) -> 40% < 60%
    store.items.push(makeItem({ text: 'TypeScript', status: 'active' }));
    const { deprecatedCount } = deprecateItems(store, 'Type');
    expect(deprecatedCount).toBe(0);
    expect(store.items[0].status).toBe('active');
  });

  it('ignores already-deprecated items', () => {
    const store = emptyStore();
    store.items.push(makeItem({ text: 'TypeScript', status: 'deprecated' }));
    const { deprecatedCount } = deprecateItems(store, 'TypeScript');
    expect(deprecatedCount).toBe(0);
  });

  it('is case-insensitive', () => {
    const store = emptyStore();
    store.items.push(makeItem({ text: 'TypeScript', status: 'active' }));
    const { deprecatedCount } = deprecateItems(store, 'typescript');
    expect(deprecatedCount).toBe(1);
  });

  it('returns 0 when no match', () => {
    const store = emptyStore();
    store.items.push(makeItem({ text: 'TypeScript', status: 'active' }));
    const { deprecatedCount } = deprecateItems(store, 'completely unrelated');
    expect(deprecatedCount).toBe(0);
  });
});

describe('selectItemsForInjection', () => {
  it('returns active items only, sorted by recency', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'a', text: 'old', status: 'active', updatedAt: 100 }),
      makeItem({ id: 'b', text: 'deprecated', status: 'deprecated', updatedAt: 300 }),
      makeItem({ id: 'c', text: 'new', status: 'active', updatedAt: 200 }),
    );
    const items = selectItemsForInjection(store, 10000);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('c'); // newer first
    expect(items[1].id).toBe('a');
  });

  it('respects char budget', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'a', text: 'first item text', status: 'active', updatedAt: 200 }),
      makeItem({ id: 'b', text: 'second item text', status: 'active', updatedAt: 100 }),
    );
    // Budget just enough for one item line
    const items = selectItemsForInjection(store, 80);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('a');
  });

  it('returns empty with maxChars = 0', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'a', text: 'some item', status: 'active', updatedAt: 200 }),
    );
    const items = selectItemsForInjection(store, 0);
    expect(items).toHaveLength(0);
  });

  it('skips oversized newest item and still includes smaller older items that fit', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'new-big', text: 'x'.repeat(600), status: 'active', updatedAt: 300 }),
      makeItem({ id: 'older-small', text: 'small item', status: 'active', updatedAt: 200 }),
    );

    const items = selectItemsForInjection(store, 120);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('older-small');
  });
});

describe('formatDurableSection', () => {
  it('formats items correctly', () => {
    const items: DurableItem[] = [
      makeItem({
        kind: 'fact',
        text: 'User prefers TypeScript over JavaScript.',
        source: { type: 'manual' },
        updatedAt: new Date('2026-02-09').getTime(),
      }),
      makeItem({
        kind: 'project',
        text: 'Current project: discoclaw memory system.',
        source: { type: 'discord' },
        updatedAt: new Date('2026-02-09').getTime(),
      }),
    ];
    const result = formatDurableSection(items);
    expect(result).toContain('- [fact] User prefers TypeScript over JavaScript. (src: manual, updated 2026-02-09)');
    expect(result).toContain('- [project] Current project: discoclaw memory system. (src: discord, updated 2026-02-09)');
  });

  it('includes channel name when present in source', () => {
    const items: DurableItem[] = [
      makeItem({
        kind: 'fact',
        text: 'Prefers Rust',
        source: { type: 'manual', channelName: 'dev' },
        updatedAt: new Date('2026-01-15').getTime(),
      }),
    ];
    const result = formatDurableSection(items);
    expect(result).toContain('#dev');
    expect(result).toMatch(/src: manual, #dev, updated/);
  });

  it('omits channel name when absent from source', () => {
    const items: DurableItem[] = [
      makeItem({
        kind: 'fact',
        text: 'Prefers Rust',
        source: { type: 'manual' },
        updatedAt: new Date('2026-01-15').getTime(),
      }),
    ];
    const result = formatDurableSection(items);
    expect(result).not.toContain('#');
    expect(result).toMatch(/src: manual, updated/);
  });
});

describe('scoreItem', () => {
  it('returns 0 when hitCount is 0', () => {
    const item = makeItem({ hitCount: 0, lastHitAt: 1000 });
    expect(scoreItem(item, Date.now())).toBe(0);
  });

  it('scores higher with recent lastHitAt than distant lastHitAt', () => {
    const now = Date.now();
    const recent = makeItem({ hitCount: 5, lastHitAt: now - 1000 });
    const distant = makeItem({ hitCount: 5, lastHitAt: now - 90 * 24 * 60 * 60 * 1000 });
    expect(scoreItem(recent, now)).toBeGreaterThan(scoreItem(distant, now));
  });

  it('scores higher with more hits', () => {
    const now = Date.now();
    const manyHits = makeItem({ hitCount: 10, lastHitAt: now - 1000 });
    const fewHits = makeItem({ hitCount: 2, lastHitAt: now - 1000 });
    expect(scoreItem(manyHits, now)).toBeGreaterThan(scoreItem(fewHits, now));
  });
});

describe('blendedInjectionScore', () => {
  it('recently-updated + frequently-hit item scores above old + never-hit item', () => {
    const now = Date.now();
    const hotItem = makeItem({
      updatedAt: now - 1000,
      hitCount: 10,
      lastHitAt: now - 1000,
    });
    const coldItem = makeItem({
      updatedAt: now - 60 * 24 * 60 * 60 * 1000,
      hitCount: 0,
      lastHitAt: 0,
    });
    expect(blendedInjectionScore(hotItem, now)).toBeGreaterThan(
      blendedInjectionScore(coldItem, now),
    );
  });
});

describe('addItem — eviction with hit tracking', () => {
  it('evicts never-hit item before frequently-hit item of same age', () => {
    const store = emptyStore();
    const now = Date.now();
    store.items.push(
      makeItem({ id: 'never-hit', status: 'active', text: 'never hit', updatedAt: now - 1000, hitCount: 0, lastHitAt: 0 }),
      makeItem({ id: 'freq-hit', status: 'active', text: 'frequently hit', updatedAt: now - 1000, hitCount: 10, lastHitAt: now - 500 }),
    );
    addItem(store, 'new item', { type: 'manual' }, 2);
    expect(store.items).toHaveLength(2);
    expect(store.items.find((it) => it.id === 'never-hit')).toBeUndefined();
    expect(store.items.find((it) => it.id === 'freq-hit')).toBeDefined();
  });

  it('evicts deprecated never-hit item before active never-hit item', () => {
    const store = emptyStore();
    const now = Date.now();
    store.items.push(
      makeItem({ id: 'dep-no-hit', status: 'deprecated', text: 'deprecated no hit', updatedAt: now - 1000, hitCount: 0, lastHitAt: 0 }),
      makeItem({ id: 'active-no-hit', status: 'active', text: 'active no hit', updatedAt: now - 1000, hitCount: 0, lastHitAt: 0 }),
    );
    addItem(store, 'new item', { type: 'manual' }, 2);
    expect(store.items).toHaveLength(2);
    expect(store.items.find((it) => it.id === 'dep-no-hit')).toBeUndefined();
    expect(store.items.find((it) => it.id === 'active-no-hit')).toBeDefined();
  });
});

describe('selectItemsForInjection — blended scoring', () => {
  it('orders by blended score, not just updatedAt', () => {
    const now = Date.now();
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'old-hot', text: 'old but popular', status: 'active', updatedAt: now - 30 * 24 * 60 * 60 * 1000, hitCount: 20, lastHitAt: now - 1000 }),
      makeItem({ id: 'new-cold', text: 'new but ignored', status: 'active', updatedAt: now - 1000, hitCount: 0, lastHitAt: 0 }),
    );
    const items = selectItemsForInjection(store, 10000);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('old-hot');
    expect(items[1].id).toBe('new-cold');
  });
});

describe('recordHits', () => {
  it('bumps hitCount and lastHitAt on matching IDs, leaves others untouched', () => {
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'hit-me', hitCount: 3, lastHitAt: 500 }),
      makeItem({ id: 'leave-me', hitCount: 1, lastHitAt: 400 }),
    );
    const before = store.items[1].hitCount;
    const beforeLastHit = store.items[1].lastHitAt;

    recordHits(store, ['hit-me']);

    expect(store.items[0].hitCount).toBe(4);
    expect(store.items[0].lastHitAt).toBeGreaterThan(500);
    expect(store.items[1].hitCount).toBe(before);
    expect(store.items[1].lastHitAt).toBe(beforeLastHit);
  });
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric boundaries', () => {
    const tokens = tokenize('Hello World! TypeScript is great.');
    expect(tokens.has('hello')).toBe(true);
    expect(tokens.has('world')).toBe(true);
    expect(tokens.has('typescript')).toBe(true);
    expect(tokens.has('great')).toBe(true);
  });

  it('filters out stop words', () => {
    const tokens = tokenize('the quick brown fox is not a dog');
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('not')).toBe(false);
    expect(tokens.has('quick')).toBe(true);
    expect(tokens.has('brown')).toBe(true);
    expect(tokens.has('fox')).toBe(true);
    expect(tokens.has('dog')).toBe(true);
  });

  it('filters out tokens shorter than 3 characters', () => {
    const tokens = tokenize('I am ok go run typescript');
    expect(tokens.has('ok')).toBe(false);
    expect(tokens.has('go')).toBe(false);
    expect(tokens.has('am')).toBe(false);
    expect(tokens.has('run')).toBe(true);
    expect(tokens.has('typescript')).toBe(true);
  });

  it('returns empty set for empty input', () => {
    expect(tokenize('').size).toBe(0);
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('rust rust rust');
    expect(tokens.size).toBe(1);
    expect(tokens.has('rust')).toBe(true);
  });
});

describe('keywordRelevance', () => {
  it('returns 1.0 for perfect overlap', () => {
    const queryTokens = tokenize('typescript projects');
    const score = keywordRelevance(queryTokens, 'User loves TypeScript projects', []);
    expect(score).toBe(1.0);
  });

  it('returns 0 for no overlap', () => {
    const queryTokens = tokenize('python machine learning');
    const score = keywordRelevance(queryTokens, 'User prefers Rust for systems', []);
    expect(score).toBe(0);
  });

  it('returns partial score for partial overlap', () => {
    const queryTokens = tokenize('typescript react projects');
    const score = keywordRelevance(queryTokens, 'User likes TypeScript and Vue', []);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    // 1 out of 3 non-stop tokens match: typescript
    expect(score).toBeCloseTo(1 / 3);
  });

  it('returns 0 when query has no meaningful tokens', () => {
    const queryTokens = tokenize('is a the');
    const score = keywordRelevance(queryTokens, 'some text here', []);
    expect(score).toBe(0);
  });

  it('includes tags in matching', () => {
    const queryTokens = tokenize('kubernetes deployment');
    const score = keywordRelevance(queryTokens, 'Uses containers for services', ['kubernetes', 'deployment']);
    expect(score).toBe(1.0);
  });
});

describe('selectItemsForInjection — query-aware boosting', () => {
  it('boosts items with keyword overlap above non-matching items', () => {
    const now = Date.now();
    const store = emptyStore();
    store.items.push(
      makeItem({
        id: 'irrelevant',
        text: 'User prefers dark mode in all editors',
        status: 'active',
        updatedAt: now - 1000,
        hitCount: 10,
        lastHitAt: now - 1000,
      }),
      makeItem({
        id: 'relevant',
        text: 'User uses TypeScript for all projects',
        status: 'active',
        updatedAt: now - 30 * 24 * 60 * 60 * 1000,
        hitCount: 1,
        lastHitAt: now - 30 * 24 * 60 * 60 * 1000,
      }),
    );
    // Without query, 'irrelevant' (higher blended score) would rank first
    const withoutQuery = selectItemsForInjection(store, 10000);
    expect(withoutQuery[0].id).toBe('irrelevant');

    // With query about TypeScript, 'relevant' should be boosted above 'irrelevant'
    const withQuery = selectItemsForInjection(store, 10000, 'Tell me about TypeScript');
    expect(withQuery[0].id).toBe('relevant');
    expect(withQuery[1].id).toBe('irrelevant');
  });

  it('falls back to blended score when query has no meaningful tokens', () => {
    const now = Date.now();
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'a', text: 'first item', status: 'active', updatedAt: now - 1000, hitCount: 5, lastHitAt: now - 500 }),
      makeItem({ id: 'b', text: 'second item', status: 'active', updatedAt: now - 60 * 24 * 60 * 60 * 1000, hitCount: 0, lastHitAt: 0 }),
    );
    const items = selectItemsForInjection(store, 10000, 'is the a');
    expect(items[0].id).toBe('a');
  });

  it('preserves existing behavior when query is undefined', () => {
    const now = Date.now();
    const store = emptyStore();
    store.items.push(
      makeItem({ id: 'old-hot', text: 'old but popular', status: 'active', updatedAt: now - 30 * 24 * 60 * 60 * 1000, hitCount: 20, lastHitAt: now - 1000 }),
      makeItem({ id: 'new-cold', text: 'new but ignored', status: 'active', updatedAt: now - 1000, hitCount: 0, lastHitAt: 0 }),
    );
    const items = selectItemsForInjection(store, 10000);
    expect(items[0].id).toBe('old-hot');
  });

  it('boosts items matching via tags', () => {
    const now = Date.now();
    const store = emptyStore();
    store.items.push(
      makeItem({
        id: 'no-tag-match',
        text: 'User enjoys hiking on weekends',
        status: 'active',
        updatedAt: now - 1000,
        hitCount: 5,
        lastHitAt: now - 1000,
      }),
      makeItem({
        id: 'tag-match',
        text: 'Deploys services regularly',
        tags: ['kubernetes', 'docker'],
        status: 'active',
        updatedAt: now - 60 * 24 * 60 * 60 * 1000,
        hitCount: 0,
        lastHitAt: 0,
      }),
    );
    // Query has 2 tokens matching tags (kubernetes, docker) out of 3 total
    const items = selectItemsForInjection(store, 10000, 'kubernetes docker containers');
    expect(items[0].id).toBe('tag-match');
  });

  it('still respects char budget with query', () => {
    const store = emptyStore();
    const now = Date.now();
    store.items.push(
      makeItem({ id: 'a', text: 'TypeScript project config', status: 'active', updatedAt: now - 1000 }),
      makeItem({ id: 'b', text: 'TypeScript compiler options reference', status: 'active', updatedAt: now - 2000 }),
    );
    const items = selectItemsForInjection(store, 80, 'TypeScript');
    expect(items).toHaveLength(1);
  });
});
