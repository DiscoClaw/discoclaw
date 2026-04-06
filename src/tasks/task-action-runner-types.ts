import type { TaskActionRequest } from './task-action-contract.js';
import type { TaskContext } from './task-context.js';
import type {
  TaskDiscordClient,
  TaskDiscordGuild,
} from './discord-types.js';
import { getThreadIdFromTask } from './thread-helpers.js';
import type { TaskData } from './types.js';

export type TaskActionRunContext = {
  client: TaskDiscordClient;
  guild: TaskDiscordGuild;
  channelId?: string;
  messageId?: string;
};

export type TaskActionThreadMetadata = {
  externalRef: string;
  threadId?: string;
  threadGuildId?: string;
  threadUrl?: string;
};

export type TaskActionSuccessResult = {
  ok: true;
  summary: string;
  thread?: TaskActionThreadMetadata;
};

export type TaskActionResult =
  | TaskActionSuccessResult
  | { ok: false; error: string };

export function buildDiscordThreadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

export function getTaskActionThreadMetadata(task: TaskData): TaskActionThreadMetadata | undefined {
  const externalRef = task.external_ref?.trim() ?? '';
  if (!externalRef) return undefined;

  const threadId = getThreadIdFromTask(task) ?? undefined;
  const threadGuildId = task.thread_origin_guild?.trim() || undefined;
  return {
    externalRef,
    ...(threadId ? { threadId } : {}),
    ...(threadGuildId ? { threadGuildId } : {}),
    ...(threadId && threadGuildId
      ? { threadUrl: buildDiscordThreadUrl(threadGuildId, threadId) }
      : {}),
  };
}

export type TaskActionHandler<T extends TaskActionRequest['type'] = TaskActionRequest['type']> = (
  action: Extract<TaskActionRequest, { type: T }>,
  ctx: TaskActionRunContext,
  taskCtx: TaskContext,
) => Promise<TaskActionResult>;
