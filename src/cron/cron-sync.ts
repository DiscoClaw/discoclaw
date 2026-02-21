import type { Client } from 'discord.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import { CADENCE_TAGS } from './run-stats.js';
import type { CronRunStats } from './run-stats.js';
import type { CronScheduler } from './scheduler.js';
import { detectCadence } from './cadence.js';
import { autoTagCron, classifyCronModel } from './auto-tag.js';
import { buildCronThreadName, ensureStatusMessage, resolveForumChannel } from './discord-sync.js';
import type { TagMap } from './discord-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronSyncOptions = {
  client: Client;
  forumId: string;
  scheduler: CronScheduler;
  statsStore: CronRunStats;
  runtime: RuntimeAdapter;
  tagMap: TagMap;
  autoTag: boolean;
  autoTagModel: string;
  cwd: string;
  log?: LoggerLike;
  throttleMs?: number;
};

export type CronSyncResult = {
  tagsApplied: number;
  namesUpdated: number;
  statusMessagesUpdated: number;
  orphansDetected: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

function purposeTagNames(tagMap: TagMap): string[] {
  const cadenceSet = new Set<string>(CADENCE_TAGS);
  return Object.keys(tagMap).filter((k) => !cadenceSet.has(k));
}

// ---------------------------------------------------------------------------
// 4-phase sync
// ---------------------------------------------------------------------------

export async function runCronSync(opts: CronSyncOptions): Promise<CronSyncResult> {
  const { client, forumId, scheduler, statsStore, runtime, autoTag, autoTagModel, cwd, log } = opts;
  const throttleMs = opts.throttleMs ?? 250;

  const forum = await resolveForumChannel(client, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'cron-sync: forum not found');
    return { tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, orphansDetected: 0 };
  }

  const tagMap = opts.tagMap;
  const purposeTags = purposeTagNames(tagMap);

  let tagsApplied = 0;
  let namesUpdated = 0;
  let statusMessagesUpdated = 0;
  let orphansDetected = 0;

  // Get all active threads in the forum.
  const { threads } = await forum.threads.fetchActive();

  // Get all registered jobs.
  const jobs = scheduler.listJobs();
  const jobThreadIds = new Set(jobs.map((j) => j.id));

  // Phase 1: Tag + model sync.
  for (const job of jobs) {
    const fullJob = scheduler.getJob(job.id);
    if (!fullJob) continue;

    const record = statsStore.getRecordByThreadId(fullJob.threadId);
    if (!record) continue;

    const needsCadence = !record.cadence;
    const needsTags = autoTag && record.purposeTags.length === 0 && purposeTags.length > 0;
    const needsModel = !record.model;
    const needsMetadataUpdate = needsCadence || needsTags || needsModel;

    try {
      const updates: Partial<typeof record> = {};

      if (needsMetadataUpdate) {
        if (needsCadence) {
          const cadence = detectCadence(fullJob.def.schedule);
          updates.cadence = cadence;
        }

        if (needsTags) {
          const classified = await autoTagCron(runtime, fullJob.name, fullJob.def.prompt, purposeTags, { model: autoTagModel, cwd });
          if (classified.length > 0) updates.purposeTags = classified;
        }

        if (needsModel) {
          const cadence = updates.cadence ?? record.cadence ?? detectCadence(fullJob.def.schedule);
          const model = await classifyCronModel(runtime, fullJob.name, fullJob.def.prompt, cadence, { model: autoTagModel, cwd });
          updates.model = model;
        }

        await statsStore.upsertRecord(record.cronId, record.threadId, updates);
      }

      // Apply tags to Discord thread.
      const thread = threads.get(fullJob.threadId);
      if (thread) {
        const desiredPurposeTags = updates.purposeTags ?? record.purposeTags;
        const desiredCadence = updates.cadence ?? record.cadence;
        const allTags: string[] = [
          ...desiredPurposeTags,
        ];
        if (desiredCadence) allTags.push(desiredCadence);

        const desiredTagIds = allTags
          .map((t) => tagMap[t])
          .filter((id): id is string => Boolean(id));
        const uniqueTagIds = [...new Set(desiredTagIds)].slice(0, 5);

        const currentTagIds: string[] = Array.isArray((thread as any).appliedTags)
          ? (thread as any).appliedTags.filter((id: unknown): id is string => typeof id === 'string')
          : [];
        const desiredSet = new Set(uniqueTagIds);
        const tagsOutOfSync =
          currentTagIds.length !== uniqueTagIds.length
          || currentTagIds.some((id) => !desiredSet.has(id));

        if (tagsOutOfSync) {
          try {
            await (thread as any).edit({ appliedTags: uniqueTagIds });
            tagsApplied++;
          } catch (err) {
            log?.warn({ err, threadId: fullJob.threadId }, 'cron-sync:phase1 tag apply failed');
          }
        }
      }
    } catch (err) {
      log?.warn({ err, jobId: job.id }, 'cron-sync:phase1 failed');
    }
    await sleep(throttleMs);
  }

  // Phase 2: Name sync.
  for (const job of jobs) {
    const fullJob = scheduler.getJob(job.id);
    if (!fullJob) continue;

    const record = statsStore.getRecordByThreadId(fullJob.threadId);
    const cadence = record?.cadence ?? null;
    const expectedName = buildCronThreadName(fullJob.name, cadence);

    const thread = threads.get(fullJob.threadId);
    if (thread && thread.name !== expectedName) {
      try {
        await (thread as any).setName(expectedName);
        namesUpdated++;
        log?.info({ threadId: fullJob.threadId, oldName: thread.name, newName: expectedName }, 'cron-sync:phase2 name updated');
      } catch (err) {
        log?.warn({ err, threadId: fullJob.threadId }, 'cron-sync:phase2 name update failed');
      }
      await sleep(throttleMs);
    }
  }

  // Phase 3: Status message sync.
  for (const job of jobs) {
    const fullJob = scheduler.getJob(job.id);
    if (!fullJob?.cronId) continue;

    const record = statsStore.getRecord(fullJob.cronId);
    if (!record) continue;

    try {
      await ensureStatusMessage(client, fullJob.threadId, fullJob.cronId, record, statsStore, { log });
      statusMessagesUpdated++;
    } catch (err) {
      log?.warn({ err, jobId: job.id }, 'cron-sync:phase3 status message failed');
    }
    await sleep(throttleMs);
  }

  // Phase 4: Orphan detection (non-destructive, log only).
  for (const thread of threads.values()) {
    if (thread.parentId !== forumId) continue;
    if (!jobThreadIds.has(thread.id)) {
      orphansDetected++;
      log?.warn({ threadId: thread.id, name: thread.name }, 'cron-sync:phase4 orphan thread (no registered job)');
    }
  }

  log?.info({ tagsApplied, namesUpdated, statusMessagesUpdated, orphansDetected }, 'cron-sync: complete');
  return { tagsApplied, namesUpdated, statusMessagesUpdated, orphansDetected };
}
