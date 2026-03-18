/**
 * Search all text channels for messages matching a query string.
 * Usage: node scripts/search-all-channels.mjs <query> [--limit N] [--pages N]
 *   --limit N    Max results to return total (default 50)
 *   --pages N    Pages of 100 messages to scan per channel (default 3)
 * Output: JSON array of { channel, id, author, timestamp, content } to stdout.
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

function arg(flag, defaultValue = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return defaultValue;
  return process.argv[idx + 1] ?? defaultValue;
}

const query = process.argv[2];
if (!query) {
  process.stderr.write('Usage: node scripts/search-all-channels.mjs <query> [--limit N] [--pages N]\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const maxResults = Math.min(200, Math.max(1, Number(arg('--limit', '50'))));
const maxPages = Math.min(10, Math.max(1, Number(arg('--pages', '3'))));
const queryLower = query.toLowerCase();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 120s\n');
  client.destroy();
  process.exit(1);
}, 120_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  const results = [];

  try {
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()].filter(
        (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );

      process.stderr.write(`Searching ${textChannels.length} channels in "${guild.name}"...\n`);

      for (const channel of textChannels) {
        if (results.length >= maxResults) break;
        try {
          let before = undefined;
          for (let page = 0; page < maxPages; page++) {
            const fetchOpts = { limit: 100 };
            if (before) fetchOpts.before = before;
            const batch = await channel.messages.fetch(fetchOpts);
            if (batch.size === 0) break;

            for (const m of batch.values()) {
              const text = m.content.toLowerCase();
              const embedText = m.embeds.map((e) => [e.title, e.description].join(' ')).join(' ').toLowerCase();
              if (text.includes(queryLower) || embedText.includes(queryLower)) {
                results.push({
                  channel: channel.name,
                  id: m.id,
                  author: m.author.username,
                  bot: m.author.bot,
                  timestamp: m.createdAt.toISOString(),
                  content: m.content,
                  embeds: m.embeds.map((e) => ({ title: e.title, description: e.description })),
                });
                if (results.length >= maxResults) break;
              }
            }

            // next page cursor
            const oldest = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
            before = oldest?.id;
            if (batch.size < 100) break;
          }
        } catch (err) {
          process.stderr.write(`  Skipping #${channel.name}: ${err.message}\n`);
        }
      }
    }

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
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
