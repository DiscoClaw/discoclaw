import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import type { TaskStatus, TaskData } from './types.js';
import { TASK_STATUSES, isTaskStatus } from './types.js';
import { shouldActionUseDirectThreadLifecycle } from './sync-contract.js';
import { withDirectTaskLifecycle } from './task-lifecycle.js';
import { runTaskSync } from './task-sync.js';
import type { TaskService } from './service.js';
import { createTaskService } from './service.js';
import {
  resolveTasksForum,
  createTaskThread,
  closeTaskThread,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
  ensureUnarchived,
  findExistingThreadForTask,
} from './thread-ops.js';
import type { TaskDiscordForumChannel } from './discord-types.js';
import { getThreadIdFromTask } from './thread-helpers.js';
import { autoTagTask } from './auto-tag.js';
import { taskThreadCache } from './thread-cache.js';
import type {
  TaskActionResult,
  TaskActionRunContext,
} from './task-action-runner-types.js';

/** Pre-computed set for filtering status names from tag candidates. */
const STATUS_NAME_SET = new Set<string>(TASK_STATUSES);

function resolveTaskService(taskCtx: TaskContext): TaskService {
  if (taskCtx.taskService) return taskCtx.taskService;
  const taskService = createTaskService(taskCtx.store);
  taskCtx.taskService = taskService;
  return taskService;
}

function resolveTaskId(action: { taskId?: string }): string {
  return (action.taskId ?? '').trim();
}

function scheduleRepairSync(taskCtx: TaskContext, taskId: string, ctx: TaskActionRunContext): void {
  runTaskSync(taskCtx, { client: ctx.client, guild: ctx.guild }).catch((err) => {
    taskCtx.log?.warn({ err, taskId }, 'tasks:repair sync failed');
  });
}

export async function handleTaskCreate(
  action: Extract<TaskActionRequest, { type: 'taskCreate' }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
  if (!action.title) {
    return { ok: false, error: 'taskCreate requires a title' };
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

    if (!shouldActionUseDirectThreadLifecycle(action.type)) return;

    const latest = taskCtx.store.get(task.id) ?? task;
    const currentThreadId = getThreadIdFromTask(latest);
    if (currentThreadId) {
      threadId = currentThreadId;
      return;
    }

    if (labels.includes('no-thread') || (latest.labels ?? []).includes('no-thread')) {
      return;
    }

    try {
      const forum = await resolveTasksForum(ctx.guild, taskCtx.forumId);
      if (!forum) return;

      const existing = await findExistingThreadForTask(forum as TaskDiscordForumChannel, task.id);
      if (existing) {
        threadId = existing;
      } else {
        const taskForThread: TaskData = { ...latest, labels };
        threadId = await createTaskThread(
          forum as TaskDiscordForumChannel,
          taskForThread,
          taskCtx.tagMap,
          taskCtx.mentionUserId,
        );
      }

      try {
        const newest = taskCtx.store.get(task.id) ?? task;
        const newestThreadId = getThreadIdFromTask(newest);
        if (newestThreadId !== threadId) {
          taskService.update(task.id, { externalRef: `discord:${threadId}` });
        }
      } catch (err) {
        taskCtx.log?.warn({ err, taskId: task.id, threadId }, 'tasks:external-ref update failed');
      }
    } catch (err) {
      needsRepairSync = true;
      taskCtx.log?.warn({ err, taskId: task.id }, 'tasks:thread creation failed');
    }
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

    const threadId = getThreadIdFromTask(updatedTask);
    if (threadId && shouldActionUseDirectThreadLifecycle(action.type)) {
      try {
        await ensureUnarchived(ctx.client, threadId);
        await updateTaskThreadName(ctx.client, threadId, updatedTask);
      } catch (err) {
        needsRepairSync = true;
        taskCtx.log?.warn({ err, taskId, threadId }, 'tasks:thread name update failed');
      }
      try {
        await updateTaskStarterMessage(ctx.client, threadId, updatedTask, taskCtx.sidebarMentionUserId);
      } catch (err) {
        needsRepairSync = true;
        taskCtx.log?.warn({ err, taskId, threadId }, 'tasks:starter message update failed');
      }
      try {
        await updateTaskThreadTags(ctx.client, threadId, updatedTask, taskCtx.tagMap);
      } catch (err) {
        needsRepairSync = true;
        taskCtx.log?.warn({ err, taskId, threadId }, 'tasks:thread tag update failed');
      }
    }
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

    const threadId = getThreadIdFromTask(closedTask);
    if (threadId && shouldActionUseDirectThreadLifecycle(action.type)) {
      try {
        await closeTaskThread(ctx.client, threadId, closedTask, taskCtx.tagMap, taskCtx.log);
      } catch (err) {
        needsRepairSync = true;
        taskCtx.log?.warn({ err, taskId, threadId }, 'tasks:thread close failed');
      }
    }
  });

  if (needsRepairSync) {
    scheduleRepairSync(taskCtx, taskId, ctx);
  }

  taskThreadCache.invalidate();
  taskCtx.forumCountSync?.requestUpdate();
  return { ok: true, summary: `Task ${taskId} closed${action.reason ? `: ${action.reason}` : ''}` };
}
