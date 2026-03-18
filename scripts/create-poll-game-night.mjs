/**
 * Create a poll: 'What day for game night?' with options Monday, Wednesday, Friday.
 * Usage: node scripts/create-poll-game-night.mjs [channel-name]
 * Defaults to #general if no channel is specified.
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(1); }

const targetName = (process.argv[2] ?? 'general').replace(/^#/, '').toLowerCase();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    let found = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      found = channels.find(
        (c) => c && c.name.toLowerCase() === targetName &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );
      if (found) break;
    }
    if (!found) {
      process.stderr.write(`Channel #${targetName} not found\n`);
      client.destroy();
      process.exit(1);
    }

    const msg = await found.send({
      poll: {
        question: { text: 'What day for game night?' },
        answers: [
          { text: 'Monday' },
          { text: 'Wednesday' },
          { text: 'Friday' },
        ],
        duration: 24,
        allowMultiselect: false,
      },
    });

    console.log(`Poll created (message ${msg.id}) in #${found.name}`);
    client.destroy();
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    client.destroy();
    process.exit(1);
  }
});

client.login(token).catch((err) => {
  clearTimeout(timeout);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
