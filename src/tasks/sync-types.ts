import type { Client, Guild } from 'discord.js';

export type TaskSyncRunContext = {
  client: Client;
  guild: Guild;
};

export type TaskSyncRunOptions = {
  skipPhase5?: boolean;
};

export type TaskSyncWiring = {
  stop(): void;
};
