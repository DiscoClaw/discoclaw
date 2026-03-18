/**
 * Move a channel into a category.
 * Usage: node scripts/move-channel.mjs <channelName> <categoryName>
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const [channelTarget, categoryTarget] = process.argv.slice(2);
if (!channelTarget || !categoryTarget) {
  process.stderr.write('Usage: node scripts/move-channel.mjs <channelName> <categoryName>\n');
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

    const channelName = channelTarget.replace(/^#/, '').toLowerCase();
    const channel = channels.find(
      (ch) => ch.type !== ChannelType.GuildCategory && ch.name.toLowerCase() === channelName
    );
    if (!channel) {
      process.stderr.write(`Channel "${channelTarget}" not found\n`);
      client.destroy();
      process.exit(1);
    }

    const catName = categoryTarget.toLowerCase();
    const category = channels.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === catName
    );
    if (!category) {
      process.stderr.write(`Category "${categoryTarget}" not found\n`);
      client.destroy();
      process.exit(1);
    }

    await channel.setParent(category.id, { lockPermissions: false });
    process.stdout.write(`Moved #${channel.name} → ${category.name}\n`);
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
