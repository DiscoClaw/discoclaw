import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPathAllowed,
  canonicalizeRoots,
  isPathUnderRoots,
  NO_ALLOWED_ROOTS_ERROR,
  PATH_SECURITY_GATE,
  resolveAndCheck,
} from './path-security.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-security-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('path-security contract', () => {
  it('names the concrete filesystem/path gate', () => {
    expect(PATH_SECURITY_GATE).toBe('resolveAndCheck -> assertPathAllowed');
  });

  it('fails closed when no allowed roots are configured', async () => {
    await expect(resolveAndCheck('note.txt', [])).rejects.toThrow(NO_ALLOWED_ROOTS_ERROR);
    await expect(canonicalizeRoots(['', '   '])).rejects.toThrow(NO_ALLOWED_ROOTS_ERROR);
  });
});

describe('resolveAndCheck', () => {
  it('resolves relative paths against the first configured allowed root', async () => {
    const resolved = await resolveAndCheck('nested/note.txt', ['', '   ', tmpDir], true);
    expect(resolved).toBe(path.join(tmpDir, 'nested', 'note.txt'));
  });

  it('accepts an absolute path inside a secondary allowed root', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-security-other-'));
    const target = path.join(otherRoot, 'safe.txt');

    try {
      const resolved = await resolveAndCheck(target, [tmpDir, otherRoot], true);
      expect(resolved).toBe(target);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects a symlink that escapes the allowed roots', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-security-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const linkPath = path.join(tmpDir, 'escape.txt');
    await fs.writeFile(outsideFile, 'secret');
    await fs.symlink(outsideFile, linkPath);

    try {
      await expect(resolveAndCheck(linkPath, [tmpDir])).rejects.toThrow(/outside allowed roots/i);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-existent write target whose parent symlink escapes', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-security-write-'));
    const escapeDir = path.join(tmpDir, 'escape-dir');
    await fs.symlink(outsideDir, escapeDir);

    try {
      await expect(
        resolveAndCheck(path.join(escapeDir, 'new.txt'), [tmpDir], true),
      ).rejects.toThrow(/outside allowed roots/i);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('assertPathAllowed', () => {
  it('accepts a path contained by any configured root', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-security-multi-'));
    const target = path.join(otherRoot, 'safe.txt');
    await fs.writeFile(target, 'safe');

    try {
      await expect(assertPathAllowed(target, [tmpDir, otherRoot])).resolves.toBeUndefined();
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('isPathUnderRoots', () => {
  it('treats the filesystem root as containing descendants', () => {
    const filesystemRoot = path.parse(tmpDir).root;
    expect(isPathUnderRoots(tmpDir, [filesystemRoot])).toBe(true);
  });
});
