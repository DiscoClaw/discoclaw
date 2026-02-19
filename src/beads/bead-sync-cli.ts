import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { loadTagMap } from './discord-sync.js';
import { runBeadSync } from './bead-sync.js';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const discordToken = env('DISCORD_TOKEN');
  const guildId = env('DISCORD_GUILD_ID');
  const forumId = env('DISCOCLAW_BEADS_FORUM');
  const beadsCwd = envOpt('DISCOCLAW_BEADS_CWD') ?? process.cwd();
  const dataDir = envOpt('DISCOCLAW_DATA_DIR');
  const tagMapPath = envOpt('DISCOCLAW_BEADS_TAG_MAP')
    ?? (dataDir ? path.join(dataDir, 'beads', 'tag-map.json') : undefined);
  const tasksPath = envOpt('DISCOCLAW_TASKS_PATH')
    ?? (dataDir ? path.join(dataDir, 'beads', 'tasks.jsonl') : undefined);

  const throttleMs = parseArgInt(args, '--throttle-ms') ?? 250;
  const archivedLimit = parseArgInt(args, '--archived-limit') ?? 200;

  // Load in-process task store.
  const { TaskStore } = await import('../tasks/store.js');
  const store = new TaskStore(tasksPath ? { persistPath: tasksPath } : {});
  if (tasksPath) await store.load();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(discordToken);
  await new Promise<void>((resolve) => client.once('ready', () => resolve()));

  try {
    const guild = await client.guilds.fetch(guildId);
    const tagMap = tagMapPath ? await loadTagMap(tagMapPath) : {};

    const mentionUserId = envOpt('DISCOCLAW_BEADS_MENTION_USER');
    const sidebarRaw = envOpt('DISCOCLAW_BEADS_SIDEBAR');
    const sidebarEnabled = sidebarRaw === '1' || sidebarRaw?.toLowerCase() === 'true';
    const sidebarMentionUserId = sidebarEnabled ? mentionUserId : undefined;

    const result = await runBeadSync({
      client,
      guild,
      forumId,
      tagMap,
      store,
      throttleMs,
      archivedDedupeLimit: archivedLimit,
      mentionUserId: sidebarMentionUserId,
    });

    // Stable machine-readable output (matches legacy script's spirit).
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    client.destroy();
  }
}

// Only execute when invoked directly as a script, not when imported as a module (e.g., in tests).
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main();
}
