import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import type { TaskData } from './types.js';
import type { TaskService } from './service.js';
import type { TaskActionRunContext } from './task-action-runner-types.js';
import { shouldActionUseDirectThreadLifecycle } from './sync-contract.js';
import type { TaskDiscordForumChannel } from './discord-types.js';
import {
  closeTaskThread,
  createTaskThread,
  ensureUnarchived,
  findExistingThreadForTask,
  resolveTasksForum,
  updateTaskStarterMessage,
  updateTaskThreadName,
  updateTaskThreadTags,
} from './thread-ops.js';
import { getThreadIdFromTask } from './thread-helpers.js';

export async function ensureCreatedTaskThreadLink(opts: {
  actionType: TaskActionRequest['type'];
  taskCtx: TaskContext;
  runCtx: TaskActionRunContext;
  taskService: TaskService;
  task: TaskData;
  labels: string[];
}): Promise<{ threadId: string; needsRepairSync: boolean }> {
  if (!shouldActionUseDirectThreadLifecycle(opts.actionType)) {
    return { threadId: '', needsRepairSync: false };
  }

  const latest = opts.taskCtx.store.get(opts.task.id) ?? opts.task;
  const currentThreadId = getThreadIdFromTask(latest);
  if (currentThreadId) {
    return { threadId: currentThreadId, needsRepairSync: false };
  }

  if (opts.labels.includes('no-thread') || (latest.labels ?? []).includes('no-thread')) {
    return { threadId: '', needsRepairSync: false };
  }

  try {
    const forum = await resolveTasksForum(opts.runCtx.guild, opts.taskCtx.forumId);
    if (!forum) return { threadId: '', needsRepairSync: false };

    const existing = await findExistingThreadForTask(forum as TaskDiscordForumChannel, opts.task.id);
    const threadId = existing ?? await createTaskThread(
      forum as TaskDiscordForumChannel,
      { ...latest, labels: opts.labels },
      opts.taskCtx.tagMap,
      opts.taskCtx.mentionUserId,
    );

    try {
      const newest = opts.taskCtx.store.get(opts.task.id) ?? opts.task;
      const newestThreadId = getThreadIdFromTask(newest);
      if (newestThreadId !== threadId) {
        opts.taskService.update(opts.task.id, { externalRef: `discord:${threadId}` });
      }
    } catch (err) {
      opts.taskCtx.log?.warn({ err, taskId: opts.task.id, threadId }, 'tasks:external-ref update failed');
    }

    return { threadId, needsRepairSync: false };
  } catch (err) {
    opts.taskCtx.log?.warn({ err, taskId: opts.task.id }, 'tasks:thread creation failed');
    return { threadId: '', needsRepairSync: true };
  }
}

export async function syncUpdatedTaskThread(opts: {
  actionType: TaskActionRequest['type'];
  taskCtx: TaskContext;
  runCtx: TaskActionRunContext;
  taskId: string;
  updatedTask: TaskData;
}): Promise<boolean> {
  const threadId = getThreadIdFromTask(opts.updatedTask);
  if (!threadId || !shouldActionUseDirectThreadLifecycle(opts.actionType)) {
    return false;
  }

  let needsRepairSync = false;
  try {
    await ensureUnarchived(opts.runCtx.client, threadId);
    await updateTaskThreadName(opts.runCtx.client, threadId, opts.updatedTask);
  } catch (err) {
    needsRepairSync = true;
    opts.taskCtx.log?.warn({ err, taskId: opts.taskId, threadId }, 'tasks:thread name update failed');
  }
  try {
    await updateTaskStarterMessage(
      opts.runCtx.client,
      threadId,
      opts.updatedTask,
      opts.taskCtx.sidebarMentionUserId,
    );
  } catch (err) {
    needsRepairSync = true;
    opts.taskCtx.log?.warn({ err, taskId: opts.taskId, threadId }, 'tasks:starter message update failed');
  }
  try {
    await updateTaskThreadTags(opts.runCtx.client, threadId, opts.updatedTask, opts.taskCtx.tagMap);
  } catch (err) {
    needsRepairSync = true;
    opts.taskCtx.log?.warn({ err, taskId: opts.taskId, threadId }, 'tasks:thread tag update failed');
  }

  return needsRepairSync;
}

export async function syncClosedTaskThread(opts: {
  actionType: TaskActionRequest['type'];
  taskCtx: TaskContext;
  runCtx: TaskActionRunContext;
  taskId: string;
  closedTask: TaskData;
}): Promise<boolean> {
  const threadId = getThreadIdFromTask(opts.closedTask);
  if (!threadId || !shouldActionUseDirectThreadLifecycle(opts.actionType)) {
    return false;
  }

  try {
    await closeTaskThread(opts.runCtx.client, threadId, opts.closedTask, opts.taskCtx.tagMap, opts.taskCtx.log);
    return false;
  } catch (err) {
    opts.taskCtx.log?.warn({ err, taskId: opts.taskId, threadId }, 'tasks:thread close failed');
    return true;
  }
}
