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

/** Status → emoji prefix for thread names. */
export const STATUS_EMOJI: Record<TaskStatus, string> = {
  open: '\u{1F7E2}',        // 🟢
  in_progress: '\u{1F7E1}', // 🟡
  blocked: '\u26A0\uFE0F',  // ⚠️
  closed: '\u2611\uFE0F',   // ☑️
};
