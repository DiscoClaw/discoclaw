import {
  TaskDiscordChannelType,
  type TaskDiscordClient,
  type TaskDiscordForumChannel,
  type TaskDiscordGuild,
  type TaskDiscordThreadChannel,
} from './discord-types.js';
import type { TaskData, TagMap } from './types.js';
import {
  buildAppliedTagsWithStatus,
  buildTaskStarterContent,
  buildThreadName,
  getStatusTagIds,
  getThreadIdFromTask,
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

async function fetchThreadChannel(
  client: TaskDiscordClient,
  threadId: string,
): Promise<TaskDiscordThreadChannel | null> {
  const cached = client.channels.cache.get(threadId);
  if (cached && cached.isThread()) return cached as TaskDiscordThreadChannel;
  try {
    const fetched = await client.channels.fetch(threadId);
    if (fetched && fetched.isThread()) return fetched as TaskDiscordThreadChannel;
    return null;
  } catch {
    return null;
  }
}

/** Order-insensitive comparison of two tag ID arrays. */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (arr: string[]) => [...arr].sort();
  return sorted(a).every((v, i) => v === sorted(b)[i]);
}

// ---------------------------------------------------------------------------
// Thread lifecycle operations
// ---------------------------------------------------------------------------

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

/** Post a close summary, rename with checkmark, and archive the thread. */
export async function closeTaskThread(
  client: TaskDiscordClient,
  threadId: string,
  task: TaskData,
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

  const closedName = buildThreadName(task.id, task.title, task.status);

  // Remove mention from starter message to clear sidebar visibility.
  try {
    const starter = await thread.fetchStarterMessage();
    if (starter && starter.author.id === client.user?.id) {
      const cleanContent = buildTaskStarterContent(task);
      if (starter.content !== cleanContent) {
        await starter.edit({
          content: cleanContent.slice(0, 2000),
          allowedMentions: { parse: [], users: [] },
        });
      }
    }
  } catch { /* ignore — close should still proceed */ }

  const reason = task.close_reason || 'Closed';

  try {
    await thread.send({
      content: `**Task Closed**\n${reason}`,
      allowedMentions: { parse: [], users: [] },
    });
  } catch {
    // Ignore send failures (thread may already be archived).
  }

  try {
    await thread.setName(closedName);
  } catch (err) {
    log?.warn({ err, taskId: task.id, threadId }, 'closeTaskThread: setName failed');
  }

  if (tagMap) {
    try {
      const current: string[] = (thread as any).appliedTags ?? [];
      const updated = buildAppliedTagsWithStatus(current, task.status, tagMap);
      if (!tagsEqual(current, updated)) {
        await (thread as any).edit({ appliedTags: updated });
      }
    } catch (err) {
      log?.warn({ err, taskId: task.id, threadId }, 'closeTaskThread: tag update failed');
    }
  }

  try {
    await thread.setArchived(true);
  } catch {
    // Ignore archive failures.
  }
}

/** Check if a thread is archived. Returns true if the thread is archived or doesn't exist. */
export async function isThreadArchived(client: TaskDiscordClient, threadId: string): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return true; // Thread doesn't exist — treat as archived.
  return thread.archived === true;
}

/** Check if a task thread is already in its final closed state (archived + correct name + correct tags). */
export async function isTaskThreadAlreadyClosed(
  client: TaskDiscordClient,
  threadId: string,
  task: TaskData,
  tagMap?: TagMap,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return true; // Thread doesn't exist — nothing to close.
  const closedName = buildThreadName(task.id, task.title, task.status);
  if (thread.archived !== true || thread.name !== closedName) return false;
  // If tagMap provided, verify tags match expected closed state.
  if (tagMap && getStatusTagIds(tagMap).size > 0) {
    const current: string[] = (thread as any).appliedTags ?? [];
    const expected = buildAppliedTagsWithStatus(current, task.status, tagMap);
    if (!tagsEqual(current, expected)) return false;
  }
  return true;
}

/** Update a thread's name to reflect current task state. */
export async function updateTaskThreadName(
  client: TaskDiscordClient,
  threadId: string,
  task: TaskData,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return false;

  const newName = buildThreadName(task.id, task.title, task.status);
  const current = thread.name;
  if (current === newName) return false;

  await thread.setName(newName);
  return true;
}

/** Update a thread's starter message to reflect current task state. When mentionUserId is provided, the mention is included for sidebar visibility. */
export async function updateTaskStarterMessage(
  client: TaskDiscordClient,
  threadId: string,
  task: TaskData,
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

  const newContent = buildTaskStarterContent(task, mentionUserId);
  if (starter.content === newContent) return false;

  await starter.edit({
    content: newContent.slice(0, 2000),
    allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
  });
  return true;
}

/** Update a thread's forum tags to reflect current task status. */
export async function updateTaskThreadTags(
  client: TaskDiscordClient,
  threadId: string,
  task: TaskData,
  tagMap: TagMap,
): Promise<boolean> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return false;
  const current: string[] = (thread as any).appliedTags ?? [];
  const updated = buildAppliedTagsWithStatus(current, task.status, tagMap);
  if (tagsEqual(current, updated)) return false;
  await (thread as any).edit({ appliedTags: updated });
  return true;
}

/** Unarchive a thread if it's currently archived. */
export async function ensureUnarchived(client: TaskDiscordClient, threadId: string): Promise<void> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) return;
  if (thread.archived) {
    await thread.setArchived(false);
  }
}
