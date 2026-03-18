/**
 * Crosspost the latest message in a named announcement channel.
 * Usage: node scripts/crosspost-latest.mjs <channel-name>
 * Output: result message to stdout, errors to stderr.
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const channelName = process.argv[2];
if (!channelName) {
  process.stderr.write('Usage: node scripts/crosspost-latest.mjs <channel-name>\n');
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
        (c) => c && c.name.toLowerCase() === name && c.type === ChannelType.GuildAnnouncement,
      );
      if (found) break;
    }
    if (!found) {
      process.stderr.write(`Announcement channel #${name} not found\n`);
      client.destroy();
      process.exit(1);
    }

    const messages = await found.messages.fetch({ limit: 1 });
    const latest = messages.first();
    if (!latest) {
      process.stderr.write(`No messages found in #${name}\n`);
      client.destroy();
      process.exit(1);
    }

    await latest.crosspost();
    process.stdout.write(`Crossposted message ${latest.id} in #${name}: "${latest.content.slice(0, 80)}${latest.content.length > 80 ? '…' : ''}"\n`);
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
