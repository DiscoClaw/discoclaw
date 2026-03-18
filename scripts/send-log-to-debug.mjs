/**
 * Send the discoclaw service log to #debug as a file attachment.
 * Usage: node scripts/send-log-to-debug.mjs <log-file-path>
 */
import { Client, GatewayIntentBits, ChannelType, AttachmentBuilder } from 'discord.js';
import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';

config({ path: resolve(process.cwd(), '.env') });

const logPath = process.argv[2];
if (!logPath) {
  process.stderr.write('Usage: node scripts/send-log-to-debug.mjs <log-file-path>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(1); }

const logContent = readFileSync(logPath, 'utf8');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    let debugChannel = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      debugChannel = channels.find(
        (c) => c && c.name.toLowerCase() === 'debug' &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );
      if (debugChannel) break;
    }
    if (!debugChannel) {
      process.stderr.write('#debug channel not found\n');
      client.destroy();
      process.exit(1);
    }

    const attachment = new AttachmentBuilder(Buffer.from(logContent, 'utf8'), { name: 'discoclaw.log' });
    await debugChannel.send({ content: 'discoclaw service log', files: [attachment] });
    console.log(`Sent log to #${debugChannel.name}`);

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
