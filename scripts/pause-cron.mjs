/**
 * One-off script: archive (pause) a cron job by thread name.
 * Archiving the forum thread triggers forum-sync to disable the scheduler job.
 *
 * Usage: node scripts/pause-cron.mjs <thread-name>
 *   e.g. node scripts/pause-cron.mjs daily-digest
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/pause-cron.mjs <thread-name>');
  process.exit(1);
}

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const forumId = process.env.DISCOCLAW_CRON_FORUM;
if (!forumId) throw new Error('DISCOCLAW_CRON_FORUM not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const forum = client.channels.cache.get(forumId);
    if (!forum) throw new Error(`Cron forum channel ${forumId} not found`);

    const { threads } = await forum.threads.fetchActive();
    const thread = threads.find((t) => t.name === name);

    if (!thread) {
      // Also check archived threads.
      const archived = await forum.threads.fetchArchived({ limit: 100 });
      const archivedThread = archived.threads.find((t) => t.name === name);
      if (archivedThread) {
        console.log(`"${name}" is already archived (paused). threadId=${archivedThread.id}`);
        return;
      }
      console.error(`No cron thread named "${name}" found (active or archived).`);
      process.exit(1);
    }

    await thread.setArchived(true, `Paused via pause-cron.mjs`);
    console.log(`Paused cron "${name}" (threadId=${thread.id}) — thread archived.`);
  } finally {
    client.destroy();
  }
});

client.login(token);
