import type { LoggerLike } from '../logging/logger-like.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskSyncResult, TagMap } from './types.js';
import type { TaskSyncRunOptions } from './sync-types.js';

export type TaskStatusPoster = {
  taskSyncComplete(result: TaskSyncResult): Promise<void>;
};

export type TaskForumCountSync = {
  requestUpdate(): void;
  stop(): void;
};

export type TaskInFlightChecker = (channelId: string) => boolean;

export type TaskSyncCoordinatorLike = {
  sync(statusPoster?: TaskStatusPoster): Promise<TaskSyncResult | null>;
};

export type TaskSyncContext = {
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  taskService?: TaskService;
  log?: LoggerLike;
  sidebarMentionUserId?: string;
  forumCountSync?: TaskForumCountSync;
  hasInFlightForChannel?: TaskInFlightChecker;
  syncCoordinator?: TaskSyncCoordinatorLike;
  syncFailureRetryEnabled?: boolean;
  syncFailureRetryDelayMs?: number;
  syncDeferredRetryDelayMs?: number;
  syncRunOptions?: TaskSyncRunOptions;
};
