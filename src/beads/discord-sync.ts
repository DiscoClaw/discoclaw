import fs from 'node:fs/promises';
import { ChannelType } from 'discord.js';
import type { Client, ForumChannel, Guild, ThreadChannel } from 'discord.js';
import type { BeadData, TagMap } from './types.js';
import { STATUS_EMOJI } from './types.js';

// ---------------------------------------------------------------------------
// Thread name builder
// ---------------------------------------------------------------------------

const THREAD_NAME_MAX = 100;

/** Strip the project prefix from a bead ID: `ws-001` → `001`. */
function shortBeadId(id: string): string {
  const idx = id.indexOf('-');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/** Build a thread name: `{emoji} [{shortId}] {title}`, capped at 100 chars. */
export function buildThreadName(beadId: string, title: string, status: string): string {
  const emoji = STATUS_EMOJI[status] ?? STATUS_EMOJI.open;
  const prefix = `${emoji} [${shortBeadId(beadId)}] `;
  const maxTitle = THREAD_NAME_MAX - prefix.length;
  const trimmedTitle = title.length > maxTitle ? title.slice(0, maxTitle - 1) + '\u2026' : title;
  return `${prefix}${trimmedTitle}`;
}

function beadIdToken(beadId: string): string {
  return `[${shortBeadId(beadId)}]`;
}

// ---------------------------------------------------------------------------
// Forum channel resolution
// ---------------------------------------------------------------------------

/** Resolve a forum channel by name or ID in a specific guild (multi-guild safe). */
export async function resolveBeadsForum(guild: Guild, nameOrId: string): Promise<ForumChannel | null> {
  // Fast path: cached by ID.
  const byId = guild.channels.cache.get(nameOrId);
  if (byId && byId.type === ChannelType.GuildForum) return byId as ForumChannel;

  // If it's an ID, try fetching directly (covers cache misses).
  try {
    const fetched = await guild.channels.fetch(nameOrId);
    if (fetched && fetched.type === ChannelType.GuildForum) return fetched as ForumChannel;
  } catch {
    // Not an ID or fetch failed; fall through to name lookup.
  }

  const want = nameOrId.toLowerCase();
  const ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && c.name.toLowerCase() === want,
  );
  return (ch as ForumChannel) ?? null;
}

// ---------------------------------------------------------------------------
// Thread ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract the Discord thread ID from a bead's external_ref field.
 * Supports formats:
 *   - `discord:<threadId>`
 *   - raw numeric ID
 */
export function getThreadIdFromBead(bead: BeadData): string | null {
  const ref = (bead.external_ref ?? '').trim();
  if (!ref) return null;
  if (ref.startsWith('discord:')) return ref.slice('discord:'.length).trim() || null;
  // Numeric ID.
  if (/^\d+$/.test(ref)) return ref;
  return null;
}

async function fetchThreadChannel(client: Client, threadId: string): Promise<ThreadChannel | null> {
  const cached = client.channels.cache.get(threadId);
  if (cached && cached.isThread()) return cached as ThreadChannel;
  try {
    const fetched = await client.channels.fetch(threadId);
    if (fetched && fetched.isThread()) return fetched as ThreadChannel;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tag map loading
// ---------------------------------------------------------------------------

/** Load a tag-map.json file: `{ "tag-name": "discord-tag-id", ... }`. */
export async function loadTagMap(filePath: string): Promise<TagMap> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as TagMap;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Thread lifecycle operations
// ---------------------------------------------------------------------------

/** Create a new forum thread for a bead. Returns the thread ID. */
export async function createBeadThread(
  forum: ForumChannel,
  bead: BeadData,
  tagMap: TagMap,
  mentionUserId?: string,
): Promise<string> {
  const name = buildThreadName(bead.id, bead.title, bead.status);

  // Resolve forum tag IDs from bead labels.
  const appliedTagIds: string[] = [];
  for (const label of bead.labels ?? []) {
    // Try the label directly, then strip common prefixes (tag:, label:).
    const cleaned = label.replace(/^(tag|label):/, '');
    const tagId = tagMap[cleaned] ?? tagMap[label];
    if (tagId) appliedTagIds.push(tagId);
  }
  const uniqueTagIds = [...new Set(appliedTagIds)];

  const descLines: string[] = [];
  if (bead.description) descLines.push(bead.description);
  descLines.push('');
  descLines.push(`**ID:** \`${bead.id}\``);
  descLines.push(`**Priority:** P${bead.priority ?? 2}`);
  descLines.push(`**Status:** ${bead.status}`);
  if (bead.owner) descLines.push(`**Owner:** ${bead.owner}`);
  if (mentionUserId) descLines.push(`\n<@${mentionUserId}>`);

  const message = descLines.join('\n').slice(0, 2000);

  const thread = await forum.threads.create({
    name,
    message: {
      content: message,
      // Prevent accidental @everyone/@here from bead descriptions.
      allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
    },
    appliedTags: uniqueTagIds.slice(0, 5), // Discord limit: 5 tags
  });

  return thread.id;
}

export async function findExistingThreadForBead(
  forum: ForumChannel,
  beadId: string,
  opts?: { archivedLimit?: number },
): Promise<string | null> {
  const token = beadIdToken(beadId);
  const archivedLimit = Math.max(1, Math.min(1000, opts?.archivedLimit ?? 200));

  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: archivedLimit, fetchAll: true });
  const all = [...active.threads.values(), ...archived.threads.values()];

  const matches = all.filter((t) => typeof t?.name === 'string' && t.name.includes(token));
  if (matches.length === 1) return matches[0].id;
  return null;
}

/** Post a close summary, rename with checkmark, and archive the thread. */
export async function closeBeadThread(
  client: Client,
  threadId: string,
  bead: BeadData,
): Promise<void> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return;

  // Ensure the thread is modifiable even if it was archived previously.
  try {
    if (thread.archived) await thread.setArchived(false);
  } catch {
    // Ignore unarchive failures.
  }

  const closedName = buildThreadName(bead.id, bead.title, 'closed');

  const reason = bead.close_reason || 'Closed';

  try {
    await thread.send({
      content: `**Bead Closed**\n${reason}`,
      allowedMentions: { parse: [], users: [] },
    });
  } catch {
    // Ignore send failures (thread may already be archived).
  }

  try {
    await thread.setName(closedName);
  } catch {
    // Ignore rename failures.
  }

  try {
    await thread.setArchived(true);
  } catch {
    // Ignore archive failures.
  }
}

/** Update a thread's name to reflect current bead state. */
export async function updateBeadThreadName(
  client: Client,
  threadId: string,
  bead: BeadData,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return false;

  const newName = buildThreadName(bead.id, bead.title, bead.status);
  const current = thread.name;
  if (current === newName) return false;

  await thread.setName(newName);
  return true;
}

/** Unarchive a thread if it's currently archived. */
export async function ensureUnarchived(client: Client, threadId: string): Promise<void> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return;
  if (thread.archived) {
    await thread.setArchived(false);
  }
}
