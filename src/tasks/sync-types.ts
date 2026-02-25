import type { TaskDiscordClient, TaskDiscordGuild } from './discord-types.js';

export type TaskSyncRunContext = {
  client: TaskDiscordClient;
  guild: TaskDiscordGuild;
};

export type TaskSyncRunOptions = {
  skipPhase5?: boolean;
};
