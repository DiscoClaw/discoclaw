import fs from 'node:fs/promises';
import { ChannelType } from 'discord.js';
import type { CategoryChannel, Client, ForumChannel, Guild, GuildBasedChannel } from 'discord.js';
import type { LoggerLike } from './action-types.js';
import { stripCountSuffix } from './forum-count-sync.js';

export type SystemScaffold = {
  guildId: string;
  systemCategoryId: string;
  statusChannelId?: string;
  cronsForumId?: string;
  beadsForumId?: string;
};

function norm(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

export function isSnowflake(s: string): boolean {
  return /^\d{8,}$/.test((s ?? '').trim());
}

export function selectBootstrapGuild(
  client: Client,
  guildIdFromEnv: string | undefined,
  log?: LoggerLike,
): Guild | null {
  const gid = (guildIdFromEnv ?? '').trim();
  if (gid) {
    const g = client.guilds.cache.get(gid) ?? null;
    if (!g) log?.warn({ guildId: gid }, 'system-bootstrap: guild not found; skipping');
    return g;
  }

  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 1) return guilds[0] ?? null;

  log?.warn(
    { guildCount: guilds.length },
    'system-bootstrap: multiple guilds (or none) and DISCORD_GUILD_ID not set; skipping',
  );
  return null;
}

async function tryFetchChannel(guild: Guild, id: string): Promise<GuildBasedChannel | null> {
  const trimmed = (id ?? '').trim();
  if (!trimmed || !isSnowflake(trimmed)) return null;
  try {
    const fetched = await guild.channels.fetch(trimmed);
    return (fetched as GuildBasedChannel) ?? null;
  } catch {
    return null;
  }
}

function findByNameAndType(
  guild: Guild,
  name: string,
  type: ChannelType,
): GuildBasedChannel | null {
  const want = norm(name);
  // Pass 1: exact name match.
  const exact = guild.channels.cache.find((c) => c.type === type && norm(c.name) === want);
  if (exact) return (exact as GuildBasedChannel);
  // Pass 2: match after stripping count suffix (defense-in-depth).
  const stripped = guild.channels.cache.find((c) =>
    c.type === type && norm(stripCountSuffix(c.name)) === want,
  );
  return (stripped as GuildBasedChannel) ?? null;
}

function findAnyByName(
  guild: Guild,
  name: string,
): GuildBasedChannel[] {
  const want = norm(name);
  const out: GuildBasedChannel[] = [];
  for (const c of guild.channels.cache.values()) {
    if (norm((c as any)?.name ?? '') === want) out.push(c as GuildBasedChannel);
  }
  return out;
}

async function moveUnderCategory(
  ch: GuildBasedChannel,
  parentCategoryId: string,
  log?: LoggerLike,
): Promise<boolean> {
  const current = String((ch as any)?.parentId ?? '');
  if (current === parentCategoryId) return false;
  try {
    if (typeof (ch as any).setParent === 'function') {
      await (ch as any).setParent(parentCategoryId);
    } else if (typeof (ch as any).edit === 'function') {
      await (ch as any).edit({ parent: parentCategoryId });
    } else {
      return false;
    }
    return true;
  } catch (err) {
    log?.warn({ err, channelId: (ch as any)?.id, name: (ch as any)?.name }, 'system-bootstrap: failed to move channel');
    return false;
  }
}

export async function ensureSystemCategory(guild: Guild, log?: LoggerLike): Promise<CategoryChannel | null> {
  const existing = findByNameAndType(guild, 'System', ChannelType.GuildCategory) as CategoryChannel | null;
  if (existing) return existing;
  try {
    const created = await guild.channels.create({
      name: 'System',
      type: ChannelType.GuildCategory,
    } as any);
    return created as CategoryChannel;
  } catch (err) {
    log?.warn({ err }, 'system-bootstrap: failed to create System category');
    return null;
  }
}

async function ensureChild(
  guild: Guild,
  parentCategoryId: string,
  spec: { name: string; type: ChannelType.GuildText | ChannelType.GuildForum; topic?: string },
  log?: LoggerLike,
  existingId?: string,
): Promise<{ id?: string; created: boolean; moved: boolean }> {
  // ID-first lookup when configured.
  if (existingId && isSnowflake(existingId)) {
    const byId = guild.channels.cache.get(existingId) ?? await tryFetchChannel(guild, existingId);
    if (byId) {
      if (byId.type !== spec.type) {
        log?.error(
          { existingId, name: spec.name, expected: ChannelType[spec.type], actual: ChannelType[byId.type] },
          'system-bootstrap: configured ID has wrong channel type',
        );
        return { created: false, moved: false }; // fail closed — no ID returned
      }
      const moved = await moveUnderCategory(byId, parentCategoryId, log);
      // Reconcile topic if it differs from expected.
      if (spec.topic && (byId as any).topic !== spec.topic) {
        try {
          await (byId as any).edit({ topic: spec.topic });
          log?.info({ name: spec.name }, 'system-bootstrap: reconciled topic');
        } catch (err) {
          log?.warn({ err, name: spec.name }, 'system-bootstrap: failed to reconcile topic');
        }
      }
      return { id: String((byId as any).id ?? ''), created: false, moved };
    }
    // ID not found — stale config or deleted channel. Fall through to name-based lookup / creation.
    log?.warn({ existingId, name: spec.name }, 'system-bootstrap: configured channel ID not found in guild, falling back to name lookup');
  }

  const exact = findByNameAndType(guild, spec.name, spec.type);
  if (exact) {
    const moved = await moveUnderCategory(exact, parentCategoryId, log);
    // Reconcile topic if it differs from expected.
    if (spec.topic && (exact as any).topic !== spec.topic) {
      try {
        await (exact as any).edit({ topic: spec.topic });
        log?.info({ name: spec.name }, 'system-bootstrap: reconciled topic');
      } catch (err) {
        log?.warn({ err, name: spec.name }, 'system-bootstrap: failed to reconcile topic');
      }
    }
    return { id: String((exact as any).id ?? ''), created: false, moved };
  }

  const nameClash = findAnyByName(guild, spec.name).filter((c) => c.type !== spec.type);
  if (nameClash.length > 0) {
    log?.warn(
      { name: spec.name, wantType: ChannelType[spec.type], foundTypes: nameClash.map((c) => ChannelType[(c as any).type] ?? String((c as any).type)) },
      'system-bootstrap: name exists with different type; skipping creation',
    );
    return { created: false, moved: false };
  }

  try {
    const created = await guild.channels.create({
      name: spec.name,
      type: spec.type,
      parent: parentCategoryId,
      topic: spec.topic,
    } as any);
    return { id: String((created as any)?.id ?? ''), created: true, moved: false };
  } catch (err) {
    log?.warn({ err, name: spec.name, type: ChannelType[spec.type] }, 'system-bootstrap: failed to create channel');
    return { created: false, moved: false };
  }
}

export async function ensureSystemScaffold(
  params: { guild: Guild; ensureBeads: boolean; botDisplayName?: string; existingCronsId?: string; existingBeadsId?: string },
  log?: LoggerLike,
): Promise<SystemScaffold | null> {
  const { guild, ensureBeads } = params;

  const system = await ensureSystemCategory(guild, log);
  if (!system) return null;

  const created: string[] = [];
  const moved: string[] = [];

  const status = await ensureChild(
    guild,
    system.id,
    { name: 'status', type: ChannelType.GuildText, topic: `${params.botDisplayName ?? 'Discoclaw'} status (online/offline/errors).` },
    log,
  );
  if (status.created) created.push('status');
  if (status.moved) moved.push('status');

  const crons = await ensureChild(
    guild,
    system.id,
    { name: 'crons', type: ChannelType.GuildForum, topic: 'Cron jobs are managed by the bot. Use bot commands to create scheduled tasks. Do not create threads manually — they will be archived.' },
    log,
    params.existingCronsId,
  );
  if (crons.created) created.push('crons');
  if (crons.moved) moved.push('crons');

  let beads: { id?: string; created: boolean; moved: boolean } | null = null;
  if (ensureBeads) {
    beads = await ensureChild(
      guild,
      system.id,
      { name: 'beads', type: ChannelType.GuildForum, topic: 'Beads are managed by the bot. Use bead commands or the bd CLI to create tasks. Do not create threads manually — they will be archived.' },
      log,
      params.existingBeadsId,
    );
    if (beads.created) created.push('beads');
    if (beads.moved) moved.push('beads');
  }

  if (created.length > 0 || moved.length > 0) {
    log?.info(
      {
        guildId: guild.id,
        systemCategoryId: system.id,
        created,
        moved,
      },
      'system-bootstrap:ensured',
    );
  }

  const result: SystemScaffold = {
    guildId: guild.id,
    systemCategoryId: system.id,
  };
  if (status.id) result.statusChannelId = status.id;
  if (crons.id) result.cronsForumId = crons.id;
  if (beads?.id) result.beadsForumId = beads.id;
  return result;
}

// ---------------------------------------------------------------------------
// Forum tag bootstrapping
// ---------------------------------------------------------------------------

/**
 * Ensure a forum channel has tags matching a tag-map file.
 * Creates missing tags on the Discord forum and writes their IDs back to the
 * **dataDir** tag-map file (never mutates repo files).
 *
 * Returns the number of tags created.
 */
export async function ensureForumTags(
  guild: Guild,
  forumId: string,
  tagMapPath: string,
  log?: LoggerLike,
): Promise<number> {
  let tagMap: Record<string, string>;
  try {
    const raw = await fs.readFile(tagMapPath, 'utf8');
    tagMap = JSON.parse(raw) as Record<string, string>;
  } catch {
    return 0;
  }

  const forum = guild.channels.cache.get(forumId);
  if (!forum || forum.type !== ChannelType.GuildForum) return 0;
  const forumChannel = forum as ForumChannel;

  // Build a set of existing tag names (case-insensitive).
  const existingTags = forumChannel.availableTags ?? [];
  const existingNames = new Set(existingTags.map((t) => t.name.toLowerCase()));

  // Identify tags that need to be created.
  const toCreate: string[] = [];
  let backfilled = 0;
  for (const [name, id] of Object.entries(tagMap)) {
    if (id) continue; // Already has a Discord tag ID.
    if (existingNames.has(name.toLowerCase())) {
      // Tag exists on the forum but not in our map — backfill the ID.
      const existing = existingTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing && existing.id) {
        tagMap[name] = existing.id;
        backfilled++;
      }
      continue;
    }
    toCreate.push(name);
  }

  if (toCreate.length === 0 && backfilled === 0) {
    // Nothing to create, nothing changed.
    return 0;
  }

  // Discord forums allow max 20 tags.
  const maxNew = Math.max(0, 20 - existingTags.length);
  const creating = toCreate.slice(0, maxNew);

  if (creating.length > 0) {
    try {
      const newTags = [
        ...existingTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
        ...creating.map((name) => ({ name })),
      ];
      await forumChannel.edit({ availableTags: newTags as any });

      // Re-fetch to get the created tag IDs.
      const updated = guild.channels.cache.get(forumId) as ForumChannel | undefined;
      const updatedTags = updated?.availableTags ?? [];
      for (const name of creating) {
        const created = updatedTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (created) tagMap[name] = created.id;
      }
    } catch (err) {
      log?.warn({ err, forumId, tagCount: creating.length }, 'system-bootstrap: failed to create forum tags');
      return 0;
    }
  }

  // Write the updated tag map back to the dataDir file.
  try {
    await fs.writeFile(tagMapPath, JSON.stringify(tagMap, null, 2) + '\n', 'utf8');
  } catch (err) {
    log?.warn({ err, tagMapPath }, 'system-bootstrap: failed to write tag map');
  }

  log?.info({ forumId, tagsCreated: creating.length }, 'system-bootstrap: forum tags ensured');
  return creating.length;
}
