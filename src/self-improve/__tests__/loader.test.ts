import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTestCasesFromFile, loadTestCasesFromDir, filterByTags } from '../loader.js';
import type { FrozenTestCase } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `si-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function writeJson(name: string, data: unknown): Promise<void> {
  return writeFile(join(testDir, name), JSON.stringify(data, null, 2));
}

const VALID_CASE = {
  id: 'test-1',
  prompt: 'list channels',
  expectedActions: [{ type: 'channelList' }],
};

// ── loadTestCasesFromFile ───────────────────────────────────────────

describe('loadTestCasesFromFile', () => {
  it('loads a valid JSON array', async () => {
    await writeJson('cases.json', [VALID_CASE]);
    const result = await loadTestCasesFromFile(join(testDir, 'cases.json'));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-1');
    expect(result[0].prompt).toBe('list channels');
    expect(result[0].expectedActions).toEqual([{ type: 'channelList' }]);
  });

  it('loads cases with params and tags', async () => {
    const withParams = {
      id: 'msg-1',
      prompt: 'send hello to general',
      expectedActions: [{ type: 'sendMessage', params: { channel: 'general', content: 'hello' } }],
      tags: ['messaging', 'basic'],
    };
    await writeJson('cases.json', [withParams]);
    const result = await loadTestCasesFromFile(join(testDir, 'cases.json'));
    expect(result[0].expectedActions[0].params).toEqual({ channel: 'general', content: 'hello' });
    expect(result[0].tags).toEqual(['messaging', 'basic']);
  });

  it('rejects non-array top level', async () => {
    await writeJson('bad.json', { id: 'x', prompt: 'y', expectedActions: [{ type: 'z' }] });
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('JSON array');
  });

  it('rejects entry with missing id', async () => {
    await writeJson('bad.json', [{ prompt: 'x', expectedActions: [{ type: 'y' }] }]);
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('"id"');
  });

  it('rejects entry with empty prompt', async () => {
    await writeJson('bad.json', [{ id: 'x', prompt: '', expectedActions: [{ type: 'y' }] }]);
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('"prompt"');
  });

  it('rejects entry with empty expectedActions', async () => {
    await writeJson('bad.json', [{ id: 'x', prompt: 'y', expectedActions: [] }]);
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('"expectedActions"');
  });

  it('rejects action without type', async () => {
    await writeJson('bad.json', [{ id: 'x', prompt: 'y', expectedActions: [{ params: {} }] }]);
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('"type"');
  });

  it('rejects invalid tags', async () => {
    await writeJson('bad.json', [{ id: 'x', prompt: 'y', expectedActions: [{ type: 'z' }], tags: [1] }]);
    await expect(loadTestCasesFromFile(join(testDir, 'bad.json'))).rejects.toThrow('"tags"');
  });
});

// ── loadTestCasesFromDir ────────────────────────────────────────────

describe('loadTestCasesFromDir', () => {
  it('loads from multiple JSON files', async () => {
    await writeJson('a.json', [{ id: 'a-1', prompt: 'p1', expectedActions: [{ type: 't1' }] }]);
    await writeJson('b.json', [{ id: 'b-1', prompt: 'p2', expectedActions: [{ type: 't2' }] }]);
    const result = await loadTestCasesFromDir(testDir);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(['a-1', 'b-1']);
  });

  it('ignores non-JSON files', async () => {
    await writeJson('cases.json', [VALID_CASE]);
    await writeFile(join(testDir, 'readme.md'), '# notes');
    const result = await loadTestCasesFromDir(testDir);
    expect(result).toHaveLength(1);
  });

  it('returns empty for empty directory', async () => {
    const result = await loadTestCasesFromDir(testDir);
    expect(result).toEqual([]);
  });

  it('throws on duplicate IDs across files', async () => {
    await writeJson('a.json', [{ id: 'dup', prompt: 'p1', expectedActions: [{ type: 't1' }] }]);
    await writeJson('b.json', [{ id: 'dup', prompt: 'p2', expectedActions: [{ type: 't2' }] }]);
    await expect(loadTestCasesFromDir(testDir)).rejects.toThrow('Duplicate');
  });
});

// ── filterByTags ────────────────────────────────────────────────────

describe('filterByTags', () => {
  const cases: FrozenTestCase[] = [
    { id: '1', prompt: 'a', expectedActions: [{ type: 'x' }], tags: ['messaging'] },
    { id: '2', prompt: 'b', expectedActions: [{ type: 'y' }], tags: ['channels', 'basic'] },
    { id: '3', prompt: 'c', expectedActions: [{ type: 'z' }] },
  ];

  it('returns cases matching any specified tag', () => {
    expect(filterByTags(cases, ['messaging'])).toHaveLength(1);
    expect(filterByTags(cases, ['messaging'])[0].id).toBe('1');
  });

  it('matches multiple tags with OR semantics', () => {
    expect(filterByTags(cases, ['messaging', 'channels'])).toHaveLength(2);
  });

  it('excludes cases without tags', () => {
    expect(filterByTags(cases, ['messaging']).find((c) => c.id === '3')).toBeUndefined();
  });

  it('returns empty for no matching tags', () => {
    expect(filterByTags(cases, ['nonexistent'])).toEqual([]);
  });
});
