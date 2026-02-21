import type { TaskContext } from './task-context.js';
import type { TaskActionRequest } from './task-action-contract.js';
import {
  handleTaskClose,
  handleTaskCreate,
  handleTaskUpdate,
} from './task-action-mutations.js';
import {
  handleTagMapReload,
  handleTaskList,
  handleTaskShow,
  handleTaskSync,
} from './task-action-read-ops.js';
import type {
  TaskActionHandler,
  TaskActionResult,
  TaskActionRunContext,
} from './task-action-runner-types.js';

export type { TaskActionRunContext, TaskActionResult } from './task-action-runner-types.js';

type TaskActionHandlerMap = {
  [K in TaskActionRequest['type']]: TaskActionHandler<K>;
};

const TASK_ACTION_HANDLERS: TaskActionHandlerMap = {
  taskCreate: handleTaskCreate,
  taskUpdate: handleTaskUpdate,
  taskClose: handleTaskClose,
  taskShow: handleTaskShow,
  taskList: handleTaskList,
  taskSync: handleTaskSync,
  tagMapReload: handleTagMapReload,
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeTaskAction(
  action: TaskActionRequest,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
  const handler = TASK_ACTION_HANDLERS[action.type] as TaskActionHandler;
  return handler(action as never, ctx, taskCtx);
}
