/**
 * Delete a Discord message by channel ID and message ID.
 * Usage: node scripts/delete-message.mjs <channelId> <messageId>
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const [channelId, messageId] = process.argv.slice(2);
if (!channelId || !messageId) {
  process.stderr.write('Usage: node scripts/delete-message.mjs <channelId> <messageId>\n');
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

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      process.stderr.write(`Channel ${channelId} not found or not a text channel\n`);
      client.destroy();
      process.exit(1);
    }
    const message = await channel.messages.fetch(messageId);
    await message.delete();
    process.stdout.write(`Deleted message ${messageId} in channel ${channelId}\n`);
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
