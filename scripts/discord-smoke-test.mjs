import 'dotenv/config';
import process from 'node:process';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const timeoutMsRaw = (process.env.DISCORD_SMOKE_TEST_TIMEOUT_MS ?? '').trim();
const timeoutMs = timeoutMsRaw ? Math.max(1, Number(timeoutMsRaw)) : 12_000;

// Optional: require the bot to actually be in a specific guild (server).
// Prefer CLI flags since some environments get flaky when adding per-command env vars.
const guildIdArg = getArgValue('--guild-id');
const guildIdEnv = (process.env.DISCORD_SMOKE_TEST_GUILD_ID ?? '').trim();
const guildId = (guildIdArg ?? guildIdEnv).trim();

const printGuilds = process.argv.includes('--print-guilds')
  || (process.env.DISCORD_SMOKE_TEST_PRINT_GUILDS ?? '').trim() === '1';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const t = setTimeout(() => {
  process.stderr.write(`Smoke test timed out after ${timeoutMs}ms\n`);
  client.destroy();
  process.exit(1);
}, timeoutMs);

client.once('ready', async () => {
  clearTimeout(t);
  try {
    const guildIds = Array.from(client.guilds.cache.keys());
    const guildCount = guildIds.length;

    if (guildId) {
      // Use the gateway-provided cache so we don't depend on REST/DNS.
      // With the Guilds intent enabled, this is a reliable membership check.
      if (!client.guilds.cache.has(guildId)) {
        throw new Error('guild_not_in_cache');
      }
      process.stdout.write(
        `Discord bot ready (guilds: ${guildCount}; guild ok: ${guildId})\n`,
      );
    } else {
      process.stdout.write(`Discord bot ready (guilds: ${guildCount})\n`);
    }

    if (printGuilds) {
      // Keep output bounded in case this bot is in many guilds.
      const head = guildIds.slice(0, 25);
      process.stdout.write(`Guild IDs (first ${head.length}${guildCount > head.length ? ' of ' + guildCount : ''}): ${head.join(',')}\n`);
    }
    client.destroy();
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (guildId && msg === 'guild_not_in_cache') {
      process.stderr.write(
        `Discord bot ready, but it does not appear to be in guild ${guildId} (not in gateway cache). ` +
          `Set DISCORD_SMOKE_TEST_PRINT_GUILDS=1 to print the guild IDs it is in.\n`,
      );
    } else {
      process.stderr.write(
        `Discord bot ready, but guild check failed for ${guildId}: ${String(err)}\n`,
      );
    }
    client.destroy();
    process.exit(1);
  }
});

client.login(token).catch((err) => {
  clearTimeout(t);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
