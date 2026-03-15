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

const guildId = (getArgValue('--guild-id') ?? '').trim();
if (!guildId) {
  process.stderr.write('Missing required --guild-id\n');
  process.exit(1);
}

const apply = (getArgValue('--apply') ?? '').trim() === '1';
const limitRaw = (getArgValue('--limit') ?? '').trim();
const limit = limitRaw ? Math.max(1, Number(limitRaw)) : 500;
const delayMsRaw = (getArgValue('--delay-ms') ?? '').trim();
const delayMs = delayMsRaw ? Math.max(0, Number(delayMsRaw)) : 250;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

client.once('ready', async () => {
  try {
    const guild = await client.guilds.fetch(guildId);

    // Active threads only. Archived threads can't be joined/usefully interacted with
    // until they are unarchived.
    const fetched = await guild.channels.fetchActiveThreads();
    const threads = fetched?.threads;
    const list = threads ? Array.from(threads.values()) : [];

    const joinable = list.filter((t) => (typeof t.joinable === 'boolean' ? t.joinable : true));
    const needJoin = joinable.filter((t) => (typeof t.joined === 'boolean' ? !t.joined : true));

    process.stdout.write(
      `Active threads: ${list.length}; joinable: ${joinable.length}; to-join: ${needJoin.length}; apply=${apply ? '1' : '0'}\n`,
    );

    let joined = 0;
    let attempted = 0;
    for (const t of needJoin.slice(0, limit)) {
      attempted++;
      const id = String(t.id ?? '');
      const parentId = String(t.parentId ?? '');
      if (!apply) {
        process.stdout.write(`DRYRUN join thread ${id} parent=${parentId}\n`);
        continue;
      }
      try {
        if (typeof t.join === 'function') {
          await t.join();
          joined++;
          process.stdout.write(`JOINED thread ${id} parent=${parentId}\n`);
        } else {
          process.stdout.write(`SKIP thread ${id} (no join())\n`);
        }
      } catch (err) {
        process.stdout.write(`FAIL thread ${id}: ${String(err)}\n`);
      }
      if (delayMs) await sleep(delayMs);
    }

    if (apply) {
      process.stdout.write(`Done. Joined ${joined}/${attempted} (limit=${limit}).\n`);
    } else {
      process.stdout.write(`Done. Dry run listed ${attempted} (limit=${limit}). Re-run with --apply 1 to join.\n`);
    }

    client.destroy();
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    client.destroy();
    process.exit(1);
  }
});

client.login(token).catch((err) => {
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});

