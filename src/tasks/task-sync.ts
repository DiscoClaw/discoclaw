import type { Client, Guild } from 'discord.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskSyncResult, TagMap } from './types.js';
import { TaskSyncCoordinator } from './sync-coordinator.js';
import { TASK_SYNC_TRIGGER_EVENTS } from './sync-contract.js';
import { isDirectTaskLifecycleActive } from './task-lifecycle.js';

export type TaskSyncCoordinatorLike = {
  sync(statusPoster?: StatusPoster): Promise<TaskSyncResult | null>;
};

export type TaskSyncContext = {
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  taskService?: TaskService;
  log?: LoggerLike;
  sidebarMentionUserId?: string;
  forumCountSync?: ForumCountSync;
  syncCoordinator?: TaskSyncCoordinatorLike;
  syncFailureRetryEnabled?: boolean;
  syncFailureRetryDelayMs?: number;
  syncDeferredRetryDelayMs?: number;
};

export type TaskSyncRunContext = {
  client: Client;
  guild: Guild;
};

export async function ensureTaskSyncCoordinator(
  taskCtx: TaskSyncContext,
  runCtx: TaskSyncRunContext,
  opts?: { skipPhase5?: boolean },
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
    skipPhase5: opts?.skipPhase5,
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
  statusPoster?: StatusPoster,
  opts?: { skipPhase5?: boolean },
): Promise<TaskSyncResult | null> {
  const syncCoordinator = await ensureTaskSyncCoordinator(taskCtx, runCtx, opts);
  return syncCoordinator.sync(statusPoster);
}

export function wireTaskStoreSyncTriggers(
  taskCtx: TaskSyncContext,
  syncCoordinator: TaskSyncCoordinatorLike,
  log: LoggerLike,
): { stop(): void } {
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
