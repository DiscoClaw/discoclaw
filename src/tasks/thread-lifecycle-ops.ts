import type { TaskDiscordClient } from './discord-types.js';
import type { TaskData, TagMap } from './types.js';
import {
  buildAppliedTagsWithStatus,
  buildTaskStarterContent,
  buildThreadName,
  getStatusTagIds,
} from './thread-helpers.js';
import { fetchThreadChannel, tagsEqual } from './thread-ops-shared.js';

type EditableTaskThread = {
  appliedTags?: string[];
  edit: (payload: Record<string, unknown>) => Promise<unknown>;
};

function getThreadAppliedTags(thread: unknown): string[] {
  if (!thread || typeof thread !== 'object') return [];
  const tags = (thread as { appliedTags?: unknown }).appliedTags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string');
}

function asEditableTaskThread(thread: unknown): EditableTaskThread | null {
  if (!thread || typeof thread !== 'object') return null;
  const candidate = thread as { edit?: unknown; appliedTags?: unknown };
  if (typeof candidate.edit !== 'function') return null;
  const appliedTags = getThreadAppliedTags(thread);
  return {
    appliedTags: appliedTags.length > 0 ? appliedTags : undefined,
    edit: (candidate.edit as EditableTaskThread['edit']).bind(candidate),
  };
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

  const editPayload: Record<string, unknown> = { name: closedName };
  if (tagMap) {
    const editable = asEditableTaskThread(thread);
    if (editable) {
      const current = editable.appliedTags ?? [];
      const updated = buildAppliedTagsWithStatus(current, task.status, tagMap);
      if (!tagsEqual(current, updated)) {
        editPayload.appliedTags = updated;
      }
    }
  }

  try {
    const editable = asEditableTaskThread(thread);
    if (editable) {
      await editable.edit(editPayload);
    }
  } catch (err) {
    log?.warn({ err, taskId: task.id, threadId }, 'closeTaskThread: edit failed');
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
    const current = getThreadAppliedTags(thread);
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
  const editable = asEditableTaskThread(thread);
  if (!editable) return false;
  const current = getThreadAppliedTags(thread);
  const updated = buildAppliedTagsWithStatus(current, task.status, tagMap);
  if (tagsEqual(current, updated)) return false;
  await editable.edit({ appliedTags: updated });
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
