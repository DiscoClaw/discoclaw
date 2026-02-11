import type { Client, Guild } from 'discord.js';
import type { TagMap, BeadData } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import { bdList, bdUpdate } from './bd-cli.js';
import {
  resolveBeadsForum,
  createBeadThread,
  closeBeadThread,
  isBeadThreadAlreadyClosed,
  updateBeadThreadName,
  updateBeadStarterMessage,
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
};

export type BeadSyncResult = {
  threadsCreated: number;
  emojisUpdated: number;
  starterMessagesUpdated: number;
  threadsArchived: number;
  statusesUpdated: number;
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
    return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0 };
  }

  let threadsCreated = 0;
  let emojisUpdated = 0;
  let starterMessagesUpdated = 0;
  let threadsArchived = 0;
  let statusesUpdated = 0;

  // Load all beads (including closed for Phase 4).
  const allBeads = await bdList({ status: 'all' }, beadsCwd);

  // Phase 1: Create threads for beads missing external_ref.
  const missingRef = allBeads.filter((b) =>
    !getThreadIdFromBead(b) &&
    b.status !== 'closed' &&
    b.status !== 'done' &&
    b.status !== 'tombstone' &&
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
        }
        await sleep(throttleMs);
        continue;
      }

      const threadId = await createBeadThread(forum, bead, tagMap);
      // Link back via external_ref.
      try {
        await bdUpdate(bead.id, { externalRef: `discord:${threadId}` }, beadsCwd);
      } catch (err) {
        log?.warn({ err, beadId: bead.id }, 'bead-sync:phase1 external-ref update failed');
      }
      threadsCreated++;
      log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase1 thread created');
    } catch (err) {
      log?.warn({ err, beadId: bead.id }, 'bead-sync:phase1 failed');
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
      statusesUpdated++;
      log?.info({ beadId: bead.id }, 'bead-sync:phase2 status updated to blocked');
    } catch (err) {
      log?.warn({ err, beadId: bead.id }, 'bead-sync:phase2 failed');
    }
    await sleep(throttleMs);
  }

  // Phase 3: Sync emoji/names for existing threads.
  const withRef = allBeads.filter((b) => getThreadIdFromBead(b) && b.status !== 'closed' && b.status !== 'done' && b.status !== 'tombstone');
  for (const bead of withRef) {
    const threadId = getThreadIdFromBead(bead)!;
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
    }
    try {
      const starterChanged = await updateBeadStarterMessage(client, threadId, bead);
      if (starterChanged) {
        starterMessagesUpdated++;
        log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase3 starter updated');
      }
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase3 starter update failed');
    }
    await sleep(throttleMs);
  }

  // Phase 4: Archive threads for closed/done/tombstone beads.
  const closedBeads = allBeads.filter((b) =>
    (b.status === 'closed' || b.status === 'done' || b.status === 'tombstone') && getThreadIdFromBead(b),
  );
  for (const bead of closedBeads) {
    const threadId = getThreadIdFromBead(bead)!;
    try {
      let alreadyClosed = false;
      try {
        alreadyClosed = await isBeadThreadAlreadyClosed(client, threadId, bead);
      } catch {
        // Check failed (rate limit, network) — proceed with close attempt.
      }
      if (alreadyClosed) {
        await sleep(throttleMs);
        continue;
      }
      await closeBeadThread(client, threadId, bead);
      threadsArchived++;
      log?.info({ beadId: bead.id, threadId }, 'bead-sync:phase4 archived');
    } catch (err) {
      log?.warn({ err, beadId: bead.id, threadId }, 'bead-sync:phase4 failed');
    }
    await sleep(throttleMs);
  }

  log?.info({ threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated }, 'bead-sync: complete');
  return { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated };
}
