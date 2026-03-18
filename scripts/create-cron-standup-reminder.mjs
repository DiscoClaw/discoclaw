/**
 * One-off script: create a weekly standup reminder cron job at 10:30am Monday.
 * Posts a standup reminder to #team every Monday at 10:30 AM America/Los_Angeles.
 *
 * Usage: node scripts/create-cron-standup-reminder.mjs
 *
 * The thread is created using the bot token so it is bot-owned and accepted
 * by the cron forum-sync subsystem (manually-created threads are rejected).
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const forumId = process.env.DISCOCLAW_CRON_FORUM;
if (!forumId) throw new Error('DISCOCLAW_CRON_FORUM not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const forum = client.channels.cache.get(forumId);
    if (!forum) throw new Error(`Cron forum channel ${forumId} not found`);
    if (forum.type !== 15 /* GuildForum */) throw new Error('DISCOCLAW_CRON_FORUM is not a forum channel');

    const thread = await forum.threads.create({
      name: 'standup-reminder',
      message: {
        content: 'Every Monday at 10:30am America/Los_Angeles, post a standup reminder to #team: "Good morning! 👋 Weekly standup time — drop your updates here: what did you do last week, what\'s on your plate this week, any blockers?"',
      },
    });

    console.log(`Created cron forum thread: ${thread.name} (${thread.id})`);
    console.log('The bot will parse and register this cron job on the next tick.');
  } finally {
    client.destroy();
  }
});

client.login(token);
