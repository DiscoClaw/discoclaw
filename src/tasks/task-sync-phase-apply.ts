import type { TaskData } from './types.js';
import type { TaskSyncApplyExecutionPlan, TaskSyncOperationPhase } from './task-sync-pipeline.js';
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
import { getThreadIdFromTask } from './thread-helpers.js';
import type { TaskSyncApplyContext } from './task-sync-apply-types.js';

type TaskSyncPhaseExecutor = (
  ctx: TaskSyncApplyContext,
  tasksById: Map<string, TaskData>,
  plannedTaskIds: string[],
) => Promise<void>;

function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, n));
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

export async function applyTaskSyncExecutionPlan(
  ctx: TaskSyncApplyContext,
  applyPlan: TaskSyncApplyExecutionPlan,
): Promise<void> {
  for (const phasePlan of applyPlan.phasePlans) {
    if (phasePlan.taskIds.length === 0) continue;
    await PHASE_EXECUTORS[phasePlan.phase](ctx, applyPlan.tasksById, phasePlan.taskIds);
  }
}
