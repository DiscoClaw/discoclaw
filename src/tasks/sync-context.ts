import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskSyncResult, TagMap } from './types.js';
import type { TaskSyncRunOptions } from './sync-types.js';

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
  syncRunOptions?: TaskSyncRunOptions;
};
