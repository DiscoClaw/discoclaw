/**
 * Send a message to a named channel.
 * Usage: node scripts/send-message.mjs <channel-name> <message>
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const [, , channelName, ...rest] = process.argv;
const message = rest.join(' ');

if (!channelName || !message) {
  process.stderr.write('Usage: node scripts/send-message.mjs <channel-name> <message>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    let target = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      target = channels.find(
        (c) => c && c.name.toLowerCase() === channelName.toLowerCase() &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );
      if (target) break;
    }
    if (!target) {
      process.stderr.write(`#${channelName} channel not found\n`);
      client.destroy();
      process.exit(1);
    }

    await target.send(message);
    console.log(`Sent to #${target.name}`);

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
