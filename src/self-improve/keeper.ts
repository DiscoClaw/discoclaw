// ── Score keeper / promoter ─────────────────────────────────────────
//
// Manages a JSON ledger tracking the best score for an instruction
// file. When a mutation improves the score, `promote` atomically
// replaces the instruction file with the mutated text.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Ledger } from './types.js';

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
 */
export async function promote(
  targetPath: string,
  mutatedText: string,
  ledgerPath: string,
  score: number,
): Promise<Ledger> {
  const dir = dirname(targetPath);
  const tmpName = `.self-improve-staging-${randomBytes(6).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  // Write mutated text to a staging temp file, then atomic rename.
  await writeFile(tmpPath, mutatedText, 'utf-8');
  await rename(tmpPath, targetPath);

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
