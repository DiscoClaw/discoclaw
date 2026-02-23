import fs from 'node:fs/promises';
import type { CronRunStats } from '../cron/run-stats.js';
import type { TaskStore } from '../tasks/store.js';
import type { LoggerLike } from '../logging/logger-like.js';

// Minimal Discord client interface needed for startup healing checks.
type ChannelClient = {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
};

type DiscordFetchErrorLike = {
  code?: unknown;
  status?: unknown;
  httpStatus?: unknown;
};

function discordFetchErrorMeta(err: unknown): { code: number | null; status: number | null } {
  if (!err || typeof err !== 'object') return { code: null, status: null };
  const errorLike = err as DiscordFetchErrorLike;
  const code = typeof errorLike.code === 'number' ? errorLike.code : null;
  const statusCandidate = errorLike.status ?? errorLike.httpStatus;
  const status = typeof statusCandidate === 'number' ? statusCandidate : null;
  return { code, status };
}

function isDeletedDiscordChannelError(err: unknown): boolean {
  const { code, status } = discordFetchErrorMeta(err);
  return code === 10003 || status === 404;
}

/**
 * Scenario 2: Remove stale cron run-stats records for threads that no longer exist.
 *
 * Iterates all records in the persistent stats store. For each record, attempts
 * to fetch the Discord thread. If the thread is gone (null return or Discord
 * error code 10003 / HTTP 404), removes the record via `statsStore.removeByThreadId()`
 * and logs a structured warning.
 *
 * Non-404 errors (network failures, rate-limits, etc.) are treated as transient:
 * the record is preserved and a fetch-error warning is logged instead.
 *
 * All remove-path errors are caught and logged (fail-open) to prevent healing
 * from becoming a startup crash path.
 */
export async function healStaleCronRecords(
  statsStore: CronRunStats,
  client: ChannelClient,
  log?: LoggerLike,
): Promise<void> {
  const jobs = Object.values(statsStore.getStore().jobs);
  for (const record of jobs) {
    const { cronId, threadId } = record;

    let threadGone = false;
    try {
      const channel = await client.channels.fetch(threadId);
      if (channel === null || channel === undefined) {
        threadGone = true;
      }
    } catch (err: unknown) {
      // Treat Discord "Unknown Channel" (code 10003) or HTTP 404 as definitely gone.
      // Any other error is treated as transient — skip to avoid purging live records.
      if (isDeletedDiscordChannelError(err)) {
        threadGone = true;
      } else {
        log?.warn(
          { cronId, threadId, err: err instanceof Error ? err.message : String(err) },
          'startup:heal:cron fetch error — skipping record',
        );
        continue;
      }
    }

    if (!threadGone) continue;

    try {
      await statsStore.removeByThreadId(threadId);
      log?.warn(
        { cronId, threadId },
        'startup:heal:cron removed stale stats record for deleted thread',
      );
    } catch (err: unknown) {
      log?.warn(
        { cronId, threadId, err: err instanceof Error ? err.message : String(err) },
        'startup:heal:cron failed to remove stale stats record — continuing',
      );
    }
  }
}

/**
 * Scenario 3: Surface stale task thread references for deleted Discord threads.
 *
 * Iterates non-closed tasks with an `external_ref` of the form `discord:<threadId>`.
 * If the thread no longer exists (null return or Discord 10003/404), logs a structured
 * warning. Does NOT modify `external_ref` — the next task sync run may recreate the
 * thread and re-link it.
 *
 * Non-404 errors are logged as a separate fetch-error warning and skipped.
 * Never throws; all errors are caught and logged.
 */
export async function healStaleTaskThreadRefs(
  store: TaskStore,
  client: ChannelClient,
  log?: LoggerLike,
): Promise<void> {
  const tasks = store.list(); // excludes closed tasks by default
  for (const task of tasks) {
    const ref = task.external_ref;
    if (!ref?.startsWith('discord:')) continue;

    const threadId = ref.slice('discord:'.length);
    if (!threadId) continue;

    try {
      const channel = await client.channels.fetch(threadId);
      if (channel === null || channel === undefined) {
        log?.warn(
          { taskId: task.id, threadId },
          'startup:heal:task thread no longer exists (external_ref retained for next sync)',
        );
      }
    } catch (err: unknown) {
      if (isDeletedDiscordChannelError(err)) {
        log?.warn(
          { taskId: task.id, threadId },
          'startup:heal:task thread no longer exists (external_ref retained for next sync)',
        );
      } else {
        log?.warn(
          { taskId: task.id, threadId, err: err instanceof Error ? err.message : String(err) },
          'startup:heal:task thread fetch error — skipping',
        );
      }
    }
  }
}

/**
 * Scenario 4: Back up and remove corrupted JSON store files before they are loaded.
 *
 * For each `{ path, label }` entry: reads the file, attempts `JSON.parse`, and
 * on failure copies the corrupted file to `<path>.corrupt.<ISO-timestamp>` then
 * removes the original. Downstream loaders all handle missing files gracefully,
 * so the net effect is a safe reset.
 *
 * - ENOENT (file not found) is not corruption — those entries are silently skipped.
 * - Unreadable files (non-ENOENT) are warned and skipped.
 * - Backup/remove failures are logged and skipped (fail-open).
 */
export async function healCorruptedJsonStores(
  paths: Array<{ path: string; label: string }>,
  log?: LoggerLike,
): Promise<void> {
  for (const { path: filePath, label } of paths) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // Not corruption.
      log?.warn(
        { label, path: filePath, err: err instanceof Error ? err.message : String(err) },
        'startup:heal:json unreadable — skipping',
      );
      continue;
    }

    try {
      JSON.parse(raw);
      // Valid JSON — nothing to do.
    } catch (parseErr: unknown) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filePath}.corrupt.${timestamp}`;
      try {
        await fs.copyFile(filePath, backupPath);
        await fs.unlink(filePath);
        log?.warn(
          {
            label,
            path: filePath,
            backupPath,
            parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
          },
          'startup:heal:json corrupted — backed up and removed',
        );
      } catch (fsErr: unknown) {
        log?.warn(
          {
            label,
            path: filePath,
            err: fsErr instanceof Error ? fsErr.message : String(fsErr),
          },
          'startup:heal:json backup/remove failed — leaving file in place',
        );
      }
    }
  }
}
