import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import { runTaskSync } from './task-sync.js';
import { reloadTagMapInPlace } from './tag-map.js';
import type {
  TaskActionResult,
  TaskActionRunContext,
} from './task-action-runner-types.js';

function resolveTaskId(action: { taskId?: string }): string {
  return (action.taskId ?? '').trim();
}

export async function handleTaskShow(
  action: Extract<TaskActionRequest, { type: 'taskShow' }>,
  _ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
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

export async function handleTaskList(
  action: Extract<TaskActionRequest, { type: 'taskList' }>,
  _ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
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

export async function handleTaskSync(
  _action: Extract<TaskActionRequest, { type: 'taskSync' }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
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

export async function handleTagMapReload(
  _action: Extract<TaskActionRequest, { type: 'tagMapReload' }>,
  _ctx: TaskActionRunContext,
  taskCtx: TaskContext,
): Promise<TaskActionResult> {
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
