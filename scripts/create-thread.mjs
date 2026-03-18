/**
 * Create a thread 'Bug Report' in #dev and post 'tracking issue'.
 */
import { Client, GatewayIntentBits, ChannelType, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    let devChannel = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      devChannel = channels.find(
        (c) => c && c.name.toLowerCase() === 'dev' &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildForum),
      );
      if (devChannel) break;
    }
    if (!devChannel) {
      process.stderr.write('#dev channel not found\n');
      client.destroy();
      process.exit(1);
    }

    const thread = await devChannel.threads.create({
      name: 'Bug Report',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      type: ChannelType.PublicThread,
    });
    console.log(`Created thread "${thread.name}" (${thread.id}) in #${devChannel.name}`);

    await thread.send('tracking issue');
    console.log('Posted "tracking issue" to thread.');

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
