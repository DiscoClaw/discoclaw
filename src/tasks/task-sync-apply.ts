import type { TagMap, TaskData } from './types.js';
import type { LoggerLike } from './logger-types.js';
import type { TaskDiscordClient } from './discord-types.js';
import type { TaskInFlightChecker } from './sync-context.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskSyncRunOptions } from './sync-types.js';
import {
  planTaskReconcileFromThreadSources,
  type TaskThreadLike,
  type TaskReconcileAction,
  type TaskReconcileOperation,
  type TaskSyncApplyExecutionPlan,
  type TaskSyncOperationPhase,
} from './task-sync-pipeline.js';
import { withTaskLifecycleLock } from './task-lifecycle.js';
import {
  closeTaskThread,
  createTaskThread,
  ensureUnarchived,
  findExistingThreadForTask,
  isTaskThreadAlreadyClosed,
  isThreadArchived,
  updateTaskStarterMessage,
  updateTaskThreadName,
  updateTaskThreadTags,
} from './thread-ops.js';
import {
  extractShortIdFromThreadName,
  getThreadIdFromTask,
  shortTaskId,
} from './thread-helpers.js';

export type TaskSyncApplyCounters = {
  threadsCreated: number;
  emojisUpdated: number;
  starterMessagesUpdated: number;
  threadsArchived: number;
  statusesUpdated: number;
  tagsUpdated: number;
  warnings: number;
  closesDeferred: number;
};

export type TaskSyncApplyContext = {
  client: TaskDiscordClient;
  forum: any;
  tagMap: TagMap;
  store: TaskStore;
  taskService: TaskService;
  log?: LoggerLike;
  throttleMs: number;
  archivedDedupeLimit?: number;
  mentionUserId?: string;
  counters: TaskSyncApplyCounters;
  hasInFlightForChannel: TaskInFlightChecker;
};

export type TaskSyncReconcileResult = {
  threadsReconciled: number;
  orphanThreadsFound: number;
};

type TaskSyncReconcileThreadSources = {
  activeThreads: Map<string, TaskThreadLike>;
  archivedThreads: Map<string, TaskThreadLike>;
};

type TaskSyncPhaseExecutor = (
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
) => Promise<void>;

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

export function createTaskSyncApplyCounters(): TaskSyncApplyCounters {
  return {
    threadsCreated: 0,
    emojisUpdated: 0,
    starterMessagesUpdated: 0,
    threadsArchived: 0,
    statusesUpdated: 0,
    tagsUpdated: 0,
    warnings: 0,
    closesDeferred: 0,
  };
}

async function applyPhase1CreateMissingThreads(
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
): Promise<void> {
  for (const taskId of plannedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = ctx.store.get(task.id) ?? task;
      if (
        getThreadIdFromTask(latestTask) ||
        latestTask.status === 'closed' ||
        (latestTask.labels ?? []).includes('no-thread')
      ) {
        return;
      }

      try {
        const existing = await findExistingThreadForTask(
          ctx.forum,
          latestTask.id,
          { archivedLimit: ctx.archivedDedupeLimit },
        );
        if (existing) {
          try {
            ctx.taskService.update(latestTask.id, { externalRef: `discord:${existing}` });
            ctx.log?.info({ taskId: latestTask.id, threadId: existing }, 'task-sync:phase1 external-ref backfilled');
          } catch (err) {
            ctx.log?.warn({ err, taskId: latestTask.id, threadId: existing }, 'task-sync:phase1 external-ref backfill failed');
            ctx.counters.warnings++;
          }
          return;
        }

        const threadId = await createTaskThread(
          ctx.forum,
          latestTask,
          ctx.tagMap,
          ctx.mentionUserId,
        );
        try {
          ctx.taskService.update(latestTask.id, { externalRef: `discord:${threadId}` });
        } catch (err) {
          ctx.log?.warn({ err, taskId: latestTask.id }, 'task-sync:phase1 external-ref update failed');
          ctx.counters.warnings++;
        }
        ctx.counters.threadsCreated++;
        ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase1 thread created');
      } catch (err) {
        ctx.log?.warn({ err, taskId: latestTask.id }, 'task-sync:phase1 failed');
        ctx.counters.warnings++;
      }
    });
    await sleep(ctx.throttleMs);
  }
}

async function applyPhase2FixBlockedStatus(
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
): Promise<void> {
  for (const taskId of plannedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    try {
      ctx.taskService.update(task.id, { status: 'blocked' as any });
      task.status = 'blocked';
      ctx.counters.statusesUpdated++;
      ctx.log?.info({ taskId: task.id }, 'task-sync:phase2 status updated to blocked');
    } catch (err) {
      ctx.log?.warn({ err, taskId: task.id }, 'task-sync:phase2 failed');
      ctx.counters.warnings++;
    }
    await sleep(ctx.throttleMs);
  }
}

async function applyPhase3SyncActiveThreads(
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
): Promise<void> {
  for (const taskId of plannedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = ctx.store.get(task.id) ?? task;
      const threadId = getThreadIdFromTask(latestTask);
      if (!threadId || latestTask.status === 'closed') {
        return;
      }

      if (await isThreadArchived(ctx.client, threadId)) {
        return;
      }

      try {
        await ensureUnarchived(ctx.client, threadId);
      } catch {}
      try {
        const changed = await updateTaskThreadName(ctx.client, threadId, latestTask);
        if (changed) {
          ctx.counters.emojisUpdated++;
          ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 name updated');
        }
      } catch (err) {
        ctx.log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 failed');
        ctx.counters.warnings++;
      }
      try {
        const starterChanged = await updateTaskStarterMessage(
          ctx.client,
          threadId,
          latestTask,
          ctx.mentionUserId,
        );
        if (starterChanged) {
          ctx.counters.starterMessagesUpdated++;
          ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 starter updated');
        }
      } catch (err) {
        ctx.log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 starter update failed');
        ctx.counters.warnings++;
      }
      try {
        const tagChanged = await updateTaskThreadTags(ctx.client, threadId, latestTask, ctx.tagMap);
        if (tagChanged) {
          ctx.counters.tagsUpdated++;
          ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 tags updated');
        }
      } catch (err) {
        ctx.log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 tag update failed');
        ctx.counters.warnings++;
      }
    });
    await sleep(ctx.throttleMs);
  }
}

async function applyPhase4ArchiveClosedThreads(
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
): Promise<void> {
  for (const taskId of plannedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = ctx.store.get(task.id) ?? task;
      const threadId = getThreadIdFromTask(latestTask);
      if (!threadId || latestTask.status !== 'closed') {
        return;
      }

      try {
        if (await isTaskThreadAlreadyClosed(ctx.client, threadId, latestTask, ctx.tagMap)) {
          return;
        }
        if (ctx.hasInFlightForChannel(threadId)) {
          ctx.counters.closesDeferred++;
          ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase4 close deferred (in-flight reply active)');
          return;
        }
        await closeTaskThread(ctx.client, threadId, latestTask, ctx.tagMap, ctx.log);
        ctx.counters.threadsArchived++;
        ctx.log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase4 archived');
      } catch (err) {
        ctx.log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase4 failed');
        ctx.counters.warnings++;
      }
    });
    await sleep(ctx.throttleMs);
  }
}

const PHASE_EXECUTORS: Record<TaskSyncOperationPhase, TaskSyncPhaseExecutor> = {
  phase1: applyPhase1CreateMissingThreads,
  phase2: applyPhase2FixBlockedStatus,
  phase3: applyPhase3SyncActiveThreads,
  phase4: applyPhase4ArchiveClosedThreads,
};

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
    activeThreads = fetchedActive.threads as Map<string, TaskThreadLike>;
  } catch (err) {
    ctx.log?.warn({ err }, 'task-sync:phase5 failed to fetch active threads');
    ctx.counters.warnings++;
    return null;
  }

  let archivedThreads: Map<string, TaskThreadLike> = new Map();
  try {
    const fetchedArchived = await ctx.forum.threads.fetchArchived();
    archivedThreads = new Map(fetchedArchived.threads as Map<string, TaskThreadLike>);
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

export async function applyTaskSyncExecutionPlan(
  ctx: TaskSyncApplyContext,
  applyPlan: TaskSyncApplyExecutionPlan,
): Promise<void> {
  for (const phasePlan of applyPlan.phasePlans) {
    if (phasePlan.taskIds.length === 0) continue;
    await PHASE_EXECUTORS[phasePlan.phase](ctx, applyPlan.tasksById, phasePlan.taskIds);
  }
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
