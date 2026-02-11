import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import type { LoggerLike } from '../discord/action-types.js';

export type BeadSyncWatcherOptions = {
  coordinator: BeadSyncCoordinator;
  beadsCwd: string;
  log?: LoggerLike;
  debounceMs?: number;      // default 2000
  pollFallbackMs?: number;  // default 30000
};

export type BeadSyncWatcherHandle = {
  stop(): void;
};

const LAST_TOUCHED = 'last-touched';
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_POLL_FALLBACK_MS = 30_000;
const DIR_POLL_MS = 30_000;

/**
 * Watch the .beads/ directory for changes to last-touched. Triggers
 * coordinator.sync() (without statusPoster) on changes.
 *
 * Uses fs.watch on the directory for primary detection with a stat-based
 * polling fallback for platforms where fs.watch is unreliable.
 * If the .beads/ directory doesn't exist yet, polls until it appears.
 */
export function startBeadSyncWatcher(opts: BeadSyncWatcherOptions): BeadSyncWatcherHandle {
  const { coordinator, beadsCwd, log } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollFallbackMs = opts.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS;
  const beadsDir = path.join(beadsCwd, '.beads');
  const lastTouchedPath = path.join(beadsDir, LAST_TOUCHED);

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
      coordinator.sync().catch((err) => {
        log?.warn({ err }, 'beads:watcher sync failed');
      });
    }, debounceMs);
  }

  function startWatching(): void {
    // Primary: fs.watch on the directory
    try {
      watcher = fs.watch(beadsDir, (_eventType, filename) => {
        if (filename === LAST_TOUCHED) {
          scheduleDebouncedSync();
        }
      });
      watcher.on('error', (err) => {
        log?.warn({ err }, 'beads:watcher fs.watch error; polling fallback continues');
      });
    } catch {
      // fs.watch not available — polling alone.
    }

    // Seed initial mtime before starting poll to avoid spurious first-poll trigger.
    fsp.stat(lastTouchedPath).then((stat) => {
      lastMtimeMs = stat.mtimeMs;
    }).catch(() => {}).finally(() => {
      mtimeSeeded = true;
    });

    // Polling fallback: check stat.mtimeMs on last-touched
    pollTimer = setInterval(async () => {
      if (stopped || !mtimeSeeded) return;
      try {
        const stat = await fsp.stat(lastTouchedPath);
        if (stat.mtimeMs > lastMtimeMs) {
          lastMtimeMs = stat.mtimeMs;
          scheduleDebouncedSync();
        }
      } catch {
        // File doesn't exist yet or stat failed — ignore.
      }
    }, pollFallbackMs);
  }

  // If .beads/ directory exists, start watching immediately.
  // Otherwise, poll until it appears.
  fsp.access(beadsDir).then(() => {
    if (!stopped) startWatching();
  }).catch(() => {
    // Directory doesn't exist yet — poll for it.
    dirPollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        await fsp.access(beadsDir);
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
