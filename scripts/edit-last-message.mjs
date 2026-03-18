/**
 * Edit the bot's last message in a named channel.
 * Usage: node scripts/edit-last-message.mjs <channel-name> <new-content>
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const channelName = process.argv[2];
const newContent = process.argv[3];

if (!channelName || !newContent) {
  process.stderr.write('Usage: node scripts/edit-last-message.mjs <channel-name> <new-content>\n');
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

    // Fetch recent messages and find the last one sent by this bot
    const messages = await found.messages.fetch({ limit: 50 });
    const botId = client.user.id;
    const last = messages.find((m) => m.author.id === botId);
    if (!last) {
      process.stderr.write(`No bot messages found in #${name}\n`);
      client.destroy();
      process.exit(1);
    }

    await last.edit(newContent);
    process.stdout.write(`Edited message ${last.id} in #${name}\n`);
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
