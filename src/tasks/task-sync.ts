import type { LoggerLike } from '../logging/logger-like.js';
import type { TaskSyncRunContext, TaskSyncRunOptions, TaskSyncWiring } from './sync-types.js';
import type { TaskSyncResult } from './types.js';
import type { TaskSyncContext, TaskSyncCoordinatorLike, TaskStatusPoster } from './sync-context.js';
import { TaskSyncCoordinator } from './sync-coordinator.js';
import { TASK_SYNC_TRIGGER_EVENTS } from './sync-contract.js';
import { isDirectTaskLifecycleActive } from './task-lifecycle.js';

export type { TaskSyncContext, TaskSyncCoordinatorLike } from './sync-context.js';
export type { TaskSyncRunContext, TaskSyncRunOptions, TaskSyncWiring } from './sync-types.js';

export async function ensureTaskSyncCoordinator(
  taskCtx: TaskSyncContext,
  runCtx: TaskSyncRunContext,
): Promise<TaskSyncCoordinatorLike> {
  if (taskCtx.syncCoordinator) return taskCtx.syncCoordinator;

  const syncCoordinator = new TaskSyncCoordinator({
    client: runCtx.client,
    guild: runCtx.guild,
    forumId: taskCtx.forumId,
    tagMap: taskCtx.tagMap,
    tagMapPath: taskCtx.tagMapPath,
    store: taskCtx.store,
    taskService: taskCtx.taskService,
    log: taskCtx.log,
    mentionUserId: taskCtx.sidebarMentionUserId,
    forumCountSync: taskCtx.forumCountSync,
    ...(taskCtx.syncRunOptions ?? {}),
    enableFailureRetry: taskCtx.syncFailureRetryEnabled,
    failureRetryDelayMs: taskCtx.syncFailureRetryDelayMs,
    deferredRetryDelayMs: taskCtx.syncDeferredRetryDelayMs,
  });
  taskCtx.syncCoordinator = syncCoordinator;
  return syncCoordinator;
}

export async function runTaskSync(
  taskCtx: TaskSyncContext,
  runCtx: TaskSyncRunContext,
  statusPoster?: TaskStatusPoster,
): Promise<TaskSyncResult | null> {
  const syncCoordinator = await ensureTaskSyncCoordinator(taskCtx, runCtx);
  return syncCoordinator.sync(statusPoster);
}

export function wireTaskStoreSyncTriggers(
  taskCtx: TaskSyncContext,
  syncCoordinator: TaskSyncCoordinatorLike,
  log: LoggerLike,
): TaskSyncWiring {
  const triggerSync = (eventName: string, taskId?: string) => {
    syncCoordinator.sync().catch((err) => {
      log.warn({ err, eventName, taskId }, 'tasks:store-event sync failed');
    });
  };

  const subscriptions = TASK_SYNC_TRIGGER_EVENTS.map((eventName) => {
    const handler = (task: { id: string }) => {
      const taskId = task?.id;
      if (taskId && isDirectTaskLifecycleActive(taskId)) {
        return;
      }
      triggerSync(eventName, taskId);
    };
    taskCtx.store.on(eventName, handler);
    return { eventName, handler };
  });

  return {
    stop() {
      for (const sub of subscriptions) {
        taskCtx.store.off(sub.eventName, sub.handler);
      }
    },
  };
}
