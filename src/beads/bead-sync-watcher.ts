import {
  startTaskSyncWatcher,
  type TaskSyncWatcherHandle,
  type TaskSyncWatcherOptions,
} from '../tasks/sync-watcher.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/sync-watcher.ts`.
 */
export type BeadSyncWatcherOptions = TaskSyncWatcherOptions;
export type BeadSyncWatcherHandle = TaskSyncWatcherHandle;
export const startBeadSyncWatcher = startTaskSyncWatcher;
