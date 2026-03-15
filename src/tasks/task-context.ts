import type { TaskSyncContext, TaskStatusPoster } from './sync-context.js';
import type { TaskModelResolver, TaskRuntimeAdapter } from './runtime-types.js';

export type TaskContext = TaskSyncContext & {
  tasksCwd?: string;
  runtime: TaskRuntimeAdapter;
  resolveModel?: TaskModelResolver;
  autoTag: boolean;
  autoTagModel: string;
  mentionUserId?: string;
  statusPoster?: TaskStatusPoster;
};
