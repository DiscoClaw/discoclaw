import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { safeCronId, acquireCronLock, releaseCronLock, getProcessStartTime } from './job-lock.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-lock-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// safeCronId
// ---------------------------------------------------------------------------

describe('safeCronId', () => {
  it('produces distinct names for IDs that sanitize identically', () => {
    // "a/b" and "a_b" both sanitize to "a_b" but hashes differ.
    const a = safeCronId('a/b');
    const b = safeCronId('a_b');
    expect(a).not.toBe(b);
  });

  it('preserves safe characters', () => {
    const result = safeCronId('cron-abc_123.test');
    expect(result).toMatch(/^cron-abc_123\.test\.[0-9a-f]{8}$/);
  });

  it('replaces unsafe characters', () => {
    const result = safeCronId('my cron/job!@#');
    expect(result).not.toContain(' ');
    expect(result).not.toContain('/');
    expect(result).not.toContain('!');
  });
});

// ---------------------------------------------------------------------------
// getProcessStartTime
// ---------------------------------------------------------------------------

describe('getProcessStartTime', () => {
  it('returns a number for the current process (Linux) or null (non-Linux)', async () => {
    const result = await getProcessStartTime(process.pid);
    if (process.platform === 'linux') {
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    } else {
      expect(result).toBeNull();
    }
  });

  it('returns null for a non-existent PID', async () => {
    const result = await getProcessStartTime(999999999);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// acquireCronLock
// ---------------------------------------------------------------------------

describe('acquireCronLock', () => {
  it('acquires a fresh lock (directory + meta.json created)', async () => {
    const token = await acquireCronLock(tmpDir, 'cron-test');
    expect(typeof token).toBe('string');
    expect(token.length).toBe(32); // 16 bytes hex

    const lockPath = path.join(tmpDir, safeCronId('cron-test') + '.lock');
    const stat = await fs.stat(lockPath);
    expect(stat.isDirectory()).toBe(true);

    const raw = await fs.readFile(path.join(lockPath, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
    expect(meta.token).toBe(token);
    expect(meta.acquiredAt).toBeDefined();
  });

  it('throws when PID alive and startTime matches (lock held)', async () => {
    const token1 = await acquireCronLock(tmpDir, 'cron-held');
    expect(token1).toBeDefined();

    // Second acquire by same process — PID alive, startTime will match.
    await expect(acquireCronLock(tmpDir, 'cron-held')).rejects.toThrow(/Lock held by PID/);
  });

  it('takes over when PID is dead (ESRCH)', async () => {
    // Create a lock with a fake dead PID.
    const lockPath = path.join(tmpDir, safeCronId('cron-dead') + '.lock');
    await fs.mkdir(lockPath);
    const fakeMeta = { pid: 999999999, token: 'old-token', acquiredAt: new Date().toISOString() };
    await fs.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify(fakeMeta));

    const token = await acquireCronLock(tmpDir, 'cron-dead');
    expect(typeof token).toBe('string');

    // Verify the new lock has our PID.
    const raw = await fs.readFile(path.join(lockPath, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.pid).toBe(process.pid);
    expect(meta.token).toBe(token);
  });

  it('takes over when PID alive but startTime mismatches (PID reuse)', async () => {
    const lockPath = path.join(tmpDir, safeCronId('cron-reuse') + '.lock');
    await fs.mkdir(lockPath);
    // Use current PID (alive) but a bogus startTime that won't match.
    const fakeMeta = {
      pid: process.pid,
      token: 'old-token',
      acquiredAt: new Date().toISOString(),
      startTime: 12345, // won't match real startTime
    };
    await fs.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify(fakeMeta));

    if (process.platform === 'linux') {
      // On Linux, startTime will differ → stale takeover.
      const token = await acquireCronLock(tmpDir, 'cron-reuse');
      expect(typeof token).toBe('string');
    } else {
      // On non-Linux, getProcessStartTime returns null for both sides,
      // and meta has a startTime while proc doesn't → they don't both have startTime,
      // so it falls through to "lock held" (PID alive, can't confirm mismatch).
      await expect(acquireCronLock(tmpDir, 'cron-reuse')).rejects.toThrow(/Lock held by PID/);
    }
  });

  it('blocks when lock dir exists, meta.json missing, dir < 2s old (grace period)', async () => {
    const lockPath = path.join(tmpDir, safeCronId('cron-grace') + '.lock');
    await fs.mkdir(lockPath);
    // No meta.json, dir just created → grace period.

    await expect(acquireCronLock(tmpDir, 'cron-grace')).rejects.toThrow(/Lock initializing/);
  });

  it('takes over when lock dir exists, meta.json missing, dir >= 2s old', async () => {
    const lockPath = path.join(tmpDir, safeCronId('cron-old') + '.lock');
    await fs.mkdir(lockPath);

    // Backdate the directory mtime by 3 seconds.
    const past = new Date(Date.now() - 3000);
    await fs.utimes(lockPath, past, past);

    const token = await acquireCronLock(tmpDir, 'cron-old');
    expect(typeof token).toBe('string');
  });

  it('takes over when meta.json is corrupt (invalid JSON) and dir old', async () => {
    const lockPath = path.join(tmpDir, safeCronId('cron-corrupt') + '.lock');
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'meta.json'), 'not json!!!');

    // Backdate directory.
    const past = new Date(Date.now() - 3000);
    await fs.utimes(lockPath, past, past);

    const token = await acquireCronLock(tmpDir, 'cron-corrupt');
    expect(typeof token).toBe('string');
  });

  it('simulates EEXIST contention then stale-takeover retry path', async () => {
    // Pre-create a lock with a dead PID to ensure the EEXIST → stale → retry path.
    const lockPath = path.join(tmpDir, safeCronId('cron-contention') + '.lock');
    await fs.mkdir(lockPath);
    const fakeMeta = { pid: 999999999, token: 'stale-token', acquiredAt: new Date().toISOString() };
    await fs.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify(fakeMeta));

    // Should detect EEXIST, read meta, find dead PID, rm, retry, succeed.
    const token = await acquireCronLock(tmpDir, 'cron-contention');
    expect(typeof token).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// releaseCronLock
// ---------------------------------------------------------------------------

describe('releaseCronLock', () => {
  it('removes lock when token matches', async () => {
    const token = await acquireCronLock(tmpDir, 'cron-release');
    const lockPath = path.join(tmpDir, safeCronId('cron-release') + '.lock');

    // Lock exists.
    await expect(fs.stat(lockPath)).resolves.toBeDefined();

    await releaseCronLock(tmpDir, 'cron-release', token);

    // Lock removed.
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it('leaves lock intact when token does not match', async () => {
    const token = await acquireCronLock(tmpDir, 'cron-mismatch');
    const lockPath = path.join(tmpDir, safeCronId('cron-mismatch') + '.lock');

    await releaseCronLock(tmpDir, 'cron-mismatch', 'wrong-token');

    // Lock still exists.
    const stat = await fs.stat(lockPath);
    expect(stat.isDirectory()).toBe(true);

    // And the original token is still in meta.json.
    const raw = await fs.readFile(path.join(lockPath, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.token).toBe(token);
  });

  it('is idempotent (no error if dir already missing)', async () => {
    // No lock exists — should not throw.
    await expect(releaseCronLock(tmpDir, 'cron-nonexistent', 'any-token')).resolves.toBeUndefined();
  });
});
