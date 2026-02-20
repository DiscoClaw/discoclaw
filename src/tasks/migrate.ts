import fs from 'node:fs/promises';
import { bdList } from './bd-cli.js';
import type { TaskData } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrateOptions = {
  /** bd workspace CWD (passed to bdList). */
  cwd: string;
  /** Absolute path to write the JSONL output. Overwrites if already exists. */
  destPath: string;
};

export type MigrateResult = {
  /** Number of tasks written to destPath. */
  migrated: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write an array of TaskData records to a JSONL file (one JSON object per line).
 * Exported separately so tests can exercise the write path without a live bd install.
 */
export async function writeJsonl(destPath: string, tasks: TaskData[]): Promise<void> {
  const lines = tasks.map((b) => JSON.stringify(b)).join('\n');
  await fs.writeFile(destPath, lines ? lines + '\n' : '', 'utf8');
}

// ---------------------------------------------------------------------------
// Migration entry point
// ---------------------------------------------------------------------------

/**
 * One-shot migration: reads **all** tasks from the bd CLI (all statuses, no
 * limit) and writes them as JSONL to `destPath` so that `TaskStore.load()`
 * can consume them.
 *
 * The output file is a full replacement — any existing content is overwritten.
 * After migration, create a `TaskStore` with `persistPath: destPath` and call
 * `await store.load()` to make the data available in-process.
 */
export async function migrateFromBd(opts: MigrateOptions): Promise<MigrateResult> {
  const tasks = await bdList({ status: 'all', limit: 0 }, opts.cwd);
  if (tasks.length === 0) {
    console.warn(
      '[migrate] bd exported zero tasks — if you expected data, check that bd is pointed at the right workspace. Writing empty JSONL.',
    );
  }
  await writeJsonl(opts.destPath, tasks);
  return { migrated: tasks.length };
}
