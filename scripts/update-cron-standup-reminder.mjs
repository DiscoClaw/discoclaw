/**
 * One-off script: update the standup-reminder cron to run at 10:30am Monday.
 * Edits the forum thread starter message so the bot re-parses the new schedule.
 *
 * Usage: node scripts/update-cron-standup-reminder.mjs
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const forumId = process.env.DISCOCLAW_CRON_FORUM;
if (!forumId) throw new Error('DISCOCLAW_CRON_FORUM not set');

const THREAD_NAME = 'standup-reminder';
const NEW_CONTENT = '**Schedule:** `30 10 * * 1` (America/Los_Angeles)\n**Channel:** #team\n\nPost a standup reminder: "Good morning! 👋 Weekly standup time — drop your updates here: what did you do last week, what\'s on your plate this week, any blockers?"';

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

    const active = await forum.threads.fetchActive();
    let thread = active.threads.find((t) => t.name === THREAD_NAME);
    if (!thread) {
      const archived = await forum.threads.fetchArchived();
      thread = archived.threads.find((t) => t.name === THREAD_NAME);
    }
    if (!thread) throw new Error(`Thread "${THREAD_NAME}" not found in active or archived threads`);

    const starter = await thread.fetchStarterMessage();
    if (!starter) throw new Error('Could not fetch starter message');
    if (starter.author.id !== client.user.id) throw new Error('Starter message was not authored by this bot — cannot edit it');

    await starter.edit({ content: NEW_CONTENT, allowedMentions: { parse: [] } });
    console.log(`Updated starter message for thread "${THREAD_NAME}" (${thread.id}).`);
    console.log('The bot will re-parse the new schedule on the next message-update event.');
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
