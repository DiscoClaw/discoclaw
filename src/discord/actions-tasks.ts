import type { ForumChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import type { StatusPoster } from './status-channel.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { TagMap, TaskData, TaskStatus } from '../tasks/types.js';
import type { ForumCountSync } from './forum-count-sync.js';
import { TASK_STATUSES, isTaskStatus } from '../tasks/types.js';
import { shouldActionUseDirectThreadLifecycle } from '../tasks/sync-contract.js';
import { withDirectTaskLifecycle } from '../tasks/task-lifecycle.js';
import type { TaskSyncCoordinatorLike } from '../tasks/task-sync.js';
import { runTaskSync } from '../tasks/task-sync.js';
import type { TaskStore } from '../tasks/store.js';
import {
  resolveTasksForum,
  createTaskThread,
  closeTaskThread,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
  ensureUnarchived,
  getThreadIdFromTask,
  reloadTagMapInPlace,
  findExistingThreadForTask,
} from '../beads/discord-sync.js';
import { autoTagBead } from '../beads/auto-tag.js';
import { beadThreadCache } from '../beads/bead-thread-cache.js';

/** Pre-computed set for filtering status names from tag candidates. */
const STATUS_NAME_SET = new Set<string>(TASK_STATUSES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskCreatePayload = {
  title: string;
  description?: string;
  priority?: number;
  tags?: string;
};

type TaskUpdatePayload = {
  taskId?: string;
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
};

type TaskClosePayload = {
  taskId?: string;
  reason?: string;
};

type TaskShowPayload = {
  taskId?: string;
};

type TaskListPayload = {
  status?: string;
  label?: string;
  limit?: number;
};

export type TaskActionRequest =
  | ({ type: 'taskCreate' } & TaskCreatePayload)
  | ({ type: 'taskUpdate' } & TaskUpdatePayload)
  | ({ type: 'taskClose' } & TaskClosePayload)
  | ({ type: 'taskShow' } & TaskShowPayload)
  | ({ type: 'taskList' } & TaskListPayload)
  | { type: 'taskSync' }
  | { type: 'tagMapReload' };

const TASK_TYPE_MAP: Record<TaskActionRequest['type'], true> = {
  taskCreate: true,
  taskUpdate: true,
  taskClose: true,
  taskShow: true,
  taskList: true,
  taskSync: true,
  tagMapReload: true,
};
export const TASK_ACTION_TYPES = new Set<string>(Object.keys(TASK_TYPE_MAP));

export type TaskContext = {
  tasksCwd?: string;
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  runtime: RuntimeAdapter;
  autoTag: boolean;
  autoTagModel: string;
  mentionUserId?: string;
  sidebarMentionUserId?: string;
  statusPoster?: StatusPoster;
  log?: LoggerLike;
  syncCoordinator?: TaskSyncCoordinatorLike;
  forumCountSync?: ForumCountSync;
};

function resolveTaskId(action: { taskId?: string }): string {
  return (action.taskId ?? '').trim();
}

function scheduleRepairSync(taskCtx: TaskContext, taskId: string, ctx: ActionContext): void {
  runTaskSync(taskCtx, { client: ctx.client, guild: ctx.guild }).catch((err) => {
    taskCtx.log?.warn({ err, taskId }, 'tasks:repair sync failed');
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeTaskAction(
  action: TaskActionRequest,
  ctx: ActionContext,
  taskCtx: TaskContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'taskCreate': {
      if (!action.title) {
        return { ok: false, error: 'taskCreate requires a title' };
      }

      // Resolve labels from tags string (comma-separated).
      const labels: string[] = [];
      if (action.tags) {
        labels.push(...action.tags.split(',').map((t) => t.trim()).filter(Boolean));
      }

      const task = taskCtx.store.create({
        title: action.title,
        description: action.description,
        priority: action.priority,
        labels,
      });

      let threadId = '';
      let needsRepairSync = false;
      await withDirectTaskLifecycle(task.id, async () => {
        // Auto-tag if enabled and we have available tags (excluding status tags).
        const tagNames = Object.keys(taskCtx.tagMap).filter((k) => !STATUS_NAME_SET.has(k));
        if (taskCtx.autoTag && tagNames.length > 0) {
          try {
            const suggestedTags = await autoTagBead(
              taskCtx.runtime,
              task.title,
              task.description ?? '',
              tagNames,
              { model: taskCtx.autoTagModel, cwd: taskCtx.tasksCwd || process.cwd() },
            );
            for (const tag of suggestedTags) {
              if (!labels.includes(tag)) labels.push(tag);
            }
            for (const tag of suggestedTags) {
              try {
                taskCtx.store.addLabel(task.id, `tag:${tag}`);
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

          // Prefer an existing thread if one is already present for this task.
          const existing = await findExistingThreadForTask(forum as ForumChannel, task.id);
          if (existing) {
            threadId = existing;
          } else {
            const taskForThread: TaskData = { ...latest, labels };
            threadId = await createTaskThread(forum as ForumChannel, taskForThread, taskCtx.tagMap, taskCtx.mentionUserId);
          }

          // Backfill thread link if needed. Re-check store for concurrent updates.
          try {
            const newest = taskCtx.store.get(task.id) ?? task;
            const newestThreadId = getThreadIdFromTask(newest);
            if (newestThreadId !== threadId) {
              taskCtx.store.update(task.id, { externalRef: `discord:${threadId}` });
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

      beadThreadCache.invalidate();
      taskCtx.forumCountSync?.requestUpdate();
      const threadNote = threadId ? ' (thread linked)' : '';
      return { ok: true, summary: `Task ${task.id} created: "${task.title}"${threadNote}` };
    }

    case 'taskUpdate': {
      const taskId = resolveTaskId(action);
      if (!taskId) {
        return { ok: false, error: 'taskUpdate requires taskId' };
      }

      if (action.status && !isTaskStatus(action.status)) {
        return { ok: false, error: `Invalid task status: "${action.status}"` };
      }

      let needsRepairSync = false;
      await withDirectTaskLifecycle(taskId, async () => {
        const updatedTask = taskCtx.store.update(taskId, {
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

        return updatedTask;
      });

      if (needsRepairSync) {
        scheduleRepairSync(taskCtx, taskId, ctx);
      }

      beadThreadCache.invalidate();
      if (action.status) taskCtx.forumCountSync?.requestUpdate();

      const changes: string[] = [];
      if (action.title) changes.push(`title → "${action.title}"`);
      if (action.status) changes.push(`status → ${action.status}`);
      if (action.priority != null) changes.push(`priority → P${action.priority}`);
      return { ok: true, summary: `Task ${taskId} updated: ${changes.join(', ') || 'no changes'}` };
    }

    case 'taskClose': {
      const taskId = resolveTaskId(action);
      if (!taskId) {
        return { ok: false, error: 'taskClose requires taskId' };
      }

      let needsRepairSync = false;
      await withDirectTaskLifecycle(taskId, async () => {
        const closedTask = taskCtx.store.close(taskId, action.reason);

        const threadId = getThreadIdFromTask(closedTask);
        if (threadId && shouldActionUseDirectThreadLifecycle(action.type)) {
          try {
            await closeTaskThread(ctx.client, threadId, closedTask, taskCtx.tagMap, taskCtx.log);
          } catch (err) {
            needsRepairSync = true;
            taskCtx.log?.warn({ err, taskId, threadId }, 'tasks:thread close failed');
          }
        }

        return closedTask;
      });

      if (needsRepairSync) {
        scheduleRepairSync(taskCtx, taskId, ctx);
      }

      beadThreadCache.invalidate();
      taskCtx.forumCountSync?.requestUpdate();
      return { ok: true, summary: `Task ${taskId} closed${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'taskShow': {
      const taskId = resolveTaskId(action);
      if (!taskId) {
        return { ok: false, error: 'taskShow requires taskId' };
      }

      const task = taskCtx.store.get(taskId);
      if (!task) {
        return { ok: false, error: `Task "${taskId}" not found` };
      }

      const lines = [
        `**${task.title}** (\`${task.id}\`)`,
        `Status: ${task.status} | Priority: P${task.priority}`,
      ];
      if (task.owner) lines.push(`Owner: ${task.owner}`);
      if (task.labels?.length) lines.push(`Labels: ${task.labels.join(', ')}`);
      if (task.description) lines.push(`\n${task.description.slice(0, 500)}`);
      return { ok: true, summary: lines.join('\n') };
    }

    case 'taskList': {
      const tasks = taskCtx.store.list({
        status: action.status,
        label: action.label,
        limit: action.limit ?? 50,
      });

      if (tasks.length === 0) {
        return { ok: true, summary: 'No tasks found matching the filter.' };
      }

      const lines = tasks.map(
        (t) => `\`${t.id}\` [${t.status}] P${t.priority} — ${t.title}`,
      );
      return { ok: true, summary: lines.join('\n') };
    }

    case 'taskSync': {
      try {
        const result = await runTaskSync(
          taskCtx,
          { client: ctx.client, guild: ctx.guild },
          taskCtx.statusPoster,
        );
        if (!result) {
          return { ok: true, summary: 'Sync already running; changes will be picked up.' };
        }

        return {
          ok: true,
          summary: `Sync complete: ${result.threadsCreated} created, ${result.emojisUpdated} updated, ${result.starterMessagesUpdated} starters, ${result.tagsUpdated} tags, ${result.threadsArchived} archived, ${result.statusesUpdated} status-fixes${result.threadsReconciled ? `, ${result.threadsReconciled} reconciled` : ''}${result.orphanThreadsFound ? `, ${result.orphanThreadsFound} orphans` : ''}${result.warnings ? `, ${result.warnings} warnings` : ''}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Task sync failed: ${msg}` };
      }
    }

    case 'tagMapReload': {
      if (!taskCtx.tagMapPath) {
        return { ok: false, error: 'Tag map path not configured' };
      }
      const oldCount = Object.keys(taskCtx.tagMap).length;
      try {
        await reloadTagMapInPlace(taskCtx.tagMapPath, taskCtx.tagMap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Tag map reload failed: ${msg}` };
      }
      const newCount = Object.keys(taskCtx.tagMap).length;
      const tagList = Object.keys(taskCtx.tagMap);
      const tagsDisplay = tagList.length <= 10
        ? tagList.join(', ')
        : `${tagList.slice(0, 10).join(', ')} (+${tagList.length - 10} more)`;
      return { ok: true, summary: `Tag map reloaded (${oldCount} -> ${newCount}): ${tagsDisplay}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function taskActionsPromptSection(): string {
  return `### Task Tracking

**taskCreate** — Create a new task:
\`\`\`
<discord-action>{"type":"taskCreate","title":"Task title","description":"Optional details","priority":2,"tags":"feature,work"}</discord-action>
\`\`\`
- \`title\` (required): Task title.
- \`description\` (optional): Detailed description.
- \`priority\` (optional): 0-4 (0=highest, default 2).
- \`tags\` (optional): Comma-separated labels/tags.

**taskUpdate** — Update a task's fields:
\`\`\`
<discord-action>{"type":"taskUpdate","taskId":"ws-001","status":"in_progress","priority":1}</discord-action>
\`\`\`
- \`taskId\` (required): Task ID.
- \`title\`, \`description\`, \`priority\`, \`status\` (optional): Fields to update.

**taskClose** — Close a task:
\`\`\`
<discord-action>{"type":"taskClose","taskId":"ws-001","reason":"Done"}</discord-action>
\`\`\`

**taskShow** — Show task details:
\`\`\`
<discord-action>{"type":"taskShow","taskId":"ws-001"}</discord-action>
\`\`\`

**taskList** — List tasks:
\`\`\`
<discord-action>{"type":"taskList","status":"open","limit":10}</discord-action>
\`\`\`
- \`status\` (optional): Filter by status (open, in_progress, blocked, closed, all).
- \`label\` (optional): Filter by label.
- \`limit\` (optional): Max results.

**taskSync** — Run full sync between local task store and Discord threads:
\`\`\`
<discord-action>{"type":"taskSync"}</discord-action>
\`\`\`

**tagMapReload** — Reload tag map from disk (hot-reload without restart):
\`\`\`
<discord-action>{"type":"tagMapReload"}</discord-action>
\`\`\`

#### Task Quality Guidelines
- **Title**: imperative mood, specific, <60 chars. Good: "Add retry logic to webhook handler", "Plan March Denver trip". Bad: "fix stuff".
- **Description** should answer what/why/scope. Use markdown for structure. Include what "done" looks like for larger tasks.
- **Priority**: P0=urgent, P1=important, P2=normal (default), P3=nice-to-have, P4=someday.
- If the user explicitly asks to create a task, always create it.
- Apply the same description quality standards when using taskUpdate to backfill details.

#### Cross-Task References
When interacting with another task, always use task actions with its task ID, not channel-name based messaging actions:
- **Read task content**: \`taskShow <id>\`
- **Update a task**: \`taskUpdate <id>\`
- **Close a task**: \`taskClose <id>\`
- **Find tasks**: \`taskList\` (filter by status or label)
- **Reconcile Discord threads**: \`taskSync\``;
}
