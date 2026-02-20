import type { AnyThreadChannel, Client } from 'discord.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { TaskStore } from './store.js';
import type { TagMap } from './types.js';
import { findTaskByThreadId } from './thread-cache.js';
import { buildAppliedTagsWithStatus, buildThreadName } from './discord-sync.js';

/**
 * Canonical task namespace for forum guard wiring.
 */
export type TasksForumGuardOptions = {
  client: Client;
  forumId: string;
  log?: LoggerLike;
  store?: TaskStore;
  tagMap?: TagMap;
};

function isBotOwned(thread: AnyThreadChannel): boolean {
  const botUserId = thread.client?.user?.id ?? '';
  return botUserId !== '' && thread.ownerId === botUserId;
}

async function rejectManualThread(
  thread: AnyThreadChannel,
  log?: LoggerLike,
): Promise<void> {
  log?.info({ threadId: thread.id, name: thread.name, ownerId: thread.ownerId }, 'tasks:forum rejected manual thread');
  try {
    await thread.send(
      'Tasks must be created using bot commands or the `bd` CLI, not by manually creating forum threads.\n\n'
      + 'Ask the bot to create a task for you, or run `bd create` from the terminal.\n\n'
      + 'This thread will be archived.',
    );
  } catch { /* ignore */ }
  try {
    await thread.setArchived(true);
  } catch { /* ignore */ }
}

async function reArchiveTaskThread(
  thread: AnyThreadChannel,
  store: TaskStore,
  tagMap: TagMap,
  log?: LoggerLike,
): Promise<boolean> {
  let task;
  try {
    task = findTaskByThreadId(thread.id, store);
  } catch {
    return false;
  }
  if (!task) return false;

  log?.info({ threadId: thread.id, taskId: task.id }, 'tasks:forum re-archiving known task thread');

  try {
    const current: string[] = (thread as any).appliedTags ?? [];
    const updated = buildAppliedTagsWithStatus(current, task.status, tagMap);
    await (thread as any).edit({ appliedTags: updated });
  } catch { /* ignore — proceed to setName */ }

  try {
    const name = buildThreadName(task.id, task.title, task.status);
    await thread.setName(name);
  } catch { /* ignore — proceed to archive */ }

  try {
    await thread.setArchived(true);
  } catch { /* ignore */ }

  return true;
}

export function initTasksForumGuard(opts: TasksForumGuardOptions): void {
  const { client, forumId, log, store, tagMap } = opts;

  client.on('threadCreate', async (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;
      if (isBotOwned(thread)) return;
      if (store && tagMap) {
        if (await reArchiveTaskThread(thread, store, tagMap, log)) return;
      }
      await rejectManualThread(thread, log);
    } catch (err) {
      log?.error({ err, threadId: thread.id }, 'tasks:forum threadCreate guard failed');
    }
  });

  client.on('threadUpdate', async (_oldThread: AnyThreadChannel, newThread: AnyThreadChannel) => {
    try {
      if (newThread.parentId !== forumId) return;
      // Only act on unarchive transitions.
      if (newThread.archived) return;
      if (isBotOwned(newThread)) return;
      if (store && tagMap) {
        if (await reArchiveTaskThread(newThread, store, tagMap, log)) return;
      }
      await rejectManualThread(newThread, log);
    } catch (err) {
      log?.error({ err, threadId: newThread.id }, 'tasks:forum threadUpdate guard failed');
    }
  });
}

// Bead* compatibility aliases
export type BeadsForumGuardOptions = TasksForumGuardOptions;
export const initBeadsForumGuard = initTasksForumGuard;
