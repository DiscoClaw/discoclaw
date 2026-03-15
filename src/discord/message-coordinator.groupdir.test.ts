import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureGroupDir, groupDirNameFromSessionKey } from './message-coordinator.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe('groupDirNameFromSessionKey', () => {
  it('normalizes session keys for cross-platform filesystem safety', () => {
    const dirName = groupDirNameFromSessionKey('discord:guild/chan\\user:*?name');
    expect(dirName).toBe('discord-guild-chan-user-name');
    expect(dirName.includes(':')).toBe(false);
  });

  it('returns fallback name when key has no usable characters', () => {
    const dirName = groupDirNameFromSessionKey('::::');
    expect(dirName).toBe('session');
  });
});

describe('ensureGroupDir', () => {
  it('creates group directory and writes CLAUDE.md when absent', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-groupdir-'));
    tempDirs.push(base);

    const dir = await ensureGroupDir(base, 'discord:guild:channel:user', 'Discoclaw');
    const claudePath = path.join(dir, 'CLAUDE.md');
    const content = await fs.readFile(claudePath, 'utf8');

    expect(path.basename(dir)).toBe('discord-guild-channel-user');
    expect(content).toContain('# Discoclaw Group');
  });
});
