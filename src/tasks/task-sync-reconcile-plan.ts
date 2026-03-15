import type { TaskData } from './types.js';

export function buildTasksByShortIdMap(
  allTasks: TaskData[],
  shortIdOf: (taskId: string) => string,
): Map<string, TaskData[]> {
  const tasksByShortId = new Map<string, TaskData[]>();
  for (const task of allTasks) {
    const shortId = shortIdOf(task.id);
    const existing = tasksByShortId.get(shortId);
    if (existing) existing.push(task);
    else tasksByShortId.set(shortId, [task]);
  }
  return tasksByShortId;
}

export function buildTasksByThreadIdMap(
  allTasks: TaskData[],
  threadIdFromTask: (task: TaskData) => string | null,
): Map<string, TaskData[]> {
  const tasksByThreadId = new Map<string, TaskData[]>();
  for (const task of allTasks) {
    const threadId = threadIdFromTask(task);
    if (!threadId) continue;
    const existing = tasksByThreadId.get(threadId);
    if (existing) existing.push(task);
    else tasksByThreadId.set(threadId, [task]);
  }
  return tasksByThreadId;
}

export type TaskThreadSnapshot = {
  id: string;
  name: string;
  archived: boolean;
};

export type TaskThreadLike = {
  id: string | number;
  name?: string | null;
  archived?: boolean | null;
};

/**
 * Stage: ingest (phase 5)
 * Merge archived+active thread sources into a normalized snapshot list.
 * When a thread ID appears in both sources, the active source wins.
 */
export function ingestTaskThreadSnapshots(
  archivedThreads: Iterable<TaskThreadLike>,
  activeThreads: Iterable<TaskThreadLike>,
): TaskThreadSnapshot[] {
  const byThreadId = new Map<string, TaskThreadSnapshot>();

  const push = (thread: TaskThreadLike) => {
    const id = String(thread.id);
    byThreadId.set(id, {
      id,
      name: String(thread.name ?? ''),
      archived: Boolean(thread.archived),
    });
  };

  for (const thread of archivedThreads) push(thread);
  for (const thread of activeThreads) push(thread);

  return [...byThreadId.values()];
}

export type TaskReconcileAction =
  | 'orphan'
  | 'collision'
  | 'skip_external_ref_mismatch'
  | 'archive_active_closed'
  | 'reconcile_archived_closed';

export type TaskReconcileOperation = {
  action: TaskReconcileAction;
  key: string;
  thread: TaskThreadSnapshot;
  shortId: string;
  task?: TaskData;
  collisionCount?: number;
  existingThreadId?: string;
};

export type TaskReconcilePlanOptions = {
  threads: TaskThreadSnapshot[];
  tasksByShortId: Map<string, TaskData[]>;
  tasksByThreadId?: Map<string, TaskData[]>;
  shortIdFromThreadName: (threadName: string) => string | null;
  threadIdFromTask: (task: TaskData) => string | null;
};

export type TaskReconcilePlanFromSnapshotOptions = {
  tasks: TaskData[];
  threads: TaskThreadSnapshot[];
  shortIdOfTaskId: (taskId: string) => string;
  shortIdFromThreadName: (threadName: string) => string | null;
  threadIdFromTask: (task: TaskData) => string | null;
};

export type TaskReconcilePlanFromThreadSourcesOptions = {
  tasks: TaskData[];
  archivedThreads: Iterable<TaskThreadLike>;
  activeThreads: Iterable<TaskThreadLike>;
  shortIdOfTaskId: (taskId: string) => string;
  shortIdFromThreadName: (threadName: string) => string | null;
  threadIdFromTask: (task: TaskData) => string | null;
};

/**
 * Stage: diff (phase 5)
 * Plan reconciliation operations for forum threads vs local task snapshot.
 */
export function planTaskReconcileOperations(opts: TaskReconcilePlanOptions): TaskReconcileOperation[] {
  const operations: TaskReconcileOperation[] = [];
  const tasksByThreadId = opts.tasksByThreadId ?? new Map<string, TaskData[]>();

  for (const thread of opts.threads) {
    const linkedTasks = tasksByThreadId.get(thread.id) ?? [];
    if (linkedTasks.length > 1) {
      operations.push({
        action: 'collision',
        key: `task-sync:phase5:collision:${thread.id}`,
        thread,
        shortId: opts.shortIdFromThreadName(thread.name) ?? '',
        collisionCount: linkedTasks.length,
      });
      continue;
    }

    if (linkedTasks.length === 1) {
      const task = linkedTasks[0]!;
      const existingThreadId = opts.threadIdFromTask(task);
      if (task.status === 'closed' && !thread.archived) {
        operations.push({
          action: 'archive_active_closed',
          key: `task-sync:phase5:archive:${thread.id}`,
          thread,
          shortId: opts.shortIdFromThreadName(thread.name) ?? '',
          task,
          existingThreadId: existingThreadId ?? undefined,
        });
        continue;
      }
      if (task.status === 'closed' && thread.archived) {
        operations.push({
          action: 'reconcile_archived_closed',
          key: `task-sync:phase5:reconcile:${thread.id}`,
          thread,
          shortId: opts.shortIdFromThreadName(thread.name) ?? '',
          task,
          existingThreadId: existingThreadId ?? undefined,
        });
      }
      continue;
    }

    // Fallback for legacy threads missing task external_ref mapping.
    const shortId = opts.shortIdFromThreadName(thread.name);
    if (!shortId) continue;

    const tasks = opts.tasksByShortId.get(shortId);
    if (!tasks || tasks.length === 0) {
      operations.push({
        action: 'orphan',
        key: `task-sync:phase5:orphan:${thread.id}`,
        thread,
        shortId,
      });
      continue;
    }

    if (tasks.length > 1) {
      operations.push({
        action: 'collision',
        key: `task-sync:phase5:collision:${thread.id}`,
        thread,
        shortId,
        collisionCount: tasks.length,
      });
      continue;
    }

    const task = tasks[0]!;
    const existingThreadId = opts.threadIdFromTask(task);
    if (existingThreadId && existingThreadId !== thread.id) {
      operations.push({
        action: 'skip_external_ref_mismatch',
        key: `task-sync:phase5:skip-mismatch:${thread.id}`,
        thread,
        shortId,
        task,
        existingThreadId,
      });
      continue;
    }

    if (task.status === 'closed' && !thread.archived) {
      operations.push({
        action: 'archive_active_closed',
        key: `task-sync:phase5:archive:${thread.id}`,
        thread,
        shortId,
        task,
        existingThreadId: existingThreadId ?? undefined,
      });
      continue;
    }

    if (task.status === 'closed' && thread.archived) {
      operations.push({
        action: 'reconcile_archived_closed',
        key: `task-sync:phase5:reconcile:${thread.id}`,
        thread,
        shortId,
        task,
        existingThreadId: existingThreadId ?? undefined,
      });
    }
  }

  return operations;
}

/**
 * Stage: diff (phase 5)
 * Build phase-5 reconcile operations directly from task+thread snapshots.
 */
export function planTaskReconcileFromSnapshots(
  opts: TaskReconcilePlanFromSnapshotOptions,
): TaskReconcileOperation[] {
  const tasksByShortId = buildTasksByShortIdMap(opts.tasks, opts.shortIdOfTaskId);
  const tasksByThreadId = buildTasksByThreadIdMap(opts.tasks, opts.threadIdFromTask);
  return planTaskReconcileOperations({
    threads: opts.threads,
    tasksByShortId,
    tasksByThreadId,
    shortIdFromThreadName: opts.shortIdFromThreadName,
    threadIdFromTask: opts.threadIdFromTask,
  });
}

/**
 * Stage: diff (phase 5)
 * Compose thread-source ingest + reconcile diff planning.
 */
export function planTaskReconcileFromThreadSources(
  opts: TaskReconcilePlanFromThreadSourcesOptions,
): TaskReconcileOperation[] {
  const threads = ingestTaskThreadSnapshots(opts.archivedThreads, opts.activeThreads);
  return planTaskReconcileFromSnapshots({
    tasks: opts.tasks,
    threads,
    shortIdOfTaskId: opts.shortIdOfTaskId,
    shortIdFromThreadName: opts.shortIdFromThreadName,
    threadIdFromTask: opts.threadIdFromTask,
  });
}
