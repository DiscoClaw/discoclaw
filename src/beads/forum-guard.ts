import type { Client, AnyThreadChannel } from 'discord.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { TagMap } from './types.js';
import { findBeadByThreadId } from './bead-thread-cache.js';
import { buildAppliedTagsWithStatus, buildThreadName } from './discord-sync.js';

export type BeadsForumGuardOptions = {
  client: Client;
  forumId: string;
  log?: LoggerLike;
  beadsCwd?: string;
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
  log?.info({ threadId: thread.id, name: thread.name, ownerId: thread.ownerId }, 'beads:forum rejected manual thread');
  try {
    await thread.send(
      'Beads (tasks) must be created using bot commands or the `bd` CLI, not by manually creating forum threads.\n\n'
      + 'Ask the bot to create a bead for you, or run `bd create` from the terminal.\n\n'
      + 'This thread will be archived.',
    );
  } catch { /* ignore */ }
  try {
    await thread.setArchived(true);
  } catch { /* ignore */ }
}

async function reArchiveBeadThread(
  thread: AnyThreadChannel,
  beadsCwd: string,
  tagMap: TagMap,
  log?: LoggerLike,
): Promise<boolean> {
  let bead;
  try {
    bead = await findBeadByThreadId(thread.id, beadsCwd);
  } catch {
    return false;
  }
  if (!bead) return false;

  log?.info({ threadId: thread.id, beadId: bead.id }, 'beads:forum re-archiving known bead thread');

  try {
    const current: string[] = (thread as any).appliedTags ?? [];
    const updated = buildAppliedTagsWithStatus(current, bead.status, tagMap);
    await (thread as any).edit({ appliedTags: updated });
  } catch { /* ignore — proceed to setName */ }

  try {
    const name = buildThreadName(bead.id, bead.title, bead.status);
    await thread.setName(name);
  } catch { /* ignore — proceed to archive */ }

  try {
    await thread.setArchived(true);
  } catch { /* ignore */ }

  return true;
}

export function initBeadsForumGuard(opts: BeadsForumGuardOptions): void {
  const { client, forumId, log, beadsCwd, tagMap } = opts;

  client.on('threadCreate', async (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;
      if (isBotOwned(thread)) return;
      if (beadsCwd && tagMap) {
        if (await reArchiveBeadThread(thread, beadsCwd, tagMap, log)) return;
      }
      await rejectManualThread(thread, log);
    } catch (err) {
      log?.error({ err, threadId: thread.id }, 'beads:forum threadCreate guard failed');
    }
  });

  client.on('threadUpdate', async (_oldThread: AnyThreadChannel, newThread: AnyThreadChannel) => {
    try {
      if (newThread.parentId !== forumId) return;
      // Only act on unarchive transitions.
      if (newThread.archived) return;
      if (isBotOwned(newThread)) return;
      if (beadsCwd && tagMap) {
        if (await reArchiveBeadThread(newThread, beadsCwd, tagMap, log)) return;
      }
      await rejectManualThread(newThread, log);
    } catch (err) {
      log?.error({ err, threadId: newThread.id }, 'beads:forum threadUpdate guard failed');
    }
  });
}
