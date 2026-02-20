// ---------------------------------------------------------------------------
// Task store types — in-process task data model.
// Replaces the external `bd` CLI dependency for the read/write path.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'closed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

export type TaskData = {
  id: string;
  title: string;
  status: TaskStatus;

  description?: string;
  priority?: number;
  issue_type?: string;
  owner?: string;
  external_ref?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; created_at: string }>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
};

export type TaskCreateParams = {
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  owner?: string;
  labels?: string[];
};

export type TaskUpdateParams = {
  title?: string;
  description?: string;
  priority?: number;
  status?: TaskStatus;
  owner?: string;
  externalRef?: string;
};

export type TaskListParams = {
  status?: string;
  label?: string;
  limit?: number;
};

export type TaskCloseParams = {
  reason?: string;
};

export type TaskSyncResult = {
  threadsCreated: number;
  emojisUpdated: number;
  starterMessagesUpdated: number;
  threadsArchived: number;
  statusesUpdated: number;
  tagsUpdated: number;
  warnings: number;
  /** Threads archived because their task was closed but the thread wasn't archived. */
  threadsReconciled?: number;
  /** Threads whose [NNN] token didn't match any local task. */
  orphanThreadsFound?: number;
  /** Thread closures skipped because an in-flight reply was active in that thread. */
  closesDeferred?: number;
};

/** Tag name → Discord forum tag ID. */
export type TagMap = Record<string, string>;

/** Status → emoji prefix for thread names. Widened to Record<string, string> for consumers that index with a plain string. */
export const STATUS_EMOJI: Record<string, string> = {
  open: '\u{1F7E2}',        // 🟢
  in_progress: '\u{1F7E1}', // 🟡
  blocked: '\u26A0\uFE0F',  // ⚠️
  closed: '\u2611\uFE0F',   // ☑️
};

// ---------------------------------------------------------------------------
// Legacy compatibility aliases (remove in Phase 5 hard-cut).
// Mirrors what src/beads/types.ts re-exports so consumers can be rewired to
// src/tasks/types.ts without a symbol rename.
// ---------------------------------------------------------------------------

export type BeadStatus = TaskStatus;
export type BeadData = TaskData;
export type BeadSyncResult = TaskSyncResult;
export type BeadCreateParams = TaskCreateParams;
export type BeadUpdateParams = TaskUpdateParams;
export type BeadCloseParams = TaskCloseParams;
export type BeadListParams = TaskListParams;

export const BEAD_STATUSES = TASK_STATUSES;
export const isBeadStatus = isTaskStatus;
