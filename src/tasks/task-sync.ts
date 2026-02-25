import type { TaskSyncRunContext, TaskSyncRunOptions } from './sync-types.js';
import type { TaskSyncResult } from './types.js';
import type { TaskSyncContext, TaskSyncCoordinatorLike, TaskStatusPoster } from './sync-context.js';
import { TaskSyncCoordinator } from './sync-coordinator.js';

export type { TaskSyncContext, TaskSyncCoordinatorLike } from './sync-context.js';
export type { TaskSyncRunContext, TaskSyncRunOptions } from './sync-types.js';

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
    hasInFlightForChannel: taskCtx.hasInFlightForChannel,
    metrics: taskCtx.metrics,
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

