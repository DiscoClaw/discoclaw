// ---------------------------------------------------------------------------
// Re-export shim — canonical types live in src/tasks/types.ts.
// All Bead* names are aliased from their Task* counterparts so existing
// consumers compile unchanged.
// ---------------------------------------------------------------------------

export { TASK_STATUSES as BEAD_STATUSES, isTaskStatus as isBeadStatus } from '../tasks/types.js';

export type {
  TaskStatus as BeadStatus,
  TaskData as BeadData,
  TaskCreateParams as BeadCreateParams,
  TaskUpdateParams as BeadUpdateParams,
  TaskCloseParams as BeadCloseParams,
  TaskListParams as BeadListParams,
  TaskSyncResult as BeadSyncResult,
  TagMap,
} from '../tasks/types.js';

import { STATUS_EMOJI as _STATUS_EMOJI } from '../tasks/types.js';

/** Status → emoji prefix for thread names. Widened to Record<string, string> for consumers that index with a plain string. */
export const STATUS_EMOJI: Record<string, string> = _STATUS_EMOJI;
