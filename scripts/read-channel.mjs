/**
 * Read recent messages from a named channel and scan for errors.
 * Usage: node scripts/read-channel.mjs <channel-name> [limit]
 *
 * Exits 0 if no errors found, 1 if errors found (prints them).
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const [, , channelName, limitArg] = process.argv;
const limit = Math.min(parseInt(limitArg ?? '50', 10) || 50, 100);

if (!channelName) {
  process.stderr.write('Usage: node scripts/read-channel.mjs <channel-name> [limit]\n');
  process.exit(2);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { process.stderr.write('Missing DISCORD_TOKEN\n'); process.exit(2); }

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bexception\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bcrash(ed)?\b/i,
  /\bpanic\b/i,
  /\bfatal\b/i,
  /\b5[0-9]{2}\b/,          // 5xx HTTP codes
  /\bcritical\b/i,
  /\balert\b/i,
  /\bdown\b/i,
  /\bunhandled\b/i,
  /\btimeout\b/i,
  /\bERR_/,
  /\bstack trace\b/i,
  /\bsegfault\b/i,
  /\bOOM\b/,
];

function isErrorMessage(content) {
  return ERROR_PATTERNS.some(p => p.test(content));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 20s\n');
  client.destroy();
  process.exit(2);
}, 20_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    let target = null;
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      target = channels.find(
        (c) => c && c.name.toLowerCase() === channelName.toLowerCase() &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
      );
      if (target) break;
    }

    if (!target) {
      process.stderr.write(`#${channelName} not found\n`);
      client.destroy();
      process.exit(2);
    }

    const messages = await target.messages.fetch({ limit });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const errors = sorted.filter(m => isErrorMessage(m.content));

    if (errors.length === 0) {
      console.log(`#${channelName}: no errors in last ${messages.size} messages.`);
    } else {
      console.log(`#${channelName}: ${errors.length} potential error(s) in last ${messages.size} messages:\n`);
      for (const m of errors) {
        const ts = new Date(m.createdTimestamp).toISOString();
        const author = m.author?.username ?? 'unknown';
        const preview = m.content.slice(0, 300).replace(/\n/g, ' ');
        console.log(`  [${ts}] ${author}: ${preview}`);
      }
    }

    client.destroy();
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    client.destroy();
    process.exit(2);
  }
});

client.login(token).catch((err) => {
  clearTimeout(timeout);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(2);
});
