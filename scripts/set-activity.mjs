/**
 * Set the bot's activity presence.
 * Usage: node scripts/set-activity.mjs <activity-name> [activityType]
 * activityType: Playing (default), Listening, Watching, Competing
 */
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { config } from 'dotenv';

config();

const activityName = process.argv[2];
const activityType = process.argv[3] ?? 'Playing';

if (!activityName) {
  process.stderr.write('Usage: node scripts/set-activity.mjs <activity-name> [activityType]\n');
  process.exit(1);
}

const TYPE_MAP = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing,
};

const typeNum = TYPE_MAP[activityType];
if (typeNum === undefined) {
  process.stderr.write(`Invalid activityType "${activityType}"; must be one of: Playing, Listening, Watching, Competing\n`);
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', () => {
  clearTimeout(timeout);
  client.user.setActivity({ name: activityName, type: typeNum });
  process.stdout.write(`Activity set to ${activityType}: ${activityName}\n`);
  // Brief pause to let the presence update propagate before disconnecting.
  setTimeout(() => {
    client.destroy();
    process.exit(0);
  }, 2_000);
});

client.login(token).catch((err) => {
  clearTimeout(timeout);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
