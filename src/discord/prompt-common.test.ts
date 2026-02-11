import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { loadWorkspaceMemoryFile, loadDailyLogFiles } from './prompt-common.js';

describe('loadWorkspaceMemoryFile', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('returns path when MEMORY.md exists', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'MEMORY.md'), '# Memory', 'utf-8');

    const result = await loadWorkspaceMemoryFile(workspace);
    expect(result).toBe(path.join(workspace, 'MEMORY.md'));
  });

  it('returns null when MEMORY.md does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadWorkspaceMemoryFile(workspace);
    expect(result).toBeNull();
  });
});

describe('loadDailyLogFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function dateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  it('returns today and yesterday log paths when both exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    const memDir = path.join(workspace, 'memory');
    await fs.mkdir(memDir, { recursive: true });

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    await fs.writeFile(path.join(memDir, dateStr(today) + '.md'), 'today', 'utf-8');
    await fs.writeFile(path.join(memDir, dateStr(yesterday) + '.md'), 'yesterday', 'utf-8');

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([
      path.join(memDir, dateStr(today) + '.md'),
      path.join(memDir, dateStr(yesterday) + '.md'),
    ]);
  });

  it('returns only today when yesterday does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    const memDir = path.join(workspace, 'memory');
    await fs.mkdir(memDir, { recursive: true });

    const today = new Date();
    await fs.writeFile(path.join(memDir, dateStr(today) + '.md'), 'today', 'utf-8');

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([path.join(memDir, dateStr(today) + '.md')]);
  });

  it('returns empty array when no daily logs exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([]);
  });

  it('returns empty array when memory dir does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([]);
  });
});
