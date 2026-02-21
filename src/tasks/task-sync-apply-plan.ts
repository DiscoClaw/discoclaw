import type { TaskData } from './types.js';
import { getThreadIdFromTask } from './thread-helpers.js';

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

export type TaskSyncApplyExecutionPlan = {
  tasksById: Map<string, TaskData>;
  operations: TaskSyncOperation[];
  phasePlans: TaskSyncApplyPhasePlan[];
};

/**
 * Stage: compose (stages 2-4)
 * Build diff operations, phase dispatch plans, and task lookup from a task snapshot.
 */
export function planTaskSyncApplyExecution(allTasks: TaskData[]): TaskSyncApplyExecutionPlan {
  const normalized = normalizeTaskSyncBuckets(allTasks);
  const operations = planTaskSyncOperations(normalized);
  const phasePlans = planTaskApplyPhases(operations);
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  return { tasksById, operations, phasePlans };
}
