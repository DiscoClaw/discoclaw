import type { TaskData } from './types.js';
import { getThreadIdFromTask } from './discord-sync.js';

export type TaskSyncNormalizedBuckets = {
  tasksMissingRef: TaskData[];
  needsBlockedTasks: TaskData[];
  tasksWithRef: TaskData[];
  closedTasks: TaskData[];
};

export type TaskSyncOperationPhase = 'phase1' | 'phase2' | 'phase3' | 'phase4';

export type TaskSyncOperation = {
  phase: TaskSyncOperationPhase;
  taskId: string;
  key: string;
};

function hasLabel(task: TaskData, label: string): boolean {
  return (task.labels ?? []).includes(label);
}

function operationKey(phase: TaskSyncOperationPhase, taskId: string): string {
  return `task-sync:${phase}:${taskId}`;
}

/**
 * Stage: ingest
 * Copy list shape while preserving task object references.
 */
export function ingestTaskSyncSnapshot(allTasks: TaskData[]): TaskData[] {
  return [...allTasks];
}

/**
 * Stage: normalize
 * Split tasks into deterministic phase buckets from the ingested snapshot.
 */
export function normalizeTaskSyncBuckets(allTasks: TaskData[]): TaskSyncNormalizedBuckets {
  const tasksMissingRef = allTasks.filter((task) =>
    !getThreadIdFromTask(task) &&
    task.status !== 'closed' &&
    !hasLabel(task, 'no-thread'),
  );

  const needsBlockedTasks = allTasks.filter((task) =>
    task.status === 'open' && (task.labels ?? []).some((l) => /^(waiting|blocked)-/.test(l)),
  );

  const tasksWithRef = allTasks.filter((task) => getThreadIdFromTask(task) && task.status !== 'closed');

  const closedTasks = allTasks.filter((task) =>
    task.status === 'closed' && Boolean(getThreadIdFromTask(task)),
  );

  return { tasksMissingRef, needsBlockedTasks, tasksWithRef, closedTasks };
}

/**
 * Stage: diff
 * Build an idempotent operation plan from normalized buckets.
 */
export function planTaskSyncOperations(buckets: TaskSyncNormalizedBuckets): TaskSyncOperation[] {
  const operations: TaskSyncOperation[] = [];
  const seen = new Set<string>();

  const pushOps = (phase: TaskSyncOperationPhase, tasks: TaskData[]) => {
    for (const task of tasks) {
      const key = operationKey(phase, task.id);
      if (seen.has(key)) continue;
      seen.add(key);
      operations.push({ phase, taskId: task.id, key });
    }
  };

  pushOps('phase1', buckets.tasksMissingRef);
  pushOps('phase2', buckets.needsBlockedTasks);
  pushOps('phase3', buckets.tasksWithRef);
  pushOps('phase4', buckets.closedTasks);

  return operations;
}

export function operationTaskIdSet(
  operations: TaskSyncOperation[],
  phase: TaskSyncOperationPhase,
): Set<string> {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (operation.phase === phase) ids.add(operation.taskId);
  }
  return ids;
}

/**
 * Stage: apply dispatch
 * Ordered task IDs for a given phase, preserving diff-plan sequence.
 */
export function operationTaskIdList(
  operations: TaskSyncOperation[],
  phase: TaskSyncOperationPhase,
): string[] {
  const ids: string[] = [];
  for (const operation of operations) {
    if (operation.phase === phase) ids.push(operation.taskId);
  }
  return ids;
}

export type TaskSyncApplyPhasePlan = {
  phase: TaskSyncOperationPhase;
  taskIds: string[];
};

const DEFAULT_PHASE_ORDER: TaskSyncOperationPhase[] = ['phase1', 'phase2', 'phase3', 'phase4'];

/**
 * Stage: apply plan
 * Build ordered phase dispatch inputs directly from diff-plan operations.
 */
export function planTaskApplyPhases(
  operations: TaskSyncOperation[],
  phaseOrder: TaskSyncOperationPhase[] = DEFAULT_PHASE_ORDER,
): TaskSyncApplyPhasePlan[] {
  const phases: TaskSyncApplyPhasePlan[] = [];
  for (const phase of phaseOrder) {
    phases.push({
      phase,
      taskIds: operationTaskIdList(operations, phase),
    });
  }
  return phases;
}

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
  shortIdFromThreadName: (threadName: string) => string | null;
  threadIdFromTask: (task: TaskData) => string | null;
};

/**
 * Stage: diff (phase 5)
 * Plan reconciliation operations for forum threads vs local task snapshot.
 */
export function planTaskReconcileOperations(opts: TaskReconcilePlanOptions): TaskReconcileOperation[] {
  const operations: TaskReconcileOperation[] = [];

  for (const thread of opts.threads) {
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
