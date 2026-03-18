/**
 * One-off script: create a daily 9am "good morning" cron job in #general.
 * Creates a new forum thread in the cron forum so the bot picks it up automatically.
 *
 * Usage: node scripts/create-good-morning-cron.mjs
 *
 * To change the timezone, edit TIMEZONE below (e.g. 'America/New_York', 'Europe/London').
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const THREAD_NAME = 'good-morning-general';
const TIMEZONE = 'America/Los_Angeles';
const CONTENT = `**Schedule:** \`3 9 * * *\` (${TIMEZONE})
**Channel:** #general

Post "good morning" in the channel.`;

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const forumId = process.env.DISCOCLAW_CRON_FORUM;
if (!forumId) throw new Error('DISCOCLAW_CRON_FORUM not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const forum = client.channels.cache.get(forumId);
    if (!forum) throw new Error(`Cron forum channel ${forumId} not found`);
    if (forum.type !== 15 /* GuildForum */) throw new Error('DISCOCLAW_CRON_FORUM is not a forum channel');

    // Check it doesn't already exist.
    const active = await forum.threads.fetchActive();
    if (active.threads.find((t) => t.name === THREAD_NAME)) {
      console.log(`Cron "${THREAD_NAME}" already exists and is active. Nothing to do.`);
      client.destroy();
      process.exit(0);
    }
    const archived = await forum.threads.fetchArchived();
    if (archived.threads.find((t) => t.name === THREAD_NAME)) {
      console.log(`Cron "${THREAD_NAME}" exists but is archived (paused). Run resume-cron.mjs to re-enable it.`);
      client.destroy();
      process.exit(0);
    }

    const thread = await forum.threads.create({
      name: THREAD_NAME,
      message: { content: CONTENT },
    });

    console.log(`Created cron thread "${THREAD_NAME}" (${thread.id}).`);
    console.log('The bot will detect the new thread and register the schedule automatically.');
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    client.destroy();
    process.exit(1);
  }
  client.destroy();
  process.exit(0);
});

client.login(token).catch((err) => {
  clearTimeout(timeout);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
