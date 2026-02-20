import {
  initializeBeadsContext,
  wireBeadsSync,
} from '../beads/initialize.js';
import type {
  InitializeBeadsOpts,
  InitializeBeadsResult,
  WireBeadsSyncOpts,
  WireBeadsSyncResult,
} from '../beads/initialize.js';

/**
 * Canonical task namespace for task-context initialization and sync wiring.
 */
export type InitializeTasksOpts = InitializeBeadsOpts;
export type InitializeTasksResult = InitializeBeadsResult;
export type WireTaskSyncOpts = WireBeadsSyncOpts;
export type WireTaskSyncResult = WireBeadsSyncResult;

export const initializeTasksContext = initializeBeadsContext;
export const wireTaskSync = wireBeadsSync;
