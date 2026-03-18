/**
 * Remove a reaction from the last message in a named channel.
 * Usage: node scripts/remove-reaction.mjs <channel-name> <emoji>
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const channelName = process.argv[2];
const emoji = process.argv[3];

if (!channelName || !emoji) {
  process.stderr.write('Usage: node scripts/remove-reaction.mjs <channel-name> <emoji>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const name = channelName.replace(/^#/, '').toLowerCase();
    let found = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      found = channels.find(
        (c) => c && c.name.toLowerCase() === name &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );
      if (found) break;
    }
    if (!found) {
      process.stderr.write(`Channel #${name} not found\n`);
      client.destroy();
      process.exit(1);
    }

    const messages = await found.messages.fetch({ limit: 1 });
    const last = messages.first();
    if (!last) {
      process.stderr.write(`No messages found in #${name}\n`);
      client.destroy();
      process.exit(1);
    }

    await last.reactions.resolve(emoji)?.users.remove();
    process.stdout.write(`Removed reaction ${emoji} from message ${last.id}\n`);
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
