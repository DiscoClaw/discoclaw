/**
 * Purge all messages from a named Discord channel.
 * Uses bulkDelete for messages < 14 days old, sequential delete for older ones.
 * Usage: node scripts/purge-channel.mjs <channel-name> [--dry-run]
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const channelName = process.argv[2];
if (!channelName) {
  process.stderr.write('Usage: node scripts/purge-channel.mjs <channel-name> [--dry-run]\n');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const BULK_DELETE_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000; // 13 days (safe margin under 14-day Discord limit)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 60s waiting for login\n');
  client.destroy();
  process.exit(1);
}, 60_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const name = channelName.replace(/^#/, '').toLowerCase();
    let channel = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      channel = channels.find(
        (c) => c && c.name.toLowerCase() === name &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      ) ?? null;
      if (channel) break;
    }

    if (!channel) {
      process.stderr.write(`Channel #${name} not found\n`);
      client.destroy();
      process.exit(1);
    }

    console.log(`Purging #${channel.name} (${channel.id})${dryRun ? ' [DRY RUN]' : ''}`);

    let totalDeleted = 0;
    const now = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100 });
      if (batch.size === 0) break;

      const recent = batch.filter((m) => now - m.createdTimestamp < BULK_DELETE_MAX_AGE_MS);
      const old = batch.filter((m) => now - m.createdTimestamp >= BULK_DELETE_MAX_AGE_MS);

      // Bulk delete recent messages (up to 100 at once)
      if (recent.size > 0) {
        if (dryRun) {
          console.log(`  [dry-run] would bulk-delete ${recent.size} recent message(s)`);
        } else {
          await channel.bulkDelete(recent, true);
          console.log(`  bulk-deleted ${recent.size} message(s)`);
        }
        totalDeleted += recent.size;
      }

      // Sequential delete for messages older than 14 days
      for (const message of old.values()) {
        if (dryRun) {
          console.log(`  [dry-run] would delete old message ${message.id} (${message.createdAt.toISOString()})`);
        } else {
          try {
            await message.delete();
            console.log(`  deleted old message ${message.id}`);
          } catch (err) {
            process.stderr.write(`  failed to delete ${message.id}: ${String(err)}\n`);
          }
          await sleep(1000); // stay well under rate limits for individual deletes
        }
        totalDeleted += 1;
      }

      // If batch was < 100, we've reached the end
      if (batch.size < 100) break;

      await sleep(500);
    }

    console.log(`\nDone. ${dryRun ? 'Would have deleted' : 'Deleted'} ${totalDeleted} message(s).`);
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
