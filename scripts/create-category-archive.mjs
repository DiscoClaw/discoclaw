/**
 * One-off script: create a category called 'Archive'.
 * Usage: node scripts/create-category-archive.mjs
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');

    const category = await guild.channels.create({
      name: 'Archive',
      type: ChannelType.GuildCategory,
    });

    console.log(`Created category "${category.name}" (${category.id})`);
  } finally {
    client.destroy();
  }
});

client.login(token);
