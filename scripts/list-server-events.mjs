/**
 * One-off script: list all upcoming scheduled events in the server.
 * Usage: node scripts/list-server-events.mjs
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

    const upcoming = events
      .filter(e => e.scheduledStartAt && e.scheduledStartAt > new Date())
      .sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);

    if (upcoming.size === 0) {
      console.log('No upcoming events.');
    } else {
      console.log(`${upcoming.size} upcoming event(s):\n`);
      for (const event of upcoming.values()) {
        const start = event.scheduledStartAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' });
        const end = event.scheduledEndAt
          ? event.scheduledEndAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeStyle: 'short' })
          : null;
        const loc = event.entityMetadata?.location ?? event.channel?.name ?? '—';
        const status = event.status;
        console.log(`• ${event.name}`);
        console.log(`  Start:    ${start} PT${end ? ` → ${end} PT` : ''}`);
        console.log(`  Location: ${loc}`);
        console.log(`  Status:   ${status}`);
        if (event.description) console.log(`  Desc:     ${event.description}`);
        console.log(`  ID:       ${event.id}`);
        console.log();
      }
    }
  } finally {
    client.destroy();
  }
});

client.login(token);
