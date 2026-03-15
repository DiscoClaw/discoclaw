import {
  TaskDiscordChannelType,
  type TaskDiscordForumChannel,
  type TaskDiscordGuild,
} from './discord-types.js';
import type { TaskData, TagMap } from './types.js';
import {
  buildAppliedTagsWithStatus,
  buildTaskStarterContent,
  buildThreadName,
  taskIdToken,
} from './thread-helpers.js';

// ---------------------------------------------------------------------------
// Forum channel resolution
// ---------------------------------------------------------------------------

/** Resolve a forum channel by name or ID in a specific guild (multi-guild safe). */
export async function resolveTasksForum(
  guild: TaskDiscordGuild,
  nameOrId: string,
): Promise<TaskDiscordForumChannel | null> {
  // Fast path: cached by ID.
  const byId = guild.channels.cache.get(nameOrId);
  if (byId && byId.type === TaskDiscordChannelType.GuildForum) return byId as TaskDiscordForumChannel;

  // If it's an ID, try fetching directly (covers cache misses).
  try {
    const fetched = await guild.channels.fetch(nameOrId);
    if (fetched && fetched.type === TaskDiscordChannelType.GuildForum) return fetched as TaskDiscordForumChannel;
  } catch {
    // Not an ID or fetch failed; fall through to name lookup.
  }

  const want = nameOrId.toLowerCase();
  const ch = guild.channels.cache.find(
    (c) => c.type === TaskDiscordChannelType.GuildForum && c.name.toLowerCase() === want,
  );
  return (ch as TaskDiscordForumChannel) ?? null;
}

/** Create a new forum thread for a task. Returns the thread ID. */
export async function createTaskThread(
  forum: TaskDiscordForumChannel,
  task: TaskData,
  tagMap: TagMap,
  mentionUserId?: string,
): Promise<string> {
  const name = buildThreadName(task.id, task.title, task.status);

  // Resolve forum tag IDs from task labels.
  const appliedTagIds: string[] = [];
  for (const label of task.labels ?? []) {
    // Try the label directly, then strip common prefixes (tag:, label:).
    const cleaned = label.replace(/^(tag|label):/, '');
    const tagId = tagMap[cleaned] ?? tagMap[label];
    if (tagId) appliedTagIds.push(tagId);
  }
  const uniqueTagIds = buildAppliedTagsWithStatus(
    [...new Set(appliedTagIds)],
    task.status,
    tagMap,
  );

  const message = buildTaskStarterContent(task, mentionUserId).slice(0, 2000);

  const thread = await forum.threads.create({
    name,
    message: {
      content: message,
      // Prevent accidental @everyone/@here from task descriptions.
      allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
    },
    appliedTags: uniqueTagIds,
  });

  return thread.id;
}

export async function findExistingThreadForTask(
  forum: TaskDiscordForumChannel,
  taskId: string,
  opts?: { archivedLimit?: number },
): Promise<string | null> {
  const token = taskIdToken(taskId);
  const archivedLimit = Math.max(1, Math.min(100, opts?.archivedLimit ?? 100));

  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: archivedLimit, fetchAll: true });
  const all = [...active.threads.values(), ...archived.threads.values()];

  const matches = all.filter((t) => typeof t?.name === 'string' && t.name.includes(token));
  if (matches.length === 0) return null;
  // Prefer active (non-archived) threads; among ties, pick the newest (highest snowflake ID).
  const sorted = [...matches].sort((a, b) => {
    const aActive = a.archived ? 0 : 1;
    const bActive = b.archived ? 0 : 1;
    if (aActive !== bActive) return bActive - aActive;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });
  return sorted[0].id;
}
