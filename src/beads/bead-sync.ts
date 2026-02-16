import type { Client, Guild } from 'discord.js';
import type { TagMap, BeadData, BeadSyncResult } from './types.js';
export type { BeadSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import { bdList, bdUpdate } from './bd-cli.js';
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
} from './discord-sync.js';

export type BeadSyncOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  beadsCwd: string;
  log?: LoggerLike;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  statusPoster?: StatusPoster;
  mentionUserId?: string;
  /** Disable Phase 5 (thread reconciliation). Useful for shared-forum deployments. */
  skipPhase5?: boolean;
};

function hasLabel(bead: BeadData, label: string): boolean {
  return (bead.labels ?? []).includes(label);
}

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

/**
 * 4-phase safety-net sync between beads DB and Discord forum threads.
 *
 * Phase 1: Create threads for beads missing external_ref.
 * Phase 2: Fix label mismatches (e.g., blocked label on open beads).
 * Phase 3: Sync emoji/names/starter content for existing threads.
 * Phase 4: Archive threads for closed beads.
 */
export async function runBeadSync(opts: BeadSyncOptions): Promise<BeadSyncResult> {
  const { client, guild, forumId, tagMap, beadsCwd, log } = opts;
  const throttleMs = opts.throttleMs ?? 250;

  const forum = await resolveBeadsForum(guild, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'bead-sync: forum not found');
    const result: BeadSyncResult = { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 1 };
    await opts.statusPoster?.beadSyncComplete(result);
    return result;
  }

  let threadsCreated = 0;
  let emojisUpdated = 0;
  let starterMessagesUpdated = 0;
  let threadsArchived = 0;
  let statusesUpdated = 0;
  let tagsUpdated = 0;
  let warnings = 0;

  // Load all beads (including closed for Phase 4).
  const allBeads = await bdList({ status: 'all' }, beadsCwd);

  // Phase 1: Create threads for beads missing external_ref.
  const missingRef = allBeads.filter((b) =>
    !getThreadIdFromBead(b) &&
    b.status !== 'closed' &&
    !hasLabel(b, 'no-thread'),
  );
  for (const bead of missingRef) {
    try {
      // Dedupe: if the thread already exists, backfill external_ref instead of creating a duplicate.
      const existing = await findExistingThreadForBead(forum, bead.id, { archivedLimit: opts.archivedDedupeLimit });
      if (existing) {
        try {
          await bdUpdate(bead.id, { externalRef: `discord:${existing}` }, beadsCwd);
          log?.info({ beadId: bead.id, threadId: existing }, 'bead-sync:phase1 external-ref backfilled');
        } catch (err) {
          log?.warn({ err, beadId: bead.id, threadId: existing }, 'bead-sync:phase1 external-ref backfill failed');
          warnings++;
        }
        await sleep(throttleMs);
        continue;
      }

      const threadId = await createBeadThread(forum, bead, tagMap, opts.mentionUserId);
      // Link back via external_ref.
      try {
        await bdUpdate(bead.id, { externalRef: `discord:${threadId}` }, beadsCwd);
      } catch (err) {
        log?.warn({ err, beadId: bead.id }, 'bead-sync:phase1 external-ref update failed');
        warnings++;
      }
      threadsCreated++;
      log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase1 thread created');
    } catch (err) {
      log?.warn({ err, beadId: bead.id }, 'bead-sync:phase1 failed');
      warnings++;
    }
    await sleep(throttleMs);
  }

  // Phase 2: Fix status/label mismatches (matches legacy shell behavior).
  const needsBlocked = allBeads.filter((b) =>
    b.status === 'open' && (b.labels ?? []).some((l) => /^(waiting|blocked)-/.test(l)),
  );
  for (const bead of needsBlocked) {
    try {
      await bdUpdate(bead.id, { status: 'blocked' as any }, beadsCwd);
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
    const threadId = getThreadIdFromBead(bead)!;
    // Skip threads that are already archived — a concurrent beadClose may have
    // just archived this thread, and unarchiving it would undo that work.
    // Note: isThreadArchived never throws (fetchThreadChannel catches internally).
    if (await isThreadArchived(client, threadId)) {
      await sleep(throttleMs);
      continue;
    }
    // If archived, unarchive and keep unarchived for active beads.
    try {
      await ensureUnarchived(client, threadId);
    } catch {}
    try {
      const changed = await updateBeadThreadName(client, threadId, bead);
      if (changed) {
        emojisUpdated++;
        log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase3 name updated');
      }
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase3 failed');
      warnings++;
    }
    try {
      const starterChanged = await updateBeadStarterMessage(client, threadId, bead, opts.mentionUserId);
      if (starterChanged) {
        starterMessagesUpdated++;
        log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase3 starter updated');
      }
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase3 starter update failed');
      warnings++;
    }
    try {
      const tagChanged = await updateBeadThreadTags(client, threadId, bead, tagMap);
      if (tagChanged) {
        tagsUpdated++;
        log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase3 tags updated');
      }
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase3 tag update failed');
      warnings++;
    }
    await sleep(throttleMs);
  }

  // Phase 4: Archive threads for closed beads.
  const closedBeads = allBeads.filter((b) =>
    b.status === 'closed' && getThreadIdFromBead(b),
  );
  for (const bead of closedBeads) {
    const threadId = getThreadIdFromBead(bead)!;
    try {
      // Full idempotency check: skip only if the thread is archived AND has
      // the correct closed name and tags. This lets sync recover threads that
      // were archived with stale names (e.g., rename failed silently during close).
      if (await isBeadThreadAlreadyClosed(client, threadId, bead, tagMap)) {
        await sleep(throttleMs);
        continue;
      }
      await closeBeadThread(client, threadId, bead, tagMap, log);
      threadsArchived++;
      log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase4 archived');
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase4 failed');
      warnings++;
    }
    await sleep(throttleMs);
  }

  log?.info({ threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, warnings }, 'bead-sync: complete');
  const result: BeadSyncResult = { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, warnings };
  await opts.statusPoster?.beadSyncComplete(result);
  return result;
}
