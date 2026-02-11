import type { Client, ForumChannel, ThreadChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { CronRunStats, CadenceTag } from './run-stats.js';
import type { CronScheduler } from './scheduler.js';
import { detectCadence } from './cadence.js';
import { autoTagCron, classifyCronModel } from './auto-tag.js';
import { buildCronThreadName, ensureStatusMessage } from './discord-sync.js';
import { loadTagMap } from '../beads/discord-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TagMap = Record<string, string>;

export type CronSyncOptions = {
  client: Client;
  forumId: string;
  scheduler: CronScheduler;
  statsStore: CronRunStats;
  runtime: RuntimeAdapter;
  tagMapPath: string;
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

async function resolveForumChannel(client: Client, forumId: string): Promise<ForumChannel | null> {
  const ch = client.channels.cache.get(forumId);
  if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  try {
    const fetched = await client.channels.fetch(forumId);
    if (fetched && fetched.type === ChannelType.GuildForum) return fetched as ForumChannel;
  } catch {}
  return null;
}

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

function purposeTagNames(tagMap: TagMap): string[] {
  const cadenceSet = new Set(['frequent', 'hourly', 'daily', 'weekly', 'monthly']);
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

  const tagMap = await loadTagMap(opts.tagMapPath);
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

    if (!needsCadence && !needsTags && !needsModel) continue;

    try {
      const updates: Partial<typeof record> = {};

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

      // Apply tags to Discord thread.
      const thread = threads.get(fullJob.threadId);
      if (thread) {
        const allTags: string[] = [
          ...(updates.purposeTags ?? record.purposeTags),
        ];
        const cadence = updates.cadence ?? record.cadence;
        if (cadence) allTags.push(cadence);

        const tagIds = allTags
          .map((t) => tagMap[t])
          .filter((id): id is string => Boolean(id));
        const uniqueTagIds = [...new Set(tagIds)].slice(0, 5);

        if (uniqueTagIds.length > 0) {
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
      await ensureStatusMessage(client, fullJob.threadId, fullJob.cronId, record, statsStore, log);
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
