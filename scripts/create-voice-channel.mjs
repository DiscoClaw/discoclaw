/**
 * One-off script: create a voice channel called 'team-call'.
 * Usage: node scripts/create-voice-channel.mjs
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

    const channel = await guild.channels.create({
      name: 'team-call',
      type: ChannelType.GuildVoice,
    });

    console.log(`Created voice channel #${channel.name} (${channel.id})`);
  } finally {
    client.destroy();
  }
});

client.login(token);
