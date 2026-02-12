import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { TagMap } from './types.js';
import { reloadTagMapInPlace } from './discord-sync.js';

export type BeadSyncWatcherOptions = {
  coordinator: BeadSyncCoordinator;
  beadsCwd: string;
  log?: LoggerLike;
  debounceMs?: number;      // default 2000
  pollFallbackMs?: number;  // default 30000
  tagMapPath?: string;
  tagMap?: TagMap;
};

export type BeadSyncWatcherHandle = {
  stop(): void;
};

const WATCH_FILES = new Set(['last-touched', 'issues.jsonl']);
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_POLL_FALLBACK_MS = 30_000;
const DIR_POLL_MS = 30_000;

/**
 * Watch the .beads/ directory for changes to last-touched or issues.jsonl.
 * Triggers coordinator.sync() (without statusPoster) on changes.
 *
 * Watches both files because the bd daemon writes mutations to issues.jsonl
 * but does not always update last-touched.
 *
 * Uses fs.watch on the directory for primary detection with a stat-based
 * polling fallback for platforms where fs.watch is unreliable.
 * If the .beads/ directory doesn't exist yet, polls until it appears.
 *
 * Optionally watches tag-map.json for changes (separate debounce pipeline).
 * Tag-map changes only reload the in-memory map; they do not trigger sync.
 */
export function startBeadSyncWatcher(opts: BeadSyncWatcherOptions): BeadSyncWatcherHandle {
  const { coordinator, beadsCwd, log } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollFallbackMs = opts.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS;
  const beadsDir = path.join(beadsCwd, '.beads');
  const watchPaths = [...WATCH_FILES].map((f) => path.join(beadsDir, f));

  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let dirPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMtimeMs = 0;
  let mtimeSeeded = false;

  // Tag-map watcher state (separate pipeline)
  let tagMapWatcher: fs.FSWatcher | null = null;
  let tagMapDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let tagMapPollTimer: ReturnType<typeof setInterval> | null = null;
  let tagMapDirPollTimer: ReturnType<typeof setInterval> | null = null;
  let tagMapLastMtimeMs = 0;
  let tagMapMtimeSeeded = false;

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
      coordinator.sync(undefined, 'watcher').catch((err) => {
        log?.warn({ err }, 'beads:watcher sync failed');
      });
    }, debounceMs);
  }

  function startWatching(): void {
    // Primary: fs.watch on the directory
    try {
      watcher = fs.watch(beadsDir, (_eventType, filename) => {
        if (filename && WATCH_FILES.has(filename)) {
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
    Promise.all(watchPaths.map((p) => fsp.stat(p).catch(() => null)))
      .then((stats) => {
        for (const s of stats) {
          if (s && s.mtimeMs > lastMtimeMs) lastMtimeMs = s.mtimeMs;
        }
      })
      .catch(() => {})
      .finally(() => { mtimeSeeded = true; });

    // Polling fallback: check stat.mtimeMs on watched files
    pollTimer = setInterval(async () => {
      if (stopped || !mtimeSeeded) return;
      try {
        const stats = await Promise.all(
          watchPaths.map((p) => fsp.stat(p).catch(() => null)),
        );
        const maxMtime = Math.max(
          ...stats.map((s) => s?.mtimeMs ?? 0),
        );
        if (maxMtime > lastMtimeMs) {
          lastMtimeMs = maxMtime;
          scheduleDebouncedSync();
        }
      } catch {
        // stat failed — ignore.
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

  // ---------------------------------------------------------------------------
  // Tag-map watching (separate pipeline — reload only, no sync)
  // ---------------------------------------------------------------------------

  const tagMapPath = opts.tagMapPath;
  const tagMap = opts.tagMap;

  if (tagMapPath && tagMap) {
    const tagMapDir = path.dirname(tagMapPath);
    const tagMapBase = path.basename(tagMapPath);

    function clearTagMapDebounce(): void {
      if (tagMapDebounceTimer) {
        clearTimeout(tagMapDebounceTimer);
        tagMapDebounceTimer = null;
      }
    }

    function scheduleDebouncedTagMapReload(): void {
      clearTagMapDebounce();
      tagMapDebounceTimer = setTimeout(() => {
        tagMapDebounceTimer = null;
        reloadTagMapInPlace(tagMapPath!, tagMap!).catch((err) => {
          log?.warn({ err, tagMapPath }, 'beads:tag-map watcher reload failed; using cached map');
        });
      }, debounceMs);
    }

    function startTagMapWatching(): void {
      // Primary: fs.watch on parent directory, filtered by basename
      try {
        tagMapWatcher = fs.watch(tagMapDir, (_eventType, filename) => {
          if (filename === tagMapBase) {
            scheduleDebouncedTagMapReload();
          }
        });
        tagMapWatcher.on('error', (err) => {
          log?.warn({ err }, 'beads:tag-map watcher fs.watch error; polling fallback continues');
        });
      } catch {
        // fs.watch not available — polling alone.
      }

      // Seed initial mtime before starting poll to prevent first-poll false positive.
      fsp.stat(tagMapPath!).then((s) => {
        tagMapLastMtimeMs = s.mtimeMs;
      }).catch(() => {}).finally(() => { tagMapMtimeSeeded = true; });

      // Polling fallback
      tagMapPollTimer = setInterval(async () => {
        if (stopped || !tagMapMtimeSeeded) return;
        try {
          const s = await fsp.stat(tagMapPath!);
          if (s.mtimeMs > tagMapLastMtimeMs) {
            tagMapLastMtimeMs = s.mtimeMs;
            scheduleDebouncedTagMapReload();
          }
        } catch {
          // stat failed — ignore.
        }
      }, pollFallbackMs);
    }

    // Start tag-map watching independently of .beads/ directory
    fsp.access(tagMapDir).then(() => {
      if (!stopped) startTagMapWatching();
    }).catch(() => {
      // Tag-map directory doesn't exist yet — poll for it.
      tagMapDirPollTimer = setInterval(async () => {
        if (stopped) return;
        try {
          await fsp.access(tagMapDir);
          if (tagMapDirPollTimer) {
            clearInterval(tagMapDirPollTimer);
            tagMapDirPollTimer = null;
          }
          if (!stopped) startTagMapWatching();
        } catch {
          // Still doesn't exist — keep polling.
        }
      }, DIR_POLL_MS);
    });
  } else if (tagMapPath && !tagMap) {
    log?.warn('beads:tag-map watcher: tagMapPath provided without tagMap; skipping tag-map watching');
  }

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
      // Clean up tag-map watchers
      if (tagMapDebounceTimer) {
        clearTimeout(tagMapDebounceTimer);
        tagMapDebounceTimer = null;
      }
      if (tagMapWatcher) {
        tagMapWatcher.close();
        tagMapWatcher = null;
      }
      if (tagMapPollTimer) {
        clearInterval(tagMapPollTimer);
        tagMapPollTimer = null;
      }
      if (tagMapDirPollTimer) {
        clearInterval(tagMapDirPollTimer);
        tagMapDirPollTimer = null;
      }
    },
  };
}
