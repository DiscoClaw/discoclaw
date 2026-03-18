/**
 * One-off script: cancel (delete) the 'Game Night' scheduled event.
 * Usage: node scripts/cancel-server-event.mjs
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');

    const events = await guild.scheduledEvents.fetch();
    const gameNight = events.find(e => e.name === 'Game Night');

    if (!gameNight) {
      console.log('No "Game Night" event found.');
      return;
    }

    await gameNight.delete();
    console.log(`Cancelled event "${gameNight.name}" (${gameNight.id})`);
  } finally {
    client.destroy();
  }
});

client.login(token);
