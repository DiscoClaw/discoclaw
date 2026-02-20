import {
  initializeTasksContext,
  wireTaskSync,
  type InitializeTasksOpts,
  type InitializeTasksResult,
  type WireTaskSyncOpts,
  type WireTaskSyncResult,
} from '../tasks/initialize.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/initialize.ts`.
 */
export type InitializeBeadsOpts = InitializeTasksOpts;
export type InitializeBeadsResult = InitializeTasksResult;
export type WireBeadsSyncOpts = WireTaskSyncOpts;
export type WireBeadsSyncResult = WireTaskSyncResult;
export const initializeBeadsContext = initializeTasksContext;
export const wireBeadsSync = wireTaskSync;
