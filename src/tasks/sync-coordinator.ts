import { BeadSyncCoordinator } from '../beads/bead-sync-coordinator.js';
import type { CoordinatorOptions } from '../beads/bead-sync-coordinator.js';

/**
 * Canonical task-named sync coordinator export.
 * Legacy beads-named coordinator remains as a compatibility alias.
 */
export class TaskSyncCoordinator extends BeadSyncCoordinator {}

export type TaskSyncCoordinatorOptions = CoordinatorOptions;
