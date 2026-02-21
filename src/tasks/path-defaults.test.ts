import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTaskDataPath } from './path-defaults.js';

describe('resolveTaskDataPath', () => {
  it('returns undefined when dataDir is not provided', () => {
    expect(resolveTaskDataPath(undefined, 'tasks.jsonl')).toBeUndefined();
  });

  it('returns canonical path for tasks.jsonl', () => {
    const dataDir = '/tmp/discoclaw-data';
    const result = resolveTaskDataPath(dataDir, 'tasks.jsonl');
    expect(result).toBe(path.join(dataDir, 'tasks', 'tasks.jsonl'));
  });

  it('returns canonical path for tag-map.json', () => {
    const dataDir = '/tmp/discoclaw-data';
    const canonical = path.join(dataDir, 'tasks', 'tag-map.json');
    const result = resolveTaskDataPath(dataDir, 'tag-map.json');
    expect(result).toBe(canonical);
  });
});
