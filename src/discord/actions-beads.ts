/**
 * Compatibility shim — re-exports Task* symbols under their legacy Bead* names.
 * Consumers: src/beads/initialize.ts, src/index.ts, src/cron/executor.ts,
 *            src/discord/prompt-common.ts, src/discord/message-coordinator.ts
 */
export type {
  TaskContext as BeadContext,
  TaskActionRequest as BeadActionRequest,
} from './actions-tasks.js';
export {
  TASK_ACTION_TYPES as BEAD_ACTION_TYPES,
  executeTaskAction as executeBeadAction,
  taskActionsPromptSection as beadActionsPromptSection,
} from './actions-tasks.js';
