/**
 * Delete a Discord channel by name or ID.
 * Usage: node scripts/delete-channel.mjs <channelNameOrId>
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const [target] = process.argv.slice(2);
if (!target) {
  process.stderr.write('Usage: node scripts/delete-channel.mjs <channelNameOrId>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(1); }
if (!guildId) { process.stderr.write('Missing DISCORD_GUILD_ID\n'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();

    // Match by ID or name (strip leading # if provided)
    const name = target.replace(/^#/, '').toLowerCase();
    const channel = channels.find(
      (ch) => ch.id === target || ch.name.toLowerCase() === name
    );

    if (!channel) {
      process.stderr.write(`Channel "${target}" not found in guild\n`);
      client.destroy();
      process.exit(1);
    }

    process.stdout.write(`Deleting #${channel.name} (${channel.id})...\n`);
    await channel.delete();
    process.stdout.write(`Deleted.\n`);
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
