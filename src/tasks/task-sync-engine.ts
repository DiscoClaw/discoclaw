import type { Client, Guild } from 'discord.js';
import type { TagMap, TaskData, TaskSyncResult, BeadSyncResult } from './types.js';
import { hasInFlightForChannel } from '../discord/inflight-replies.js';
export type { TaskSyncResult, BeadSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { TaskStore } from './store.js';
import { withTaskLifecycleLock } from './task-lifecycle.js';
import {
  resolveBeadsForum,
  createBeadThread,
  closeBeadThread,
  isThreadArchived,
  isBeadThreadAlreadyClosed,
  updateBeadThreadName,
  updateBeadStarterMessage,
  updateBeadThreadTags,
  getThreadIdFromBead,
  ensureUnarchived,
  findExistingThreadForBead,
  extractShortIdFromThreadName,
  shortBeadId,
} from './discord-sync.js';

export type TaskSyncOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  store: TaskStore;
  log?: LoggerLike;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  statusPoster?: StatusPoster;
  mentionUserId?: string;
  /** Disable Phase 5 (thread reconciliation). Useful for shared-forum deployments. */
  skipPhase5?: boolean;
};
export type BeadSyncOptions = TaskSyncOptions;

function hasLabel(task: TaskData, label: string): boolean {
  return (task.labels ?? []).includes(label);
}

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

/**
 * 5-phase safety-net sync between beads DB and Discord forum threads.
 *
 * Phase 1: Create threads for beads missing external_ref.
 * Phase 2: Fix label mismatches (e.g., blocked label on open beads).
 * Phase 3: Sync emoji/names/starter content for existing threads.
 * Phase 4: Archive threads for closed beads.
 * Phase 5: Reconcile forum threads against beads — archive stale threads
 *          for closed beads and detect orphan threads with no matching bead.
 */
export async function runTaskSync(opts: TaskSyncOptions): Promise<TaskSyncResult> {
  const { client, guild, forumId, tagMap, log } = opts;
  const throttleMs = opts.throttleMs ?? 250;

  const forum = await resolveBeadsForum(guild, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'bead-sync: forum not found');
    const result: TaskSyncResult = { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 1 };
    if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
    return result;
  }

  let threadsCreated = 0;
  let emojisUpdated = 0;
  let starterMessagesUpdated = 0;
  let threadsArchived = 0;
  let statusesUpdated = 0;
  let tagsUpdated = 0;
  let warnings = 0;
  let closesDeferred = 0;

  // Load all beads (including closed for Phase 4).
  const allBeads = opts.store.list({ status: 'all' });

  // Phase 1: Create threads for beads missing external_ref.
  const missingRef = allBeads.filter((b) =>
    !getThreadIdFromBead(b) &&
    b.status !== 'closed' &&
    !hasLabel(b, 'no-thread'),
  );
  for (const bead of missingRef) {
    await withTaskLifecycleLock(bead.id, async () => {
      const latestBead = opts.store.get(bead.id) ?? bead;
      if (
        getThreadIdFromBead(latestBead) ||
        latestBead.status === 'closed' ||
        hasLabel(latestBead, 'no-thread')
      ) {
        return;
      }

      try {
        // Dedupe: if the thread already exists, backfill external_ref instead of creating a duplicate.
        const existing = await findExistingThreadForBead(forum, latestBead.id, { archivedLimit: opts.archivedDedupeLimit });
        if (existing) {
          try {
            opts.store.update(latestBead.id, { externalRef: `discord:${existing}` });
            log?.info({ beadId: latestBead.id, threadId: existing }, 'bead-sync:phase1 external-ref backfilled');
          } catch (err) {
            log?.warn({ err, beadId: latestBead.id, threadId: existing }, 'bead-sync:phase1 external-ref backfill failed');
            warnings++;
          }
          return;
        }

        const threadId = await createBeadThread(forum, latestBead, tagMap, opts.mentionUserId);
        // Link back via external_ref.
        try {
          opts.store.update(latestBead.id, { externalRef: `discord:${threadId}` });
        } catch (err) {
          log?.warn({ err, beadId: latestBead.id }, 'bead-sync:phase1 external-ref update failed');
          warnings++;
        }
        threadsCreated++;
        log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase1 thread created');
      } catch (err) {
        log?.warn({ err, beadId: latestBead.id }, 'bead-sync:phase1 failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 2: Fix status/label mismatches (matches legacy shell behavior).
  const needsBlocked = allBeads.filter((b) =>
    b.status === 'open' && (b.labels ?? []).some((l) => /^(waiting|blocked)-/.test(l)),
  );
  for (const bead of needsBlocked) {
    try {
      opts.store.update(bead.id, { status: 'blocked' as any });
      bead.status = 'blocked'; // keep in-memory copy current for Phase 3
      statusesUpdated++;
      log?.info({ beadId: bead.id }, 'bead-sync:phase2 status updated to blocked');
    } catch (err) {
      log?.warn({ err, beadId: bead.id }, 'bead-sync:phase2 failed');
      warnings++;
    }
    await sleep(throttleMs);
  }

  // Phase 3: Sync emoji/names for existing threads.
  const withRef = allBeads.filter((b) => getThreadIdFromBead(b) && b.status !== 'closed');
  for (const bead of withRef) {
    await withTaskLifecycleLock(bead.id, async () => {
      const latestBead = opts.store.get(bead.id) ?? bead;
      const threadId = getThreadIdFromBead(latestBead);
      if (!threadId || latestBead.status === 'closed') {
        return;
      }

      // Skip threads that are already archived — a concurrent taskClose may have
      // just archived this thread, and unarchiving it would undo that work.
      // Note: isThreadArchived never throws (fetchThreadChannel catches internally).
      if (await isThreadArchived(client, threadId)) {
        return;
      }

      // If archived, unarchive and keep unarchived for active tasks.
      try {
        await ensureUnarchived(client, threadId);
      } catch {}
      try {
        const changed = await updateBeadThreadName(client, threadId, latestBead);
        if (changed) {
          emojisUpdated++;
          log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase3 name updated');
        }
      } catch (err) {
        log?.warn({ err, beadId: latestBead.id, threadId }, 'bead-sync:phase3 failed');
        warnings++;
      }
      try {
        const starterChanged = await updateBeadStarterMessage(client, threadId, latestBead, opts.mentionUserId);
        if (starterChanged) {
          starterMessagesUpdated++;
          log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase3 starter updated');
        }
      } catch (err) {
        log?.warn({ err, beadId: latestBead.id, threadId }, 'bead-sync:phase3 starter update failed');
        warnings++;
      }
      try {
        const tagChanged = await updateBeadThreadTags(client, threadId, latestBead, tagMap);
        if (tagChanged) {
          tagsUpdated++;
          log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase3 tags updated');
        }
      } catch (err) {
        log?.warn({ err, beadId: latestBead.id, threadId }, 'bead-sync:phase3 tag update failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 4: Archive threads for closed beads.
  const closedBeads = allBeads.filter((b) =>
    b.status === 'closed' && getThreadIdFromBead(b),
  );
  for (const bead of closedBeads) {
    await withTaskLifecycleLock(bead.id, async () => {
      const latestBead = opts.store.get(bead.id) ?? bead;
      const threadId = getThreadIdFromBead(latestBead);
      if (!threadId || latestBead.status !== 'closed') {
        return;
      }

      try {
        // Full idempotency check: skip only if the thread is archived AND has
        // the correct closed name and tags. This lets sync recover threads that
        // were archived with stale names (e.g., rename failed silently during close).
        if (await isBeadThreadAlreadyClosed(client, threadId, latestBead, tagMap)) {
          return;
        }
        if (hasInFlightForChannel(threadId)) {
          closesDeferred++;
          log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase4 close deferred (in-flight reply active)');
          return;
        }
        await closeBeadThread(client, threadId, latestBead, tagMap, log);
        threadsArchived++;
        log?.info({ beadId: latestBead.id, threadId }, 'bead-sync:phase4 archived');
      } catch (err) {
        log?.warn({ err, beadId: latestBead.id, threadId }, 'bead-sync:phase4 failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 5: Reconcile forum threads against beads.
  let threadsReconciled = 0;
  let orphanThreadsFound = 0;

  if (!opts.skipPhase5) {
    // Build a map of short bead IDs → beads for quick lookup.
    const beadsByShortId = new Map<string, TaskData[]>();
    for (const bead of allBeads) {
      const sid = shortBeadId(bead.id);
      const arr = beadsByShortId.get(sid);
      if (arr) arr.push(bead);
      else beadsByShortId.set(sid, [bead]);
    }

    // Fetch active + archived forum threads.
    try {
      const activeThreads = await forum.threads.fetchActive();
      let archivedThreads: Map<string, any> = new Map();
      try {
        const fetched = await forum.threads.fetchArchived();
        archivedThreads = new Map(fetched.threads);
      } catch (err) {
        log?.warn({ err }, 'bead-sync:phase5 failed to fetch archived threads');
        warnings++;
      }

      // Combine both sets — active threads take priority for duplicates.
      const allThreads = new Map([...archivedThreads, ...activeThreads.threads]);
      for (const thread of allThreads.values()) {
        const sid = extractShortIdFromThreadName(thread.name);
        if (!sid) continue; // not a bead thread

        const beads = beadsByShortId.get(sid);
        if (!beads || beads.length === 0) {
          // Orphan thread — no local bead matches this short ID.
          orphanThreadsFound++;
          log?.info({ threadId: thread.id, threadName: thread.name, shortId: sid }, 'bead-sync:phase5 orphan thread detected');
          await sleep(throttleMs);
          continue;
        }

        // Skip ambiguous cases (multiple beads share the same short ID).
        if (beads.length > 1) {
          log?.info({ threadId: thread.id, shortId: sid, count: beads.length }, 'bead-sync:phase5 short-id collision, skipping');
          await sleep(throttleMs);
          continue;
        }

        const bead = beads[0]!;

        // Layer 2 safety: if the bead already has an external_ref pointing to
        // a different thread, this thread likely belongs to a foreign instance's
        // bead with the same short ID — skip it.
        const existingThreadId = getThreadIdFromBead(bead);
        if (existingThreadId && existingThreadId !== thread.id) {
          log?.info({ beadId: bead.id, threadId: thread.id, existingThreadId }, 'bead-sync:phase5 external_ref points to different thread, skipping');
          await sleep(throttleMs);
          continue;
        }

        // If bead is closed but thread is not archived, archive it.
        if (bead.status === 'closed' && !thread.archived) {
          if (hasInFlightForChannel(thread.id)) {
            closesDeferred++;
            log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 close deferred (in-flight reply active)');
            await sleep(throttleMs);
            continue;
          }
          // Backfill external_ref if missing so Phase 4 can track this thread.
          if (!existingThreadId) {
            try {
              opts.store.update(bead.id, { externalRef: `discord:${thread.id}` });
              log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 external_ref backfilled');
            } catch (err) {
              log?.warn({ err, beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 external_ref backfill failed');
              warnings++;
            }
          }
          try {
            await closeBeadThread(client, thread.id, bead, tagMap, log);
            threadsReconciled++;
            log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 reconciled (archived)');
          } catch (err) {
            log?.warn({ err, beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 archive failed');
            warnings++;
          }
          await sleep(throttleMs);
        } else if (bead.status === 'closed' && thread.archived) {
          // Thread is already archived — check if it's fully reconciled (correct name + tags).
          // If stale (e.g., name or tags wrong), unarchive→edit→re-archive via closeBeadThread.
          try {
            const alreadyClosed = await isBeadThreadAlreadyClosed(client, thread.id, bead, tagMap);
            if (!alreadyClosed) {
              if (hasInFlightForChannel(thread.id)) {
                closesDeferred++;
                log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 close deferred (in-flight reply active)');
              } else {
                log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 archived thread is stale, unarchiving to reconcile');
                await closeBeadThread(client, thread.id, bead, tagMap, log);
                threadsReconciled++;
                log?.info({ beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 reconciled (re-archived)');
              }
            }
          } catch (err) {
            log?.warn({ err, beadId: bead.id, threadId: thread.id }, 'bead-sync:phase5 archived reconcile failed');
            warnings++;
          }
          await sleep(throttleMs);
        }
      }
    } catch (err) {
      log?.warn({ err }, 'bead-sync:phase5 failed to fetch active threads');
      warnings++;
    }
  }

  log?.info({ threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, threadsReconciled, orphanThreadsFound, closesDeferred, warnings }, 'bead-sync: complete');
  const result: TaskSyncResult = { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, warnings, threadsReconciled, orphanThreadsFound, closesDeferred };
  if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
  return result;
}

export const runBeadSync = runTaskSync;
