import {
  runTaskSync,
  type TaskSyncOptions,
  type TaskSyncResult,
} from '../tasks/task-sync-engine.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/task-sync-engine.ts`.
 */
export * from '../tasks/task-sync-engine.js';
export type BeadSyncOptions = TaskSyncOptions;
export type BeadSyncResult = TaskSyncResult;
export const runBeadSync = runTaskSync;
