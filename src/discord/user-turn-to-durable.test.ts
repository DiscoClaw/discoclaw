import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseExtractionResult, applyUserTurnToDurable, EXTRACTION_PROMPT } from './user-turn-to-durable.js';
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

  it('returns empty for non-array JSON object', () => {
    expect(parseExtractionResult('{"key":"val"}')).toEqual([]);
  });

  it('extracts first array when trailing brackets exist', () => {
    const raw = '[{"kind":"fact","text":"ok"}] some text [more stuff]';
    const items = parseExtractionResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'ok' }]);
  });
});

describe('EXTRACTION_PROMPT', () => {
  it('is exported', () => {
    expect(typeof EXTRACTION_PROMPT).toBe('string');
    expect(EXTRACTION_PROMPT.length).toBeGreaterThan(0);
  });

  it('contains the one-month test heuristic', () => {
    expect(EXTRACTION_PROMPT).toContain('one-month test');
    expect(EXTRACTION_PROMPT).toContain('still be useful to know in a month');
  });

  it('includes keep criteria for preferences and personal facts', () => {
    expect(EXTRACTION_PROMPT).toContain('preferences');
    expect(EXTRACTION_PROMPT).toContain('Personal facts');
    expect(EXTRACTION_PROMPT).toContain('Stable project context');
    expect(EXTRACTION_PROMPT).toContain('Cross-session conventions');
  });

  it('includes exclude criteria for transient task state', () => {
    expect(EXTRACTION_PROMPT).toContain('bugs being fixed');
    expect(EXTRACTION_PROMPT).toContain('PRs in flight');
    expect(EXTRACTION_PROMPT).toContain('One-time setup steps');
    expect(EXTRACTION_PROMPT).toContain('commit hashes');
    expect(EXTRACTION_PROMPT).toContain('status update');
  });

  it('preserves the JSON output contract', () => {
    expect(EXTRACTION_PROMPT).toContain('"kind"');
    expect(EXTRACTION_PROMPT).toContain('"text"');
    expect(EXTRACTION_PROMPT).toContain('preference, fact, project, constraint, person, tool, workflow');
    expect(EXTRACTION_PROMPT).toContain('Max 3 items');
    expect(EXTRACTION_PROMPT).toContain('return []');
  });

  it('contains the {userMessage} placeholder', () => {
    expect(EXTRACTION_PROMPT).toContain('{userMessage}');
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

  it('concurrent calls for same user serialize correctly', async () => {
    const dir = await makeTmpDir();

    // Each invocation extracts a different fact.
    let callCount = 0;
    const runtime = {
      invoke: async function* () {
        const n = ++callCount;
        yield { type: 'text_final' as const, text: `[{"kind":"fact","text":"Fact ${n}"}]` };
      },
    } as any;

    await Promise.all([
      applyUserTurnToDurable({
        runtime, userMessageText: 'msg1', userId: '42',
        durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp',
      }),
      applyUserTurnToDurable({
        runtime, userMessageText: 'msg2', userId: '42',
        durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp',
      }),
      applyUserTurnToDurable({
        runtime, userMessageText: 'msg3', userId: '42',
        durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp',
      }),
    ]);

    const store = await loadDurableMemory(dir, '42');
    expect(store).not.toBeNull();
    // All 3 facts should be stored (no overwrites from races).
    expect(store!.items).toHaveLength(3);
  });

  it('persists Discord metadata in source when provided', async () => {
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
      channelId: 'ch1',
      messageId: 'msg1',
      guildId: 'g1',
      channelName: 'dev',
    });

    const store = await loadDurableMemory(dir, '42');
    expect(store).not.toBeNull();
    expect(store!.items[0].source).toEqual({
      type: 'summary',
      channelId: 'ch1',
      messageId: 'msg1',
      guildId: 'g1',
      channelName: 'dev',
    });
  });

  it('omits Discord metadata when not provided', async () => {
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
    expect(store!.items[0].source).toEqual({ type: 'summary' });
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
