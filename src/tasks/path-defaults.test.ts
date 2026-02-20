import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTaskDataPath } from './path-defaults.js';

describe('resolveTaskDataPath', () => {
  it('returns undefined when dataDir is not provided', () => {
    expect(resolveTaskDataPath(undefined, 'tasks.jsonl')).toBeUndefined();
  });

  it('returns canonical path when no files exist', () => {
    const dataDir = '/tmp/discoclaw-data';
    const result = resolveTaskDataPath(dataDir, 'tasks.jsonl', () => false);
    expect(result).toBe(path.join(dataDir, 'tasks', 'tasks.jsonl'));
  });

  it('falls back to legacy path when only legacy exists', () => {
    const dataDir = '/tmp/discoclaw-data';
    const canonical = path.join(dataDir, 'tasks', 'tasks.jsonl');
    const legacy = path.join(dataDir, 'beads', 'tasks.jsonl');
    const result = resolveTaskDataPath(
      dataDir,
      'tasks.jsonl',
      (candidate) => candidate === legacy && candidate !== canonical,
    );
    expect(result).toBe(legacy);
  });

  it('prefers canonical path when both canonical and legacy exist', () => {
    const dataDir = '/tmp/discoclaw-data';
    const canonical = path.join(dataDir, 'tasks', 'tasks.jsonl');
    const result = resolveTaskDataPath(dataDir, 'tasks.jsonl', () => true);
    expect(result).toBe(canonical);
  });

  it('resolves tag-map path with same rules', () => {
    const dataDir = '/tmp/discoclaw-data';
    const canonical = path.join(dataDir, 'tasks', 'tag-map.json');
    const result = resolveTaskDataPath(dataDir, 'tag-map.json', (candidate) => candidate === canonical);
    expect(result).toBe(canonical);
  });
});
