import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { bdAddLabel, bdShow, bdUpdate } from './bd-cli.js';
import { findExistingThreadForBead, createBeadThread, ensureUnarchived, getThreadIdFromBead, resolveBeadsForum, updateBeadThreadName, updateBeadThreadTags, closeBeadThread, isThreadArchived } from './discord-sync.js';
import type { BeadData } from './types.js';
import { loadTagMap } from './discord-sync.js';

function env(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function envOpt(name: string): string | undefined {
  const v = (process.env[name] ?? '').trim();
  return v || undefined;
}

function parseTagsCsv(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((t) => t.trim()).filter(Boolean);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '\u2026';
}

function hasNoThread(bead: BeadData, extraLabels: string[]): boolean {
  const labels = new Set([...(bead.labels ?? []), ...extraLabels]);
  return labels.has('no-thread');
}

async function run(): Promise<void> {
  const sub = process.argv[2] ?? '';
  const beadId = process.argv[3] ?? '';
  if (!sub || !beadId) {
    throw new Error('Usage: bead-hooks-cli <on-create|on-update|on-status-change|on-close> <bead-id> [--tags a,b]');
  }

  const args = process.argv.slice(4);
  let tagsCsv: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tags') {
      tagsCsv = args[i + 1];
      i++;
    }
  }

  const discordToken = env('DISCORD_TOKEN');
  const guildId = env('DISCORD_GUILD_ID');
  const forumId = env('DISCOCLAW_BEADS_FORUM');
  const beadsCwd = envOpt('DISCOCLAW_BEADS_CWD') ?? process.cwd();
  const dataDir = envOpt('DISCOCLAW_DATA_DIR');
  const tagMapPath = envOpt('DISCOCLAW_BEADS_TAG_MAP')
    ?? (dataDir ? path.join(dataDir, 'beads', 'tag-map.json') : undefined);
  const mentionUserId = envOpt('DISCOCLAW_BEADS_MENTION_USER');

  const extraLabels = parseTagsCsv(tagsCsv);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(discordToken);
  await new Promise<void>((resolve) => client.once('ready', () => resolve()));

  try {
    const guild = await client.guilds.fetch(guildId);
    const forum = await resolveBeadsForum(guild, forumId);
    if (!forum) throw new Error(`Beads forum not found: ${forumId}`);

    const tagMap = tagMapPath ? await loadTagMap(tagMapPath) : {};

    const bead = await bdShow(beadId, beadsCwd);
    if (!bead) throw new Error(`Bead not found: ${beadId}`);

    if (sub === 'on-create') {
      if (hasNoThread(bead, extraLabels)) return;

      const existingRef = getThreadIdFromBead(bead);
      if (existingRef) return;

      const deduped = await findExistingThreadForBead(forum, bead.id);
      if (deduped) {
        await bdUpdate(bead.id, { externalRef: `discord:${deduped}` }, beadsCwd);
        // Backfill tag labels if provided.
        for (const t of extraLabels) {
          try { await bdAddLabel(bead.id, `tag:${t}`, beadsCwd); } catch {}
        }
        return;
      }

      const beadForThread: BeadData = { ...bead, labels: [...new Set([...(bead.labels ?? []), ...extraLabels])] };
      const threadId = await createBeadThread(forum, beadForThread, tagMap, mentionUserId);
      try { await bdUpdate(bead.id, { externalRef: `discord:${threadId}` }, beadsCwd); } catch {}

      for (const t of extraLabels) {
        try { await bdAddLabel(bead.id, `tag:${t}`, beadsCwd); } catch {}
      }

      return;
    }

    const threadId = getThreadIdFromBead(bead);
    if (!threadId) return;

    if (sub === 'on-status-change') {
      await ensureUnarchived(client, threadId);
      await updateBeadThreadName(client, threadId, bead);
      await updateBeadThreadTags(client, threadId, bead, tagMap);
      return;
    }

    if (sub === 'on-update') {
      await ensureUnarchived(client, threadId);
      await updateBeadThreadName(client, threadId, bead);

      const title = bead.title || 'Untitled';
      const status = bead.status || 'open';
      const priority = `P${bead.priority ?? 2}`;
      const desc = truncate(bead.description ?? 'No description', 1800);
      const content =
        `**Update**\n` +
        `**Priority:** ${priority}\n` +
        `**Status:** ${status}\n` +
        `**Title:** ${title}\n\n` +
        `${desc}`;

      // Avoid accidental mentions from bead content.
      try {
        const thread = await client.channels.fetch(threadId);
        if (thread && thread.isThread()) {
          try {
            await thread.send({ content: truncate(content, 2000), allowedMentions: { parse: [], users: [] } });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore fetch failures
      }
      return;
    }

    if (sub === 'on-close') {
      // Lightweight check: skip if thread is already archived to avoid
      // duplicate close messages from concurrent close operations.
      if (await isThreadArchived(client, threadId)) return;
      await closeBeadThread(client, threadId, bead, tagMap);
      return;
    }

    throw new Error(`Unknown subcommand: ${sub}`);
  } finally {
    client.destroy();
  }
}

await run();
