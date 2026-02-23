import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import type { TaskStatus } from './types.js';
import { TASK_STATUSES, isTaskStatus } from './types.js';
import { withDirectTaskLifecycle } from './task-lifecycle.js';
import { autoTagTask } from './auto-tag.js';
import { taskThreadCache } from './thread-cache.js';
import {
  resolveTaskId,
  resolveTaskService,
  scheduleRepairSync,
} from './task-action-mutation-helpers.js';
import {
  ensureCreatedTaskThreadLink,
  syncClosedTaskThread,
  syncUpdatedTaskThread,
} from './task-action-thread-sync.js';
import type {
  TaskActionResult,
  TaskActionRunContext,
} from './task-action-runner-types.js';

/** Pre-computed set for filtering status names from tag candidates. */
const STATUS_NAME_SET = new Set<string>(TASK_STATUSES);

/**
 * Discord message content limit. Descriptions are rendered in the thread's
 * starter message, so they must fit within this budget (minus ~100 chars of
 * metadata overhead added by buildTaskStarterContent).
 */
const TASK_DESC_WRITE_MAX = 1900;

export async function handleTaskCreate(
  action: Extract<TaskActionRequest, { type: 'taskCreate' }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
  if (!action.title) {
    return { ok: false, error: 'taskCreate requires a title' };
  }
  if (action.description && action.description.length > TASK_DESC_WRITE_MAX) {
    return { ok: false, error: `description exceeds ${TASK_DESC_WRITE_MAX} character limit (got ${action.description.length})` };
  }

  const labels: string[] = [];
  if (action.tags) {
    labels.push(...action.tags.split(',').map((t) => t.trim()).filter(Boolean));
  }

  const taskService = resolveTaskService(taskCtx);
  const task = taskService.create({
    title: action.title,
    description: action.description,
    priority: action.priority,
    labels,
  });

  let threadId = '';
  let needsRepairSync = false;
  await withDirectTaskLifecycle(task.id, async () => {
    const tagNames = Object.keys(taskCtx.tagMap).filter((k) => !STATUS_NAME_SET.has(k));
    if (taskCtx.autoTag && tagNames.length > 0) {
      try {
        const suggestedTags = await autoTagTask(
          taskCtx.runtime,
          task.title,
          task.description ?? '',
          tagNames,
          {
            model: taskCtx.autoTagModel,
            cwd: taskCtx.tasksCwd || process.cwd(),
            modelResolver: taskCtx.resolveModel,
          },
        );
        for (const tag of suggestedTags) {
          if (!labels.includes(tag)) labels.push(tag);
        }
        for (const tag of suggestedTags) {
          try {
            taskService.addLabel(task.id, `tag:${tag}`);
          } catch {
            // best-effort
          }
        }
      } catch (err) {
        taskCtx.log?.warn({ err, taskId: task.id }, 'tasks:auto-tag failed');
      }
    }

    const threadLink = await ensureCreatedTaskThreadLink({
      actionType: action.type,
      taskCtx,
      runCtx: ctx,
      taskService,
      task,
      labels,
    });
    threadId = threadLink.threadId;
    if (threadLink.needsRepairSync) needsRepairSync = true;
  });

  if (needsRepairSync) {
    scheduleRepairSync(taskCtx, task.id, ctx);
  }

  taskThreadCache.invalidate();
  taskCtx.forumCountSync?.requestUpdate();
  const threadNote = threadId ? ' (thread linked)' : '';
  return { ok: true, summary: `Task ${task.id} created: "${task.title}"${threadNote}` };
}

export async function handleTaskUpdate(
  action: Extract<TaskActionRequest, { type: 'taskUpdate' }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
  const taskId = resolveTaskId(action);
  if (!taskId) {
    return { ok: false, error: 'taskUpdate requires taskId' };
  }
  if (action.description && action.description.length > TASK_DESC_WRITE_MAX) {
    return { ok: false, error: `description exceeds ${TASK_DESC_WRITE_MAX} character limit (got ${action.description.length})` };
  }

  if (action.status && !isTaskStatus(action.status)) {
    return { ok: false, error: `Invalid task status: "${action.status}"` };
  }

  let needsRepairSync = false;
  const taskService = resolveTaskService(taskCtx);
  await withDirectTaskLifecycle(taskId, async () => {
    const updatedTask = taskService.update(taskId, {
      title: action.title,
      description: action.description,
      priority: action.priority,
      status: action.status as TaskStatus | undefined,
    });

    const threadRepair = await syncUpdatedTaskThread({
      actionType: action.type,
      taskCtx,
      runCtx: ctx,
      taskId,
      updatedTask,
    });
    if (threadRepair) needsRepairSync = true;
  });

  if (needsRepairSync) {
    scheduleRepairSync(taskCtx, taskId, ctx);
  }

  taskThreadCache.invalidate();
  if (action.status) taskCtx.forumCountSync?.requestUpdate();

  const changes: string[] = [];
  if (action.title) changes.push(`title → "${action.title}"`);
  if (action.status) changes.push(`status → ${action.status}`);
  if (action.priority != null) changes.push(`priority → P${action.priority}`);
  return { ok: true, summary: `Task ${taskId} updated: ${changes.join(', ') || 'no changes'}` };
}

export async function handleTaskClose(
  action: Extract<TaskActionRequest, { type: 'taskClose' }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
  const taskId = resolveTaskId(action);
  if (!taskId) {
    return { ok: false, error: 'taskClose requires taskId' };
  }

  let needsRepairSync = false;
  const taskService = resolveTaskService(taskCtx);
  await withDirectTaskLifecycle(taskId, async () => {
    const closedTask = taskService.close(taskId, action.reason);
    const threadRepair = await syncClosedTaskThread({
      actionType: action.type,
      taskCtx,
      runCtx: ctx,
      taskId,
      closedTask,
    });
    if (threadRepair) needsRepairSync = true;
  });

  if (needsRepairSync) {
    scheduleRepairSync(taskCtx, taskId, ctx);
  }

  taskThreadCache.invalidate();
  taskCtx.forumCountSync?.requestUpdate();
  return { ok: true, summary: `Task ${taskId} closed${action.reason ? `: ${action.reason}` : ''}` };
}
