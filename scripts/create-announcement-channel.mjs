/**
 * One-off script: create an announcement channel called 'updates' under the 'News' category.
 * Usage: node scripts/create-announcement-channel.mjs
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

    // Find or create the 'News' category (case-insensitive)
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'news',
    );
    if (!category) {
      category = await guild.channels.create({ name: 'News', type: ChannelType.GuildCategory });
      console.log(`Created category '${category.name}' (${category.id})`);
    }

    let channel;
    try {
      channel = await guild.channels.create({
        name: 'updates',
        type: ChannelType.GuildAnnouncement,
        parent: category.id,
      });
      console.log(`Created announcement channel #${channel.name} (${channel.id}) under category '${category.name}'`);
    } catch (err) {
      if (err.code === 50035) {
        console.warn('Server does not support announcement channels (Community feature required). Creating as text channel instead.');
        channel = await guild.channels.create({
          name: 'updates',
          type: ChannelType.GuildText,
          parent: category.id,
        });
        console.log(`Created text channel #${channel.name} (${channel.id}) under category '${category.name}'`);
      } else {
        throw err;
      }
    }
  } finally {
    client.destroy();
  }
});

client.login(token);
