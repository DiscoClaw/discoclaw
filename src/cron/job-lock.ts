import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Collision-resistant lock name from a cron ID.
 * Sanitizes non-alphanumeric chars and appends a short hash suffix
 * to prevent collisions when different IDs sanitize to the same string
 * (e.g. "a/b" vs "a_b").
 */
export function safeCronId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${sanitized}.${hash}`;
}

type LockMeta = {
  pid: number;
  token: string;
  acquiredAt: string;
  startTime?: number;
};

/**
 * Read the Linux process start time from /proc/{pid}/stat (field 22, jiffies since boot).
 * Returns null on non-Linux systems or on any read failure.
 */
export async function getProcessStartTime(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    // Fields are space-separated but field 2 (comm) may contain spaces and is wrapped in parens.
    // Find the closing paren, then split the rest.
    const closeParenIdx = stat.lastIndexOf(')');
    if (closeParenIdx === -1) return null;
    const fields = stat.slice(closeParenIdx + 2).split(' ');
    // After the closing paren: field 3=state(idx 0), ..., field 22=starttime(idx 19)
    const startTime = Number(fields[19]);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

/** Grace period: lock dirs younger than this with missing meta.json are treated as initializing. */
const GRACE_PERIOD_MS = 2000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // process exists, no permission to signal
    return false; // ESRCH = dead
  }
}

function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function readMeta(lockPath: string): Promise<LockMeta | null> {
  try {
    const raw = await fs.readFile(path.join(lockPath, 'meta.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid !== 'number' || typeof parsed?.token !== 'string') return null;
    return parsed as LockMeta;
  } catch {
    return null;
  }
}

async function writeMeta(lockPath: string, meta: LockMeta): Promise<void> {
  const metaPath = path.join(lockPath, 'meta.json');
  const tmpPath = `${metaPath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(meta) + '\n', 'utf-8');
  await fs.rename(tmpPath, metaPath);
}

/**
 * Acquire a file-based lock for a cron job.
 * Returns a token on success. Throws if the lock is held or initializing.
 */
export async function acquireCronLock(lockDir: string, cronId: string): Promise<string> {
  const lockName = safeCronId(cronId);
  const lockPath = path.join(lockDir, lockName + '.lock');
  const token = generateToken();
  const startTime = await getProcessStartTime(process.pid);
  const meta: LockMeta = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    ...(startTime != null ? { startTime } : {}),
  };

  // Attempt 1: try atomic mkdir.
  try {
    await fs.mkdir(lockPath);
    await writeMeta(lockPath, meta);
    return token;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Lock directory exists — check if it's stale.
  const existingMeta = await readMeta(lockPath);

  if (!existingMeta) {
    // meta.json missing or corrupt — check grace period.
    let dirAge = Infinity;
    try {
      const stat = await fs.stat(lockPath);
      dirAge = Date.now() - stat.mtimeMs;
    } catch {
      // Can't stat — treat as old.
    }

    if (dirAge < GRACE_PERIOD_MS) {
      throw new Error(`Lock initializing for "${cronId}" (dir age: ${Math.round(dirAge)}ms)`);
    }

    // Old enough with no valid meta — treat as corrupt/orphaned.
    await fs.rm(lockPath, { recursive: true, force: true });
  } else {
    // Valid meta — check PID liveness + startTime.
    const alive = isPidAlive(existingMeta.pid);
    if (alive) {
      // PID is alive — check startTime to detect PID reuse.
      const existingStartTime = await getProcessStartTime(existingMeta.pid);
      const metaHasStartTime = existingMeta.startTime != null;
      const procHasStartTime = existingStartTime != null;

      if (metaHasStartTime && procHasStartTime && existingMeta.startTime !== existingStartTime) {
        // PID was reused — stale lock.
        await fs.rm(lockPath, { recursive: true, force: true });
      } else {
        // PID alive and startTime matches (or unavailable on one/both sides) — lock is held.
        throw new Error(`Lock held by PID ${existingMeta.pid} for "${cronId}"`);
      }
    } else {
      // PID is dead — stale lock.
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  // Attempt 2: retry mkdir after removing stale lock.
  try {
    await fs.mkdir(lockPath);
    await writeMeta(lockPath, meta);
    return token;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Lock contention for "${cronId}" (lost race on retry)`);
    }
    throw err;
  }
}

/**
 * Release a file-based lock for a cron job.
 * Only removes the lock if the token matches (prevents one process from
 * releasing another's lock). Silent on mismatch or missing lock.
 */
export async function releaseCronLock(lockDir: string, cronId: string, token: string): Promise<void> {
  const lockName = safeCronId(cronId);
  const lockPath = path.join(lockDir, lockName + '.lock');

  const meta = await readMeta(lockPath);
  if (!meta) return; // Lock dir missing or meta unreadable — nothing to do.

  if (meta.token === token) {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
  // Token mismatch — another process owns it; leave it alone.
}
