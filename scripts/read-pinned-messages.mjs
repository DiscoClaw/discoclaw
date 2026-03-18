/**
 * Fetch pinned messages from a named Discord channel.
 * Usage: node scripts/read-pinned-messages.mjs <channel-name>
 * Output: JSON array of { id, author, timestamp, content } to stdout, errors to stderr.
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const channelName = process.argv[2];
if (!channelName) {
  process.stderr.write('Usage: node scripts/read-pinned-messages.mjs <channel-name>\n');
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

    const pinned = await found.messages.fetchPinned();
    const result = [...pinned.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({
        id: m.id,
        author: m.author.username,
        bot: m.author.bot,
        timestamp: m.createdAt.toISOString(),
        content: m.content,
        embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, color: e.color })),
      }));

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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
