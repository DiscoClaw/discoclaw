import type { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { TaskStore } from '../tasks/store.js';

export type BeadSyncWatcherOptions = {
  coordinator: BeadSyncCoordinator;
  store: TaskStore;
  log?: LoggerLike;
};

export type BeadSyncWatcherHandle = {
  stop(): void;
};

/**
 * Subscribe to TaskStore mutation events and trigger coordinator.sync() on
 * each write. Replaces the former fs.watch-based file watcher.
 *
 * Concurrency is handled by BeadSyncCoordinator's internal guard — concurrent
 * syncs are coalesced into a follow-up run, so there is no need for a debounce.
 */
export function startBeadSyncWatcher(opts: BeadSyncWatcherOptions): BeadSyncWatcherHandle {
  const { coordinator, store, log } = opts;

  const triggerSync = () => {
    coordinator.sync().catch((err) => {
      log?.warn({ err }, 'beads:watcher sync failed');
    });
  };

  store.on('created', triggerSync);
  store.on('updated', triggerSync);
  store.on('closed', triggerSync);
  store.on('labeled', triggerSync);

  return {
    stop(): void {
      store.off('created', triggerSync);
      store.off('updated', triggerSync);
      store.off('closed', triggerSync);
      store.off('labeled', triggerSync);
    },
  };
}
