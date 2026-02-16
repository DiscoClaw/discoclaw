import fs from 'node:fs/promises';
import { ChannelType } from 'discord.js';
import type { Client, ForumChannel, Guild, ThreadChannel } from 'discord.js';
import type { BeadData, TagMap } from './types.js';
import { BEAD_STATUSES, STATUS_EMOJI } from './types.js';

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

/**
 * Reload a tag-map.json file and mutate the existing TagMap object in-place.
 * Unlike loadTagMap(), this throws on read/parse/validation failure so callers
 * can catch and preserve the existing map. Only mutates after full validation.
 * Returns the new tag count.
 */
export async function reloadTagMapInPlace(tagMapPath: string, tagMap: TagMap): Promise<number> {
  const raw = await fs.readFile(tagMapPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tag-map.json must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  const newMap: TagMap = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new Error(`tag-map.json value for "${key}" must be a string, got ${typeof val}`);
    }
    newMap[key] = val;
  }
  // Only mutate after full validation
  for (const key of Object.keys(tagMap)) delete tagMap[key];
  Object.assign(tagMap, newMap);
  return Object.keys(tagMap).length;
}

// ---------------------------------------------------------------------------
// Status tag helpers
// ---------------------------------------------------------------------------

/** Returns the set of Discord tag IDs that correspond to bead statuses. */
export function getStatusTagIds(tagMap: TagMap): Set<string> {
  const ids = new Set<string>();
  for (const status of BEAD_STATUSES) {
    const id = tagMap[status];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Strip old status tags, add the new one, preserve content tags.
 * Status tag gets priority: up to 4 content tags + 1 status tag.
 * If no status tag ID exists in tagMap, content tags get all 5 slots.
 */
export function buildAppliedTagsWithStatus(
  currentTagIds: string[],
  status: string,
  tagMap: TagMap,
): string[] {
  const statusIds = getStatusTagIds(tagMap);
  const uniqueContent = [...new Set(currentTagIds.filter(id => !statusIds.has(id)))];
  const newStatusId = tagMap[status];
  if (newStatusId) {
    return [...uniqueContent.slice(0, 4), newStatusId];
  }
  return uniqueContent.slice(0, 5);
}

/** Order-insensitive comparison of two tag ID arrays. */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (arr: string[]) => [...arr].sort();
  return sorted(a).every((v, i) => v === sorted(b)[i]);
}

// ---------------------------------------------------------------------------
// Starter message content builder
// ---------------------------------------------------------------------------

/** Build the starter message content for a bead thread. When mentionUserId is provided, appends a mention for sidebar visibility. */
export function buildBeadStarterContent(bead: BeadData, mentionUserId?: string): string {
  const lines: string[] = [];
  if (bead.description) lines.push(bead.description);
  lines.push('');
  lines.push(`**ID:** \`${bead.id}\``);
  lines.push(`**Priority:** P${bead.priority ?? 2}`);
  lines.push(`**Status:** ${bead.status}`);
  if (bead.owner) lines.push(`**Owner:** ${bead.owner}`);
  if (mentionUserId) {
    lines.push('');
    lines.push(`<@${mentionUserId}>`);
  }
  return lines.join('\n');
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
  const uniqueTagIds = buildAppliedTagsWithStatus(
    [...new Set(appliedTagIds)],
    bead.status,
    tagMap,
  );

  const message = buildBeadStarterContent(bead, mentionUserId).slice(0, 2000);

  const thread = await forum.threads.create({
    name,
    message: {
      content: message,
      // Prevent accidental @everyone/@here from bead descriptions.
      allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
    },
    appliedTags: uniqueTagIds,
  });

  return thread.id;
}

export async function findExistingThreadForBead(
  forum: ForumChannel,
  beadId: string,
  opts?: { archivedLimit?: number },
): Promise<string | null> {
  const token = beadIdToken(beadId);
  const archivedLimit = Math.max(1, Math.min(100, opts?.archivedLimit ?? 100));

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
  tagMap?: TagMap,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return;

  // Ensure the thread is modifiable even if it was archived previously.
  try {
    if (thread.archived) await thread.setArchived(false);
  } catch {
    // Ignore unarchive failures.
  }

  const closedName = buildThreadName(bead.id, bead.title, bead.status);

  // Remove mention from starter message to clear sidebar visibility.
  try {
    const starter = await thread.fetchStarterMessage();
    if (starter && starter.author.id === client.user?.id) {
      const cleanContent = buildBeadStarterContent(bead);
      if (starter.content !== cleanContent) {
        await starter.edit({
          content: cleanContent.slice(0, 2000),
          allowedMentions: { parse: [], users: [] },
        });
      }
    }
  } catch { /* ignore — close should still proceed */ }

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
  } catch (err) {
    log?.warn({ err, beadId: bead.id, threadId }, 'closeBeadThread: setName failed');
  }

  if (tagMap) {
    try {
      const current: string[] = (thread as any).appliedTags ?? [];
      const updated = buildAppliedTagsWithStatus(current, bead.status, tagMap);
      if (!tagsEqual(current, updated)) {
        await (thread as any).edit({ appliedTags: updated });
      }
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'closeBeadThread: tag update failed');
    }
  }

  try {
    await thread.setArchived(true);
  } catch {
    // Ignore archive failures.
  }
}

/** Check if a thread is archived. Returns true if the thread is archived or doesn't exist. */
export async function isThreadArchived(client: Client, threadId: string): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return true; // Thread doesn't exist — treat as archived.
  return thread.archived === true;
}

/** Check if a bead thread is already in its final closed state (archived + correct name + correct tags). */
export async function isBeadThreadAlreadyClosed(
  client: Client,
  threadId: string,
  bead: BeadData,
  tagMap?: TagMap,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return true; // Thread doesn't exist — nothing to close.
  const closedName = buildThreadName(bead.id, bead.title, bead.status);
  if (thread.archived !== true || thread.name !== closedName) return false;
  // If tagMap provided, verify tags match expected closed state.
  if (tagMap && getStatusTagIds(tagMap).size > 0) {
    const current: string[] = (thread as any).appliedTags ?? [];
    const expected = buildAppliedTagsWithStatus(current, bead.status, tagMap);
    if (!tagsEqual(current, expected)) return false;
  }
  return true;
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

/** Update a thread's starter message to reflect current bead state. When mentionUserId is provided, the mention is included for sidebar visibility. */
export async function updateBeadStarterMessage(
  client: Client,
  threadId: string,
  bead: BeadData,
  mentionUserId?: string,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return false;

  let starter;
  try {
    starter = await thread.fetchStarterMessage();
  } catch {
    return false;
  }
  if (!starter) return false;

  // Only edit messages authored by the bot.
  if (starter.author.id !== client.user?.id) return false;

  const newContent = buildBeadStarterContent(bead, mentionUserId);
  if (starter.content === newContent) return false;

  await starter.edit({
    content: newContent.slice(0, 2000),
    allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
  });
  return true;
}

/** Update a thread's forum tags to reflect current bead status. */
export async function updateBeadThreadTags(
  client: Client,
  threadId: string,
  bead: BeadData,
  tagMap: TagMap,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return false;
  const current: string[] = (thread as any).appliedTags ?? [];
  const updated = buildAppliedTagsWithStatus(current, bead.status, tagMap);
  if (tagsEqual(current, updated)) return false;
  await (thread as any).edit({ appliedTags: updated });
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
