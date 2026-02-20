import path from 'node:path';
import type { Client, Guild } from 'discord.js';
import { Client as DiscordClient, GatewayIntentBits } from 'discord.js';
import type { TagMap, TaskSyncResult } from './types.js';
import { loadTagMap } from './discord-sync.js';
import { runBeadSync } from './bead-sync.js';
import type { TaskStore } from './store.js';

function env(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function envOpt(name: string): string | undefined {
  const v = (process.env[name] ?? '').trim();
  return v || undefined;
}

export function parseArgInt(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (!v) throw new Error(`${name} requires a value`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export type RunTaskSyncWithStoreOpts = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  store: TaskStore;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  mentionUserId?: string;
};

/**
 * Core sync execution — separated from Discord login/teardown so it can be
 * unit-tested with mocked dependencies.
 */
export async function runTaskSyncWithStore(opts: RunTaskSyncWithStoreOpts): Promise<TaskSyncResult> {
  return runBeadSync({
    client: opts.client,
    guild: opts.guild,
    forumId: opts.forumId,
    tagMap: opts.tagMap,
    store: opts.store,
    throttleMs: opts.throttleMs ?? 250,
    archivedDedupeLimit: opts.archivedDedupeLimit ?? 200,
    mentionUserId: opts.mentionUserId,
  });
}

export async function runTaskSyncCliMain(): Promise<void> {
  const args = process.argv.slice(2);

  const discordToken = env('DISCORD_TOKEN');
  const guildId = env('DISCORD_GUILD_ID');
  const forumId = env('DISCOCLAW_TASKS_FORUM');
  const dataDir = envOpt('DISCOCLAW_DATA_DIR');
  const tagMapPath = envOpt('DISCOCLAW_TASKS_TAG_MAP')
    ?? (dataDir ? path.join(dataDir, 'beads', 'tag-map.json') : undefined);
  const tasksPath = envOpt('DISCOCLAW_TASKS_PATH')
    ?? (dataDir ? path.join(dataDir, 'beads', 'tasks.jsonl') : undefined);

  const throttleMs = parseArgInt(args, '--throttle-ms') ?? 250;
  const archivedLimit = parseArgInt(args, '--archived-limit') ?? 200;

  const { TaskStore: TaskStoreImpl } = await import('./store.js');
  const store = new TaskStoreImpl(tasksPath ? { persistPath: tasksPath } : {});
  if (tasksPath) await store.load();

  const client = new DiscordClient({ intents: [GatewayIntentBits.Guilds] });
  await client.login(discordToken);
  await new Promise<void>((resolve) => client.once('ready', () => resolve()));

  try {
    const guild = await client.guilds.fetch(guildId);
    const tagMap = tagMapPath ? await loadTagMap(tagMapPath) : {};

    const mentionUserId = envOpt('DISCOCLAW_TASKS_MENTION_USER');
    const sidebarRaw = envOpt('DISCOCLAW_TASKS_SIDEBAR');
    const sidebarEnabled = sidebarRaw === '1' || sidebarRaw?.toLowerCase() === 'true';
    const sidebarMentionUserId = sidebarEnabled ? mentionUserId : undefined;

    const result = await runTaskSyncWithStore({
      client,
      guild,
      forumId,
      tagMap,
      store,
      throttleMs,
      archivedDedupeLimit: archivedLimit,
      mentionUserId: sidebarMentionUserId,
    });

    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    client.destroy();
  }
}

export type RunSyncWithStoreOpts = RunTaskSyncWithStoreOpts;
export const runSyncWithStore = runTaskSyncWithStore;

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await runTaskSyncCliMain();
}
