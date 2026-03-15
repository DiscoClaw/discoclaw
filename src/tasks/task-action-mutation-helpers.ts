import type { TaskContext } from './task-context.js';
import type { TaskService } from './service.js';
import { createTaskService } from './service.js';
import { runTaskSync } from './task-sync.js';
import type { TaskActionRunContext } from './task-action-runner-types.js';

export function resolveTaskService(taskCtx: TaskContext): TaskService {
  if (taskCtx.taskService) return taskCtx.taskService;
  const taskService = createTaskService(taskCtx.store);
  taskCtx.taskService = taskService;
  return taskService;
}

export function resolveTaskId(action: { taskId?: string }): string {
  return (action.taskId ?? '').trim();
}

export function scheduleRepairSync(taskCtx: TaskContext, taskId: string, ctx: TaskActionRunContext): void {
  runTaskSync(taskCtx, { client: ctx.client, guild: ctx.guild }).catch((err) => {
    taskCtx.log?.warn({ err, taskId }, 'tasks:repair sync failed');
  });
}
