import type { TagMap } from './types.js';
import type { LoggerLike } from './logger-types.js';
import type { TaskDiscordClient, TaskDiscordForumChannel } from './discord-types.js';
import type { TaskInFlightChecker } from './sync-context.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';

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
  forum: TaskDiscordForumChannel;
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
