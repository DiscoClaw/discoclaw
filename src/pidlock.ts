import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type PidLockMeta = {
  pid: number;
  token: string;
  acquiredAt: string;
  startTime?: number;
};

/** Lock dirs younger than this with missing/corrupt metadata are treated as initializing. */
const GRACE_PERIOD_MS = 2000;

const heldLocks = new Map<string, string>();

function lockDirPath(lockPath: string): string {
  return `${lockPath}.lock`;
}

function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Read Linux process start time from /proc/{pid}/stat (field 22).
 * Returns null on non-Linux or any read/parse failure.
 */
async function getProcessStartTime(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    const closeParenIdx = stat.lastIndexOf(')');
    if (closeParenIdx === -1) return null;
    const fields = stat.slice(closeParenIdx + 2).split(' ');
    const startTime = Number(fields[19]);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function readMeta(dirPath: string): Promise<PidLockMeta | null> {
  try {
    const raw = await fs.readFile(path.join(dirPath, 'meta.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid !== 'number' || typeof parsed?.token !== 'string') return null;
    return parsed as PidLockMeta;
  } catch {
    return null;
  }
}

async function writeMeta(dirPath: string, meta: PidLockMeta): Promise<void> {
  const metaPath = path.join(dirPath, 'meta.json');
  const tmpPath = `${metaPath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(meta) + '\n', 'utf-8');
  await fs.rename(tmpPath, metaPath);
}

async function handleLegacyLockFile(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (!stat.isFile()) return;

    let pid = NaN;
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      pid = Number(content.trim());
    } catch {
      // Treat unreadable legacy files as stale.
    }

    if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
      throw new Error(
        `Another discoclaw instance is already running (PID ${pid}). ` +
          `Legacy lock file: ${lockPath}`,
      );
    }

    await fs.rm(lockPath, { force: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Acquire a PID lock directory. Throws if another live process holds the lock.
 */
export async function acquirePidLock(lockPath: string): Promise<void> {
  await handleLegacyLockFile(lockPath);

  const dirPath = lockDirPath(lockPath);
  const token = generateToken();
  const startTime = await getProcessStartTime(process.pid);
  const meta: PidLockMeta = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    ...(startTime != null ? { startTime } : {}),
  };

  // Attempt 1: atomic directory create.
  try {
    await fs.mkdir(dirPath);
    await writeMeta(dirPath, meta);
    heldLocks.set(dirPath, token);
    return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Existing lock — determine if stale or held.
  const existingMeta = await readMeta(dirPath);
  if (!existingMeta) {
    let dirAge = Infinity;
    try {
      const stat = await fs.stat(dirPath);
      dirAge = Date.now() - stat.mtimeMs;
    } catch {
      // Can't stat: treat as stale.
    }

    if (dirAge < GRACE_PERIOD_MS) {
      throw new Error(`PID lock initializing (dir age: ${Math.round(dirAge)}ms). Lock dir: ${dirPath}`);
    }

    await fs.rm(dirPath, { recursive: true, force: true });
  } else {
    const alive = isPidAlive(existingMeta.pid);
    if (alive) {
      const existingStartTime = await getProcessStartTime(existingMeta.pid);
      const metaHasStartTime = existingMeta.startTime != null;
      const procHasStartTime = existingStartTime != null;

      if (metaHasStartTime && procHasStartTime && existingMeta.startTime !== existingStartTime) {
        // PID reuse — stale lock.
        await fs.rm(dirPath, { recursive: true, force: true });
      } else {
        throw new Error(
          `Another discoclaw instance is already running (PID ${existingMeta.pid}). ` +
            `Lock dir: ${dirPath}`,
        );
      }
    } else {
      // Dead PID — stale lock.
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  }

  // Attempt 2: retry after stale cleanup.
  try {
    await fs.mkdir(dirPath);
    await writeMeta(dirPath, meta);
    heldLocks.set(dirPath, token);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`PID lock contention (lost race). Lock dir: ${dirPath}`);
    }
    throw err;
  }
}

/**
 * Release the PID lock directory, but only if it's owned by this process token.
 */
export async function releasePidLock(lockPath: string): Promise<void> {
  const dirPath = lockDirPath(lockPath);
  const heldToken = heldLocks.get(dirPath);
  try {
    const meta = await readMeta(dirPath);
    if (!meta) return;

    if (heldToken) {
      if (meta.token === heldToken) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
      return;
    }

    // Fallback path: best-effort cleanup for older call sites.
    if (meta.pid === process.pid) {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Lock dir already gone or unreadable — nothing to do.
  } finally {
    heldLocks.delete(dirPath);
  }
}
