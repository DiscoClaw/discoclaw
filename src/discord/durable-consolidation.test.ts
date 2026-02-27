import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseConsolidationResult,
  runConsolidation,
  maybeConsolidate,
  CONSOLIDATION_PROMPT,
} from './durable-consolidation.js';
import { loadDurableMemory, addItem, saveDurableMemory } from './durable-memory.js';
import type { DurableMemoryStore } from './durable-memory.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'durable-consolidation-test-'));
}

function makeRuntime(responseText: string) {
  return {
    invoke: async function* () {
      yield { type: 'text_final' as const, text: responseText };
    },
  } as any;
}

describe('parseConsolidationResult', () => {
  it('parses a valid consolidated array', () => {
    const raw = '[{"kind":"fact","text":"Likes TypeScript"},{"kind":"preference","text":"Prefers dark mode"}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([
      { kind: 'fact', text: 'Likes TypeScript' },
      { kind: 'preference', text: 'Prefers dark mode' },
    ]);
  });

  it('returns empty on malformed JSON', () => {
    expect(parseConsolidationResult('not json')).toEqual([]);
    expect(parseConsolidationResult('{}')).toEqual([]);
  });

  it('returns empty for empty array', () => {
    expect(parseConsolidationResult('[]')).toEqual([]);
  });

  it('filters out items with invalid kinds', () => {
    const raw = '[{"kind":"invalid","text":"dropped"},{"kind":"fact","text":"kept"}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'kept' }]);
  });

  it('filters out items with empty text', () => {
    const raw = '[{"kind":"fact","text":""},{"kind":"fact","text":"  "},{"kind":"fact","text":"real"}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'real' }]);
  });

  it('includes retainedFrom when present and non-empty', () => {
    const raw = '[{"kind":"fact","text":"Merged fact","retainedFrom":["durable-aabbccdd","durable-11223344"]}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([
      { kind: 'fact', text: 'Merged fact', retainedFrom: ['durable-aabbccdd', 'durable-11223344'] },
    ]);
  });

  it('omits retainedFrom when array is empty', () => {
    const raw = '[{"kind":"fact","text":"Item","retainedFrom":[]}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'Item' }]);
  });

  it('omits retainedFrom when absent', () => {
    const raw = '[{"kind":"fact","text":"Item"}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'Item' }]);
  });

  it('handles JSON inside markdown fences', () => {
    const raw = '```json\n[{"kind":"fact","text":"Extracted"}]\n```';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'Extracted' }]);
  });

  it('accepts all valid kinds', () => {
    const kinds = ['preference', 'fact', 'project', 'constraint', 'person', 'tool', 'workflow'] as const;
    for (const kind of kinds) {
      const raw = `[{"kind":"${kind}","text":"test"}]`;
      const items = parseConsolidationResult(raw);
      expect(items).toEqual([{ kind, text: 'test' }]);
    }
  });

  it('trims whitespace from text', () => {
    const raw = '[{"kind":"fact","text":"  spaced  "}]';
    const items = parseConsolidationResult(raw);
    expect(items).toEqual([{ kind: 'fact', text: 'spaced' }]);
  });
});

describe('CONSOLIDATION_PROMPT', () => {
  it('is exported as a non-empty string', () => {
    expect(typeof CONSOLIDATION_PROMPT).toBe('string');
    expect(CONSOLIDATION_PROMPT.length).toBeGreaterThan(0);
  });

  it('contains the {activeItems} placeholder', () => {
    expect(CONSOLIDATION_PROMPT).toContain('{activeItems}');
  });

  it('mentions merging near-duplicates', () => {
    expect(CONSOLIDATION_PROMPT).toContain('near-duplicate');
  });

  it('mentions dropping stale items', () => {
    expect(CONSOLIDATION_PROMPT).toContain('stale');
  });

  it('contains retainedFrom in the output format section', () => {
    expect(CONSOLIDATION_PROMPT).toContain('retainedFrom');
  });

  it('lists all valid kinds', () => {
    expect(CONSOLIDATION_PROMPT).toContain('preference, fact, project, constraint, person, tool, workflow');
  });

  it('instructs not to exceed the original item count', () => {
    expect(CONSOLIDATION_PROMPT).toContain('Do not exceed the original item count');
  });
});

describe('runConsolidation', () => {
  it('consolidates active items and deprecates originals', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Likes TypeScript', { type: 'manual' }, 200, 'fact');
    addItem(existing, 'Also likes TypeScript', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'u1', existing);

    const runtime = makeRuntime('[{"kind":"fact","text":"Prefers TypeScript"}]');
    const result = await runConsolidation({
      runtime,
      userId: 'u1',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.originalCount).toBe(2);
    expect(result.consolidatedCount).toBe(1);

    const store = await loadDurableMemory(dir, 'u1');
    expect(store).not.toBeNull();
    const active = store!.items.filter((it) => it.status === 'active');
    const deprecated = store!.items.filter((it) => it.status === 'deprecated');
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Prefers TypeScript');
    expect(active[0].source.type).toBe('consolidation');
    expect(deprecated).toHaveLength(2);
  });

  it('consolidated items have source.type consolidation', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Likes Rust', { type: 'manual' }, 200, 'preference');
    await saveDurableMemory(dir, 'u2', existing);

    const runtime = makeRuntime('[{"kind":"preference","text":"Prefers Rust"}]');
    await runConsolidation({
      runtime,
      userId: 'u2',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    const store = await loadDurableMemory(dir, 'u2');
    const active = store!.items.filter((it) => it.status === 'active');
    expect(active[0].source.type).toBe('consolidation');
  });

  it('aborts without mutations when result is empty (safety guard)', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'u3', existing);

    const runtime = makeRuntime('[]');
    const result = await runConsolidation({
      runtime,
      userId: 'u3',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.originalCount).toBe(1);
    expect(result.consolidatedCount).toBe(0);

    const store = await loadDurableMemory(dir, 'u3');
    const active = store!.items.filter((it) => it.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Fact A');
  });

  it('aborts without mutations when result exceeds original count (safety guard)', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'u4', existing);

    // Model returns 3 items but only 1 was active.
    const runtime = makeRuntime('[{"kind":"fact","text":"A"},{"kind":"fact","text":"B"},{"kind":"fact","text":"C"}]');
    const result = await runConsolidation({
      runtime,
      userId: 'u4',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.consolidatedCount).toBe(0);

    const store = await loadDurableMemory(dir, 'u4');
    const active = store!.items.filter((it) => it.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Fact A');
  });

  it('returns originalCount=0 and skips model call when no active items', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Deprecated fact', { type: 'manual' }, 200, 'fact');
    existing.items[0]!.status = 'deprecated';
    await saveDurableMemory(dir, 'u5', existing);

    let invokeCalled = false;
    const runtime = {
      invoke: async function* () {
        invokeCalled = true;
        yield { type: 'text_final' as const, text: '[]' };
      },
    } as any;

    const result = await runConsolidation({
      runtime,
      userId: 'u5',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.originalCount).toBe(0);
    expect(result.consolidatedCount).toBe(0);
    expect(invokeCalled).toBe(false);
  });

  it('handles model error gracefully with no store mutations', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'u6', existing);

    const runtime = {
      invoke: async function* () {
        yield { type: 'error' as const, message: 'model error' };
      },
    } as any;

    const result = await runConsolidation({
      runtime,
      userId: 'u6',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.consolidatedCount).toBe(0);

    const store = await loadDurableMemory(dir, 'u6');
    const active = store!.items.filter((it) => it.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Fact A');
  });

  it('serializes concurrent calls for the same user without data corruption', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    addItem(existing, 'Fact B', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'u7', existing);

    const runtime = makeRuntime('[{"kind":"fact","text":"Consolidated"}]');
    await Promise.all([
      runConsolidation({ runtime, userId: 'u7', durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp' }),
      runConsolidation({ runtime, userId: 'u7', durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp' }),
    ]);

    const store = await loadDurableMemory(dir, 'u7');
    const active = store!.items.filter((it) => it.status === 'active');
    expect(active).toHaveLength(1);
  });

  it('creates a store if none exists and returns 0/0', async () => {
    const dir = await makeTmpDir();
    let invokeCalled = false;
    const runtime = {
      invoke: async function* () {
        invokeCalled = true;
        yield { type: 'text_final' as const, text: '[]' };
      },
    } as any;

    const result = await runConsolidation({
      runtime,
      userId: 'u8',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
    });

    expect(result.originalCount).toBe(0);
    expect(result.consolidatedCount).toBe(0);
    expect(invokeCalled).toBe(false);
  });
});

describe('maybeConsolidate', () => {
  it('does not run if active count is below threshold', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'mc1', existing);

    let invokeCalled = false;
    const runtime = {
      invoke: async function* () {
        invokeCalled = true;
        yield { type: 'text_final' as const, text: '[{"kind":"fact","text":"X"}]' };
      },
    } as any;

    await maybeConsolidate({
      runtime,
      userId: 'mc1',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
      threshold: 5, // 1 active < 5
    });

    expect(invokeCalled).toBe(false);
  });

  it('does not run if store is missing', async () => {
    const dir = await makeTmpDir();

    let invokeCalled = false;
    const runtime = {
      invoke: async function* () {
        invokeCalled = true;
        yield { type: 'text_final' as const, text: '[]' };
      },
    } as any;

    await maybeConsolidate({
      runtime,
      userId: 'nonexistent',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
      threshold: 1,
    });

    expect(invokeCalled).toBe(false);
  });

  it('fires consolidation when active count meets threshold', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    addItem(existing, 'Fact B', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'mc2', existing);

    let invokeCalled = false;
    const runtime = {
      invoke: async function* () {
        invokeCalled = true;
        yield { type: 'text_final' as const, text: '[{"kind":"fact","text":"Merged"}]' };
      },
    } as any;

    await maybeConsolidate({
      runtime,
      userId: 'mc2',
      durableDataDir: dir,
      durableMaxItems: 200,
      model: 'haiku',
      cwd: '/tmp',
      threshold: 2, // 2 active == 2 threshold
    });

    // Let the detached promise complete.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(invokeCalled).toBe(true);
  });

  it('prevents overlapping runs for the same userId', async () => {
    const dir = await makeTmpDir();
    const existing: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(existing, 'Fact A', { type: 'manual' }, 200, 'fact');
    await saveDurableMemory(dir, 'mc3', existing);

    let invokeCount = 0;
    const runtime = {
      invoke: async function* () {
        invokeCount++;
        yield { type: 'text_final' as const, text: '[{"kind":"fact","text":"X"}]' };
      },
    } as any;

    // Start two concurrent maybeConsolidate calls.
    await Promise.all([
      maybeConsolidate({ runtime, userId: 'mc3', durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp', threshold: 1 }),
      maybeConsolidate({ runtime, userId: 'mc3', durableDataDir: dir, durableMaxItems: 200, model: 'haiku', cwd: '/tmp', threshold: 1 }),
    ]);

    // Let the detached promise(s) complete.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(invokeCount).toBe(1);
  });
});
