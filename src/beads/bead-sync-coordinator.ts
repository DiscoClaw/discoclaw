import {
  TaskSyncCoordinator,
  type TaskSyncCoordinatorOptions,
} from '../tasks/sync-coordinator.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/sync-coordinator.ts`.
 */
export type CoordinatorOptions = TaskSyncCoordinatorOptions;
export class BeadSyncCoordinator extends TaskSyncCoordinator {}

export { TaskSyncCoordinator };
