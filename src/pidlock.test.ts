import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { acquirePidLock, releasePidLock } from './pidlock.js';

async function tmpLockPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidlock-'));
  return path.join(dir, 'discoclaw.pid');
}

function lockDirPath(lockPath: string): string {
  return `${lockPath}.lock`;
}

describe('acquirePidLock', () => {
  const paths: string[] = [];
  afterEach(async () => {
    for (const p of paths) {
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    }
    paths.length = 0;
  });

  it('creates a lock directory with meta for current PID', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);

    await acquirePidLock(lockPath);

    const raw = await fs.readFile(path.join(lockDirPath(lockPath), 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
    expect(typeof meta.token).toBe('string');
    expect(meta.token.length).toBe(32);
  });

  it('takes over stale lock with dead PID', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await fs.mkdir(lockDir);
    await fs.writeFile(
      path.join(lockDir, 'meta.json'),
      JSON.stringify({ pid: 999999999, token: 'old-token', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    await acquirePidLock(lockPath);

    const raw = await fs.readFile(path.join(lockDir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
  });

  it('throws when a live process holds the lock', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await fs.mkdir(lockDir);
    await fs.writeFile(
      path.join(lockDir, 'meta.json'),
      JSON.stringify({ pid: 1, token: 'held-token', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    await expect(acquirePidLock(lockPath)).rejects.toThrow(/already running.*PID 1/);
  });

  it('takes over old lock directory with corrupt meta', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'meta.json'), 'not-json', 'utf-8');
    const past = new Date(Date.now() - 3000);
    await fs.utimes(lockDir, past, past);

    await acquirePidLock(lockPath);

    const raw = await fs.readFile(path.join(lockDir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
  });

  it('blocks while lock directory is initializing (meta missing, <2s old)', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await fs.mkdir(lockDir);
    await expect(acquirePidLock(lockPath)).rejects.toThrow(/initializing/);
  });

  it('allows only one winner under concurrent acquisition attempts', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);

    const [a, b] = await Promise.allSettled([acquirePidLock(lockPath), acquirePidLock(lockPath)]);
    const successes = [a, b].filter((r) => r.status === 'fulfilled');
    const failures = [a, b].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('removes stale legacy PID lock file before acquiring lock directory', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);

    await fs.writeFile(lockPath, '999999999', 'utf-8');
    await acquirePidLock(lockPath);

    await expect(fs.access(lockPath)).rejects.toThrow();
    const raw = await fs.readFile(path.join(lockDirPath(lockPath), 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
  });

  it('rejects when a live legacy PID lock file exists', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);

    await fs.writeFile(lockPath, '1', 'utf-8');
    await expect(acquirePidLock(lockPath)).rejects.toThrow(/already running.*PID 1/);
  });
});

describe('releasePidLock', () => {
  const paths: string[] = [];
  afterEach(async () => {
    for (const p of paths) {
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    }
    paths.length = 0;
  });

  it('removes the lock directory for current holder', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await acquirePidLock(lockPath);

    await releasePidLock(lockPath);

    await expect(fs.access(lockDir)).rejects.toThrow();
  });

  it('does not remove lock directory when meta belongs to another PID', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);
    const lockDir = lockDirPath(lockPath);

    await fs.mkdir(lockDir);
    await fs.writeFile(
      path.join(lockDir, 'meta.json'),
      JSON.stringify({ pid: 1, token: 'other-token', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    await releasePidLock(lockPath);

    const stat = await fs.stat(lockDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('does nothing when the lock directory does not exist', async () => {
    const lockPath = await tmpLockPath();
    paths.push(lockPath);

    // Should not throw.
    await releasePidLock(lockPath);
  });
});
