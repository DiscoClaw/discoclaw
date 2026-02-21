import type { RuntimeAdapter } from '../runtime/types.js';
import type { TaskSyncContext, TaskStatusPoster } from './sync-context.js';

export type TaskContext = TaskSyncContext & {
  tasksCwd?: string;
  runtime: RuntimeAdapter;
  autoTag: boolean;
  autoTagModel: string;
  mentionUserId?: string;
  statusPoster?: TaskStatusPoster;
};
