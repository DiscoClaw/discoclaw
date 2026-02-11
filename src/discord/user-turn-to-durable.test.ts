import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseExtractionResult, applyUserTurnToDurable } from './user-turn-to-durable.js';
import { loadDurableMemory, addItem, saveDurableMemory } from './durable-memory.js';
import type { DurableMemoryStore } from './durable-memory.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'user-turn-durable-test-'));
}

function makeRuntime(responseText: string) {
  return {
    invoke: async function* () {
      yield { type: 'text_final' as const, text: responseText };
    },
  } as any;
}

describe('parseExtractionResult', () => {
  it('parses valid JSON array', () => {
    const raw = '[{"kind":"fact","text":"Likes TypeScript"},{"kind":"preference","text":"Prefers dark mode"}]';
    const items = parseExtractionResult(raw);
    expect(items).toEqual([
      { kind: 'fact', text: 'Likes TypeScript' },
      { kind: 'preference', text: 'Prefers dark mode' },
    ]);
  });

  it('returns empty on malformed JSON', () => {
    expect(parseExtractionResult('not json at all')).toEqual([]);
    expect(parseExtractionResult('{}')).toEqual([]);
  });

  it('filters out invalid kinds', () => {
    const raw = '[{"kind":"invalid","text":"should be dropped"},{"kind":"fact","text":"kept"}]';
    const items = parseExtractionResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'kept' }]);
  });

  it('filters out items with empty text', () => {
    const raw = '[{"kind":"fact","text":""},{"kind":"fact","text":"  "},{"kind":"fact","text":"real"}]';
    const items = parseExtractionResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'real' }]);
  });

  it('enforces cap of 3 items even if model returns more', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ kind: 'fact', text: `Item ${i}` }));
    const raw = JSON.stringify(many);
    const items = parseExtractionResult(raw);
    expect(items).toHaveLength(3);
  });

  it('handles JSON inside markdown fences', () => {
    const raw = '```json\n[{"kind":"fact","text":"Extracted"}]\n```';
    const items = parseExtractionResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'Extracted' }]);
  });

  it('returns empty array response', () => {
    expect(parseExtractionResult('[]')).toEqual([]);
  });
});

describe('applyUserTurnToDurable', () => {
  it('writes extracted items to durable store', async () => {
    const dir = await makeTmpDir();
    const runtime = makeRuntime('[{"kind":"fact","text":"Likes cats"}]');

    await applyUserTurnToDurable({
      runtime,
      userMessageText: 'I love cats',
      userId: '42',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    const store = await loadDurableMemory(dir, '42');
    expect(store).not.toBeNull();
    expect(store!.items).toHaveLength(1);
    expect(store!.items[0].text).toBe('Likes cats');
    expect(store!.items[0].kind).toBe('fact');
    expect(store!.items[0].source.type).toBe('summary');
  });

  it('does not duplicate existing items', async () => {
    const dir = await makeTmpDir();

    // Pre-seed a store with an existing item.
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Likes cats', { type: 'summary' }, 200, 'fact');
    await saveDurableMemory(dir, '42', existing);

    const runtime = makeRuntime('[{"kind":"fact","text":"Likes cats"}]');
    await applyUserTurnToDurable({
      runtime,
      userMessageText: 'I love cats',
      userId: '42',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    const store = await loadDurableMemory(dir, '42');
    expect(store!.items).toHaveLength(1); // Still just 1, not 2.
  });

  it('respects maxItems cap', async () => {
    const dir = await makeTmpDir();

    // Pre-seed store at cap.
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Item 1', { type: 'manual' }, 2, 'fact');
    addItem(existing, 'Item 2', { type: 'manual' }, 2, 'fact');
    await saveDurableMemory(dir, '42', existing);

    const runtime = makeRuntime('[{"kind":"preference","text":"New preference"}]');
    await applyUserTurnToDurable({
      runtime,
      userMessageText: 'Some message',
      userId: '42',
      durableDataDir: dir,
      durableMaxItems: 2,
      model: 'haiku',
      cwd: '/tmp',
    });

    const store = await loadDurableMemory(dir, '42');
    expect(store!.items).toHaveLength(2); // Cap enforced.
    expect(store!.items.some((it) => it.text === 'New preference')).toBe(true);
  });

  it('handles runtime returning empty array gracefully', async () => {
    const dir = await makeTmpDir();
    const runtime = makeRuntime('[]');

    await applyUserTurnToDurable({
      runtime,
      userMessageText: 'Nothing notable here',
      userId: '42',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    // No file should be created — nothing to write.
    const store = await loadDurableMemory(dir, '42');
    expect(store).toBeNull();
  });

  it('handles runtime error gracefully (no crash)', async () => {
    const dir = await makeTmpDir();
    const runtime = {
      invoke: async function* () {
        yield { type: 'error' as const, message: 'API error' };
      },
    } as any;

    // Should not throw.
    await applyUserTurnToDurable({
      runtime,
      userMessageText: 'Something',
      userId: '42',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    const store = await loadDurableMemory(dir, '42');
    expect(store).toBeNull();
  });
});
