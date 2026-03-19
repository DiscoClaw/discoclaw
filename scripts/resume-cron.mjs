/**
 * One-off script: unarchive (resume) a cron job by thread name.
 * Unarchiving the forum thread triggers forum-sync to re-register the scheduler job.
 *
 * Usage: node scripts/resume-cron.mjs <thread-name>
 *   e.g. node scripts/resume-cron.mjs daily-digest
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/resume-cron.mjs <thread-name>');
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

    // Check active threads first.
    const { threads } = await forum.threads.fetchActive();
    const active = threads.find((t) => t.name === name);
    if (active) {
      console.log(`"${name}" is already active (not paused). threadId=${active.id}`);
      return;
    }

    // Check archived threads.
    const archived = await forum.threads.fetchArchived({ limit: 100 });
    const thread = archived.threads.find((t) => t.name === name);
    if (!thread) {
      console.error(`No archived cron thread named "${name}" found.`);
      process.exit(1);
    }

    await thread.setArchived(false, `Resumed via resume-cron.mjs`);
    console.log(`Resumed cron "${name}" (threadId=${thread.id}) — thread unarchived.`);
  } finally {
    client.destroy();
  }
});

client.login(token);
