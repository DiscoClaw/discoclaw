import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { TagMap } from './types.js';
import { loadTagMap, reloadTagMapInPlace } from './tag-map.js';

describe('loadTagMap', () => {
  it('returns parsed tag map when file is valid', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ bug: '111', feature: '222' }));
    const result = await loadTagMap('/tmp/tag-map.json');
    expect(result).toEqual({ bug: '111', feature: '222' });
  });

  it('returns empty map when file is missing', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await loadTagMap('/tmp/missing.json');
    expect(result).toEqual({});
  });

  it('returns empty map when JSON is invalid', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('{ bad json');
    const result = await loadTagMap('/tmp/bad.json');
    expect(result).toEqual({});
  });
});

describe('reloadTagMapInPlace', () => {
  it('reads file, mutates object in-place, and returns count', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ bug: '111', feature: '222' }));
    const tagMap: TagMap = { old: '000' };
    const count = await reloadTagMapInPlace('/tmp/tag-map.json', tagMap);
    expect(count).toBe(2);
    expect(tagMap).toEqual({ bug: '111', feature: '222' });
    expect(tagMap).not.toHaveProperty('old');
  });

  it('throws on read failure, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/missing.json', tagMap)).rejects.toThrow('ENOENT');
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('throws on truncated JSON, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('{ "bug": "111"');
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/bad.json', tagMap)).rejects.toThrow();
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('rejects array with descriptive error, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('["a", "b"]');
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/array.json', tagMap)).rejects.toThrow('must be a JSON object, got array');
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('rejects non-string values with descriptive error, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ bug: 123 }));
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/bad-val.json', tagMap)).rejects.toThrow('must be a string, got number');
    expect(tagMap).toEqual({ existing: '999' });
  });
});
