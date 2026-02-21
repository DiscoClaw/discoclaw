import type { Client, Guild } from 'discord.js';
import type { TagMap, TaskData, TaskSyncResult } from './types.js';
import { hasInFlightForChannel } from '../discord/inflight-replies.js';
export type { TaskSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import { createTaskService } from './service.js';
import {
  buildTasksByShortIdMap,
  ingestTaskSyncSnapshot,
  normalizeTaskSyncBuckets,
  operationTaskIdList,
  planTaskSyncOperations,
} from './task-sync-pipeline.js';
import { withTaskLifecycleLock } from './task-lifecycle.js';
import {
  resolveTasksForum,
  createTaskThread,
  closeTaskThread,
  isThreadArchived,
  isTaskThreadAlreadyClosed,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
  getThreadIdFromTask,
  ensureUnarchived,
  findExistingThreadForTask,
  extractShortIdFromThreadName,
  shortTaskId,
} from './discord-sync.js';

export type TaskSyncOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  store: TaskStore;
  taskService?: TaskService;
  log?: LoggerLike;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  statusPoster?: StatusPoster;
  mentionUserId?: string;
  /** Disable Phase 5 (thread reconciliation). Useful for shared-forum deployments. */
  skipPhase5?: boolean;
};

type TaskSyncApplyCounters = {
  threadsCreated: number;
  emojisUpdated: number;
  starterMessagesUpdated: number;
  threadsArchived: number;
  statusesUpdated: number;
  tagsUpdated: number;
  warnings: number;
  closesDeferred: number;
};

type TaskSyncApplyContext = {
  client: Client;
  forum: any;
  tagMap: TagMap;
  store: TaskStore;
  taskService: TaskService;
  log?: LoggerLike;
  throttleMs: number;
  archivedDedupeLimit?: number;
  mentionUserId?: string;
  counters: TaskSyncApplyCounters;
};

type TaskSyncReconcileResult = {
  threadsReconciled: number;
  orphanThreadsFound: number;
};

function createApplyCounters(): TaskSyncApplyCounters {
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

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
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
        if (hasInFlightForChannel(threadId)) {
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

async function applyPhase5ReconcileThreads(
  ctx: TaskSyncApplyContext,
  allTasks: TaskData[],
): Promise<TaskSyncReconcileResult> {
  let threadsReconciled = 0;
  let orphanThreadsFound = 0;

  const tasksByShortId = buildTasksByShortIdMap(allTasks, shortTaskId);

  try {
    const activeThreads = await ctx.forum.threads.fetchActive();
    let archivedThreads: Map<string, any> = new Map();
    try {
      const fetched = await ctx.forum.threads.fetchArchived();
      archivedThreads = new Map(fetched.threads);
    } catch (err) {
      ctx.log?.warn({ err }, 'task-sync:phase5 failed to fetch archived threads');
      ctx.counters.warnings++;
    }

    const allThreads = new Map<string, any>([
      ...archivedThreads,
      ...(activeThreads.threads as Map<string, any>),
    ]);
    for (const thread of allThreads.values()) {
      const sid = extractShortIdFromThreadName(thread.name);
      if (!sid) continue;

      const tasks = tasksByShortId.get(sid);
      if (!tasks || tasks.length === 0) {
        orphanThreadsFound++;
        ctx.log?.info({ threadId: thread.id, threadName: thread.name, shortId: sid }, 'task-sync:phase5 orphan thread detected');
        await sleep(ctx.throttleMs);
        continue;
      }

      if (tasks.length > 1) {
        ctx.log?.info({ threadId: thread.id, shortId: sid, count: tasks.length }, 'task-sync:phase5 short-id collision, skipping');
        await sleep(ctx.throttleMs);
        continue;
      }

      const task = tasks[0]!;
      const existingThreadId = getThreadIdFromTask(task);
      if (existingThreadId && existingThreadId !== thread.id) {
        ctx.log?.info({ taskId: task.id, threadId: thread.id, existingThreadId }, 'task-sync:phase5 external_ref points to different thread, skipping');
        await sleep(ctx.throttleMs);
        continue;
      }

      if (task.status === 'closed' && !thread.archived) {
        if (hasInFlightForChannel(thread.id)) {
          ctx.counters.closesDeferred++;
          ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
          await sleep(ctx.throttleMs);
          continue;
        }

        if (!existingThreadId) {
          try {
            ctx.taskService.update(task.id, { externalRef: `discord:${thread.id}` });
            ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 external_ref backfilled');
          } catch (err) {
            ctx.log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 external_ref backfill failed');
            ctx.counters.warnings++;
          }
        }

        try {
          await closeTaskThread(ctx.client, thread.id, task, ctx.tagMap, ctx.log);
          threadsReconciled++;
          ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 reconciled (archived)');
        } catch (err) {
          ctx.log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archive failed');
          ctx.counters.warnings++;
        }
        await sleep(ctx.throttleMs);
      } else if (task.status === 'closed' && thread.archived) {
        try {
          const alreadyClosed = await isTaskThreadAlreadyClosed(ctx.client, thread.id, task, ctx.tagMap);
          if (!alreadyClosed) {
            if (hasInFlightForChannel(thread.id)) {
              ctx.counters.closesDeferred++;
              ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
            } else {
              ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archived thread is stale, unarchiving to reconcile');
              await closeTaskThread(ctx.client, thread.id, task, ctx.tagMap, ctx.log);
              threadsReconciled++;
              ctx.log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 reconciled (re-archived)');
            }
          }
        } catch (err) {
          ctx.log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archived reconcile failed');
          ctx.counters.warnings++;
        }
        await sleep(ctx.throttleMs);
      }
    }
  } catch (err) {
    ctx.log?.warn({ err }, 'task-sync:phase5 failed to fetch active threads');
    ctx.counters.warnings++;
  }

  return { threadsReconciled, orphanThreadsFound };
}

/**
 * 5-phase safety-net sync between tasks DB and Discord forum threads.
 *
 * Phase 1: Create threads for tasks missing external_ref.
 * Phase 2: Fix label mismatches (e.g., blocked label on open tasks).
 * Phase 3: Sync emoji/names/starter content for existing threads.
 * Phase 4: Archive threads for closed tasks.
 * Phase 5: Reconcile forum threads against tasks — archive stale threads
 *          for closed tasks and detect orphan threads with no matching task.
 */
export async function runTaskSync(opts: TaskSyncOptions): Promise<TaskSyncResult> {
  const { client, guild, forumId, tagMap, log } = opts;
  const taskService = opts.taskService ?? createTaskService(opts.store);
  const throttleMs = opts.throttleMs ?? 250;

  const forum = await resolveTasksForum(guild, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'task-sync: forum not found');
    const result: TaskSyncResult = {
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
      warnings: 1,
    };
    if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
    return result;
  }

  const counters = createApplyCounters();

  // Stage 1: ingest
  const allTasks = ingestTaskSyncSnapshot(opts.store.list({ status: 'all' }));
  // Stage 2: normalize
  const normalized = normalizeTaskSyncBuckets(allTasks);
  // Stage 3: diff (idempotent operation plan)
  const plannedOperations = planTaskSyncOperations(normalized);
  const phase1TaskIds = operationTaskIdList(plannedOperations, 'phase1');
  const phase2TaskIds = operationTaskIdList(plannedOperations, 'phase2');
  const phase3TaskIds = operationTaskIdList(plannedOperations, 'phase3');
  const phase4TaskIds = operationTaskIdList(plannedOperations, 'phase4');
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));

  // Stage 4: apply
  const applyCtx: TaskSyncApplyContext = {
    client,
    forum,
    tagMap,
    store: opts.store,
    taskService,
    log,
    throttleMs,
    archivedDedupeLimit: opts.archivedDedupeLimit,
    mentionUserId: opts.mentionUserId,
    counters,
  };

  await applyPhase1CreateMissingThreads(applyCtx, tasksById, phase1TaskIds);
  await applyPhase2FixBlockedStatus(applyCtx, tasksById, phase2TaskIds);
  await applyPhase3SyncActiveThreads(applyCtx, tasksById, phase3TaskIds);
  await applyPhase4ArchiveClosedThreads(applyCtx, tasksById, phase4TaskIds);

  let threadsReconciled = 0;
  let orphanThreadsFound = 0;
  if (!opts.skipPhase5) {
    const phase5 = await applyPhase5ReconcileThreads(applyCtx, allTasks);
    threadsReconciled = phase5.threadsReconciled;
    orphanThreadsFound = phase5.orphanThreadsFound;
  }

  log?.info({
    threadsCreated: counters.threadsCreated,
    emojisUpdated: counters.emojisUpdated,
    starterMessagesUpdated: counters.starterMessagesUpdated,
    threadsArchived: counters.threadsArchived,
    statusesUpdated: counters.statusesUpdated,
    tagsUpdated: counters.tagsUpdated,
    threadsReconciled,
    orphanThreadsFound,
    closesDeferred: counters.closesDeferred,
    warnings: counters.warnings,
  }, 'task-sync: complete');

  const result: TaskSyncResult = {
    threadsCreated: counters.threadsCreated,
    emojisUpdated: counters.emojisUpdated,
    starterMessagesUpdated: counters.starterMessagesUpdated,
    threadsArchived: counters.threadsArchived,
    statusesUpdated: counters.statusesUpdated,
    tagsUpdated: counters.tagsUpdated,
    warnings: counters.warnings,
    threadsReconciled,
    orphanThreadsFound,
    closesDeferred: counters.closesDeferred,
  };

  if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
  return result;
}
