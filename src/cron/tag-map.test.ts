import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import { loadCronTagMapStrict, reloadCronTagMapInPlace } from './tag-map.js';

vi.mock('node:fs/promises');
const mockReadFile = vi.mocked(fs.readFile);

describe('loadCronTagMapStrict', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses valid tag map', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ monitoring: 'tag-1', daily: 'tag-2' }));
    const result = await loadCronTagMapStrict('/tmp/tags.json');
    expect(result).toEqual({ monitoring: 'tag-1', daily: 'tag-2' });
  });

  it('throws on invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not json {{{');
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow();
  });

  it('throws on array', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(['a', 'b']));
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow('must be a JSON object');
  });

  it('throws on null', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(null));
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow('must be a JSON object');
  });

  it('throws on number', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(42));
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow('must be a JSON object');
  });

  it('throws on non-string value', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ monitoring: 123 }));
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow('must be a string');
  });

  it('throws on read error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await expect(loadCronTagMapStrict('/tmp/tags.json')).rejects.toThrow('ENOENT');
  });
});

describe('reloadCronTagMapInPlace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('mutates existing map in-place and returns new count', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ a: '1', b: '2', c: '3' }));
    const tagMap: Record<string, string> = { old: 'val' };
    const count = await reloadCronTagMapInPlace('/tmp/tags.json', tagMap);
    expect(count).toBe(3);
    expect(tagMap).toEqual({ a: '1', b: '2', c: '3' });
    expect(tagMap).not.toHaveProperty('old');
  });

  it('preserves existing map on read failure', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const tagMap: Record<string, string> = { existing: 'val' };
    await expect(reloadCronTagMapInPlace('/tmp/tags.json', tagMap)).rejects.toThrow('ENOENT');
    expect(tagMap).toEqual({ existing: 'val' });
  });

  it('preserves existing map on validation failure', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ good: 'ok', bad: 123 }));
    const tagMap: Record<string, string> = { existing: 'val' };
    await expect(reloadCronTagMapInPlace('/tmp/tags.json', tagMap)).rejects.toThrow('must be a string');
    expect(tagMap).toEqual({ existing: 'val' });
  });
});
