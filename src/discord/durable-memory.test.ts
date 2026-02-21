import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadDurableMemory,
  saveDurableMemory,
  deriveItemId,
  addItem,
  deprecateItems,
  selectItemsForInjection,
  formatDurableSection,
} from './durable-memory.js';
import type { DurableMemoryStore, DurableItem } from './durable-memory.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'durable-memory-test-'));
}

function emptyStore(): DurableMemoryStore {
  return { version: 1, updatedAt: 0, items: [] };
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
    const store: DurableMemoryStore = { version: 1, updatedAt: 1000, items: [] };
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
