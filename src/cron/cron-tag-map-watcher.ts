import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CronSyncCoordinator } from './cron-sync-coordinator.js';
import type { LoggerLike } from '../discord/action-types.js';

export type CronTagMapWatcherOptions = {
  coordinator: CronSyncCoordinator;
  tagMapPath: string;
  log?: LoggerLike;
  debounceMs?: number;       // default 2000
  pollFallbackMs?: number;   // default 30000
};

export type CronTagMapWatcherHandle = {
  stop(): void;
};

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_POLL_FALLBACK_MS = 30_000;
const DIR_POLL_MS = 30_000;

/**
 * Watch tag-map.json for changes and trigger coordinator.sync() on change.
 * Mirrors the tag-map watching portion of TaskSyncWatcher but triggers a
 * full coordinator sync (reload + runCronSync) instead of just a reload.
 *
 * Uses fs.watch on the parent directory (atomic-write safe) with a stat-based
 * polling fallback for platforms where fs.watch is unreliable.
 * If the parent directory doesn't exist yet, polls until it appears.
 */
export function startCronTagMapWatcher(opts: CronTagMapWatcherOptions): CronTagMapWatcherHandle {
  const { coordinator, tagMapPath, log } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollFallbackMs = opts.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS;
  const tagMapDir = path.dirname(tagMapPath);
  const tagMapBase = path.basename(tagMapPath);

  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let dirPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMtimeMs = 0;
  let mtimeSeeded = false;

  function clearDebounce(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function scheduleDebouncedSync(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (stopped) return;
      coordinator.sync().catch((err) => {
        log?.warn({ err }, 'cron:tag-map-watcher sync failed');
      });
    }, debounceMs);
  }

  function startWatching(): void {
    // Primary: fs.watch on parent directory, filtered by basename
    try {
      watcher = fs.watch(tagMapDir, (_eventType, filename) => {
        if (stopped) return;
        if (filename === tagMapBase) {
          scheduleDebouncedSync();
        }
      });
      watcher.on('error', (err) => {
        log?.warn({ err }, 'cron:tag-map-watcher fs.watch error; polling fallback continues');
      });
    } catch {
      // fs.watch not available — polling alone.
    }

    // Seed initial mtime before starting poll to avoid spurious first-poll trigger
    fsp.stat(tagMapPath).then((s) => {
      lastMtimeMs = s.mtimeMs;
    }).catch(() => {}).finally(() => { mtimeSeeded = true; });

    // Polling fallback: check stat.mtimeMs
    pollTimer = setInterval(async () => {
      if (stopped || !mtimeSeeded) return;
      try {
        const s = await fsp.stat(tagMapPath);
        if (s.mtimeMs > lastMtimeMs) {
          lastMtimeMs = s.mtimeMs;
          scheduleDebouncedSync();
        }
      } catch {
        // stat failed — ignore.
      }
    }, pollFallbackMs);
  }

  // If parent directory exists, start watching immediately.
  // Otherwise, poll until it appears.
  fsp.access(tagMapDir).then(() => {
    if (!stopped) startWatching();
  }).catch(() => {
    // Directory doesn't exist yet — poll for it.
    dirPollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        await fsp.access(tagMapDir);
        // Directory appeared — start watching and stop polling.
        if (dirPollTimer) {
          clearInterval(dirPollTimer);
          dirPollTimer = null;
        }
        if (!stopped) startWatching();
      } catch {
        // Still doesn't exist — keep polling.
      }
    }, DIR_POLL_MS);
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearDebounce();
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (dirPollTimer) {
        clearInterval(dirPollTimer);
        dirPollTimer = null;
      }
    },
  };
}
