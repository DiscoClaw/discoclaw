// ── Score keeper / promoter ─────────────────────────────────────────
//
// Manages a JSON ledger tracking the best score for an instruction
// file. When a mutation improves the score, `promote` atomically
// replaces the instruction file with the mutated text.
//
// Also tracks in-flight staging files so they can be cleaned up if
// the process is interrupted (SIGINT / SIGTERM).

import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Ledger } from './types.js';

const STAGING_PREFIX = '.self-improve-staging-';

// ── Staging file tracking ───────────────────────────────────────────

/** Paths of staging temp files currently in flight. */
const activeStagingFiles = new Set<string>();

/**
 * Remove all tracked staging temp files that still exist on disk.
 * Safe to call multiple times — silently ignores already-removed files.
 */
export async function cleanupStagingFiles(): Promise<void> {
  const paths = [...activeStagingFiles];
  activeStagingFiles.clear();
  await Promise.all(
    paths.map((p) => unlink(p).catch(() => { /* already gone */ })),
  );
}

/**
 * Scan a directory for orphaned staging files from prior interrupted
 * runs and remove them.
 */
export async function cleanupOrphanedStagingFiles(dir: string): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith(STAGING_PREFIX)) {
        await unlink(join(dir, entry)).catch(() => {});
        removed++;
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable — nothing to clean.
  }
  return removed;
}

// ── Ledger I/O ──────────────────────────────────────────────────────

/** Load an existing ledger from disk, or return a default (score 0). */
export async function loadLedger(path: string): Promise<Ledger> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Ledger).bestScore === 'number' &&
      typeof (parsed as Ledger).iteration === 'number' &&
      typeof (parsed as Ledger).promotedAt === 'string'
    ) {
      return parsed as Ledger;
    }
    throw new Error(`Invalid ledger schema at ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bestScore: 0, iteration: 0, promotedAt: '' };
    }
    throw err;
  }
}

/** Write the ledger to disk (pretty-printed for auditability). */
export async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  await writeFile(path, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
}

// ── Promotion logic ─────────────────────────────────────────────────

/** Returns true when the candidate score strictly improves on the current best. */
export function shouldPromote(current: Ledger, candidate: number): boolean {
  return candidate > current.bestScore;
}

/**
 * Atomically replace `targetPath` with `mutatedText` and update the ledger.
 *
 * Writes to a staging temp file adjacent to the target, then does an
 * atomic `rename` to replace it. This avoids partial-write corruption.
 * The staging file is tracked so it can be cleaned up on interruption.
 */
export async function promote(
  targetPath: string,
  mutatedText: string,
  ledgerPath: string,
  score: number,
): Promise<Ledger> {
  const dir = dirname(targetPath);
  const tmpName = `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  // Track the staging file so cleanup can remove it on interrupt.
  activeStagingFiles.add(tmpPath);

  try {
    // Write mutated text to a staging temp file, then atomic rename.
    await writeFile(tmpPath, mutatedText, 'utf-8');
    await rename(tmpPath, targetPath);
  } finally {
    // No longer in-flight (renamed or failed).
    activeStagingFiles.delete(tmpPath);
  }

  // Update ledger.
  const ledger = await loadLedger(ledgerPath);
  const updated: Ledger = {
    bestScore: score,
    iteration: ledger.iteration + 1,
    promotedAt: new Date().toISOString(),
  };
  await saveLedger(ledgerPath, updated);

  return updated;
}
