import type { TaskData } from './types.js';
import type { TaskSyncRunOptions } from './sync-types.js';
import {
  planTaskReconcileFromThreadSources,
  type TaskThreadLike,
  type TaskReconcileAction,
  type TaskReconcileOperation,
} from './task-sync-pipeline.js';
import { closeTaskThread, isTaskThreadAlreadyClosed } from './thread-ops.js';
import {
  extractShortIdFromThreadName,
  getThreadIdFromTask,
  shortTaskId,
} from './thread-helpers.js';
import type {
  TaskSyncApplyContext,
  TaskSyncReconcileResult,
} from './task-sync-apply-types.js';

type TaskSyncReconcileThreadSources = {
  activeThreads: Map<string, TaskThreadLike>;
  archivedThreads: Map<string, TaskThreadLike>;
};

type TaskSyncReconcileApplyState = {
  threadsReconciled: number;
  orphanThreadsFound: number;
};

type TaskSyncReconcileExecutor = (
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
  state: TaskSyncReconcileApplyState,
) => Promise<void>;

function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, n));
}

async function applyReconcileOrphanThread(
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
  state: TaskSyncReconcileApplyState,
): Promise<void> {
  state.orphanThreadsFound++;
  ctx.log?.info(
    { threadId: operation.thread.id, threadName: operation.thread.name, shortId: operation.shortId },
    'task-sync:phase5 orphan thread detected',
  );
}

async function applyReconcileCollision(
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
): Promise<void> {
  ctx.log?.info(
    { threadId: operation.thread.id, shortId: operation.shortId, count: operation.collisionCount },
    'task-sync:phase5 short-id collision, skipping',
  );
}

async function applyReconcileSkipMismatch(
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
): Promise<void> {
  ctx.log?.info(
    { taskId: operation.task?.id, threadId: operation.thread.id, existingThreadId: operation.existingThreadId },
    'task-sync:phase5 external_ref points to different thread, skipping',
  );
}

async function applyReconcileArchiveActiveClosed(
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
  state: TaskSyncReconcileApplyState,
): Promise<void> {
  const task = operation.task;
  if (!task) return;

  if (ctx.hasInFlightForChannel(operation.thread.id)) {
    ctx.counters.closesDeferred++;
    ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
    return;
  }

  if (!operation.existingThreadId) {
    try {
      ctx.taskService.update(task.id, { externalRef: `discord:${operation.thread.id}` });
      ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 external_ref backfilled');
    } catch (err) {
      ctx.log?.warn({ err, taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 external_ref backfill failed');
      ctx.counters.warnings++;
    }
  }

  try {
    await closeTaskThread(ctx.client, operation.thread.id, task, ctx.tagMap, ctx.log);
    state.threadsReconciled++;
    ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 reconciled (archived)');
  } catch (err) {
    ctx.log?.warn({ err, taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 archive failed');
    ctx.counters.warnings++;
  }
}

async function applyReconcileArchivedClosed(
  ctx: TaskSyncApplyContext,
  operation: TaskReconcileOperation,
  state: TaskSyncReconcileApplyState,
): Promise<void> {
  const task = operation.task;
  if (!task) return;

  try {
    const alreadyClosed = await isTaskThreadAlreadyClosed(ctx.client, operation.thread.id, task, ctx.tagMap);
    if (!alreadyClosed) {
      if (ctx.hasInFlightForChannel(operation.thread.id)) {
        ctx.counters.closesDeferred++;
        ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
      } else {
        ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 archived thread is stale, unarchiving to reconcile');
        await closeTaskThread(ctx.client, operation.thread.id, task, ctx.tagMap, ctx.log);
        state.threadsReconciled++;
        ctx.log?.info({ taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 reconciled (re-archived)');
      }
    }
  } catch (err) {
    ctx.log?.warn({ err, taskId: task.id, threadId: operation.thread.id }, 'task-sync:phase5 archived reconcile failed');
    ctx.counters.warnings++;
  }
}

const RECONCILE_EXECUTORS: Record<TaskReconcileAction, TaskSyncReconcileExecutor> = {
  orphan: applyReconcileOrphanThread,
  collision: applyReconcileCollision,
  skip_external_ref_mismatch: applyReconcileSkipMismatch,
  archive_active_closed: applyReconcileArchiveActiveClosed,
  reconcile_archived_closed: applyReconcileArchivedClosed,
};

async function fetchPhase5ThreadSources(
  ctx: TaskSyncApplyContext,
): Promise<TaskSyncReconcileThreadSources | null> {
  let activeThreads: Map<string, TaskThreadLike>;
  try {
    const fetchedActive = await ctx.forum.threads.fetchActive();
    activeThreads = fetchedActive.threads as unknown as Map<string, TaskThreadLike>;
  } catch (err) {
    ctx.log?.warn({ err }, 'task-sync:phase5 failed to fetch active threads');
    ctx.counters.warnings++;
    return null;
  }

  let archivedThreads: Map<string, TaskThreadLike> = new Map();
  try {
    const fetchedArchived = await ctx.forum.threads.fetchArchived();
    archivedThreads = new Map(fetchedArchived.threads as unknown as Map<string, TaskThreadLike>);
  } catch (err) {
    ctx.log?.warn({ err }, 'task-sync:phase5 failed to fetch archived threads');
    ctx.counters.warnings++;
  }

  return { activeThreads, archivedThreads };
}

async function planPhase5ReconcileOperations(
  ctx: TaskSyncApplyContext,
  allTasks: TaskData[],
): Promise<TaskReconcileOperation[] | null> {
  const threadSources = await fetchPhase5ThreadSources(ctx);
  if (!threadSources) return null;

  return planTaskReconcileFromThreadSources({
    tasks: allTasks,
    archivedThreads: threadSources.archivedThreads.values(),
    activeThreads: threadSources.activeThreads.values(),
    shortIdOfTaskId: shortTaskId,
    shortIdFromThreadName: extractShortIdFromThreadName,
    threadIdFromTask: getThreadIdFromTask,
  });
}

async function applyPhase5ReconcileOperations(
  ctx: TaskSyncApplyContext,
  operations: TaskReconcileOperation[],
  state: TaskSyncReconcileApplyState,
): Promise<void> {
  for (const operation of operations) {
    await RECONCILE_EXECUTORS[operation.action](ctx, operation, state);
    await sleep(ctx.throttleMs);
  }
}

async function applyPhase5ReconcileThreads(
  ctx: TaskSyncApplyContext,
  allTasks: TaskData[],
): Promise<TaskSyncReconcileResult> {
  const reconcileState: TaskSyncReconcileApplyState = {
    threadsReconciled: 0,
    orphanThreadsFound: 0,
  };

  const plannedReconcileOps = await planPhase5ReconcileOperations(ctx, allTasks);
  if (!plannedReconcileOps) {
    return {
      threadsReconciled: reconcileState.threadsReconciled,
      orphanThreadsFound: reconcileState.orphanThreadsFound,
    };
  }

  await applyPhase5ReconcileOperations(ctx, plannedReconcileOps, reconcileState);

  return {
    threadsReconciled: reconcileState.threadsReconciled,
    orphanThreadsFound: reconcileState.orphanThreadsFound,
  };
}

export async function runTaskSyncReconcilePhase(
  ctx: TaskSyncApplyContext,
  allTasks: TaskData[],
  opts?: TaskSyncRunOptions,
): Promise<TaskSyncReconcileResult> {
  if (opts?.skipPhase5) {
    return { threadsReconciled: 0, orphanThreadsFound: 0 };
  }
  return applyPhase5ReconcileThreads(ctx, allTasks);
}
