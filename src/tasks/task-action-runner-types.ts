import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import type {
  TaskDiscordClient,
  TaskDiscordGuild,
} from './discord-types.js';

export type TaskActionRunContext = {
  client: TaskDiscordClient;
  guild: TaskDiscordGuild;
};

export type TaskActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

export type TaskActionHandler<T extends TaskActionRequest['type'] = TaskActionRequest['type']> = (
  action: Extract<TaskActionRequest, { type: T }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
) => Promise<TaskActionResult>;
