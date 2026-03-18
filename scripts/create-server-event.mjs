/**
 * One-off script: create a 'Game Night' scheduled event for Saturday Mar 21 at 9pm PT.
 * Usage: node scripts/create-server-event.mjs
 */
import { Client, GatewayIntentBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import { config } from 'dotenv';

config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');

    // Saturday 2026-03-21 at 9:00 PM PDT (UTC-7) = 2026-03-22T04:00:00.000Z
    const startTime = new Date('2026-03-22T04:00:00.000Z');
    const endTime   = new Date('2026-03-22T06:00:00.000Z'); // +2 hours

    const event = await guild.scheduledEvents.create({
      name: 'Game Night',
      scheduledStartTime: startTime.toISOString(),
      scheduledEndTime: endTime.toISOString(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: 'TBD' },
    });

    console.log(`Created event "${event.name}" (${event.id}) — starts ${startTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`);
  } finally {
    client.destroy();
  }
});

client.login(token);
