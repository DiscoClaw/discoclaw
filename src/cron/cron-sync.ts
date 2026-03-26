import { EmbedBuilder } from 'discord.js';
import type { Client, ThreadChannel } from 'discord.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import { CADENCE_TAGS, computeDefinitionHash } from './run-stats.js';
import type { CronRunRecord, CronRunStats } from './run-stats.js';
import type { ParsedCronDef } from './types.js';
import type { CronScheduler } from './scheduler.js';
import { detectCadence } from './cadence.js';
import { autoTagCron, classifyCronModel } from './auto-tag.js';
import { buildCronThreadName, ensureStatusMessage, resolveForumChannel, tryUnpinMessage } from './discord-sync.js';
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
  promptMessagesCreated: number;
  orphansDetected: number;
  projectionsRepaired: number;
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

function normalizeProjectionInputMode(
  inputMode?: CronRunRecord['inputMode'],
  inputShell?: CronRunRecord['inputShell'],
): 'prompt' | 'shell' {
  return inputMode === 'shell' || Boolean(inputShell?.trim()) ? 'shell' : 'prompt';
}

function describeProjectionInputMode(
  inputMode?: CronRunRecord['inputMode'],
  inputShell?: CronRunRecord['inputShell'],
): string {
  return normalizeProjectionInputMode(inputMode, inputShell) === 'shell' ? 'shell-input' : 'prompt-only';
}

function truncateProjectionText(text: string, limit: number, continuation: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${continuation}`;
}

function buildPromptMessageDescription(record: CronRunRecord): string {
  const inputShell = record.inputShell?.trim() ? record.inputShell.trim() : undefined;
  const lines = [`**Input:** ${describeProjectionInputMode(record.inputMode, inputShell)}`];

  if (normalizeProjectionInputMode(record.inputMode, inputShell) === 'shell' && inputShell) {
    lines.push(
      '```bash',
      truncateProjectionText(inputShell, 1000, '\n# ... shell truncated'),
      '```',
    );
  }

  const header = lines.join('\n');
  const prompt = record.prompt ?? '';
  const remaining = Math.max(0, 4096 - header.length - 2);
  const promptBody = prompt.length <= remaining
    ? prompt
    : truncateProjectionText(prompt, Math.max(0, remaining - 22), '\n... (prompt truncated)');

  return [header, promptBody].filter(Boolean).join('\n\n').slice(0, 4096);
}

function buildMissingProjectionStarterContent(cronId: string, record: CronRunRecord): string {
  const inputShell = record.inputShell?.trim() ? record.inputShell.trim() : undefined;
  const lines = [
    `**Schedule:** \`${record.schedule ?? 'N/A'}\` (${record.timezone ?? 'UTC'})`,
    `**Channel:** #${record.channel ?? 'unknown'}`,
    `**Input:** ${describeProjectionInputMode(record.inputMode, inputShell)}`,
  ];

  if (normalizeProjectionInputMode(record.inputMode, inputShell) === 'shell' && inputShell) {
    lines.push(
      '```bash',
      truncateProjectionText(inputShell, 300, '\n# ... shell truncated'),
      '```',
    );
  }

  lines.push('', record.prompt ?? '', '', `[cronId:${cronId}]`);
  return lines.join('\n');
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
    return { tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, promptMessagesCreated: 0, orphansDetected: 0, projectionsRepaired: 0 };
  }

  const tagMap = opts.tagMap;
  const purposeTags = purposeTagNames(tagMap);

  let tagsApplied = 0;
  let namesUpdated = 0;
  let statusMessagesUpdated = 0;
  let promptMessagesCreated = 0;
  let orphansDetected = 0;
  let projectionsRepaired = 0;

  type EditableCronThread = {
    id: string;
    parentId: string | null;
    name: string;
    appliedTags?: string[];
    edit: (payload: { appliedTags?: string[] }) => Promise<unknown>;
    setName: (name: string) => Promise<unknown>;
  };

  const asEditableCronThread = (value: unknown): EditableCronThread | null => {
    if (!value || typeof value !== 'object') return null;
    const t = value as {
      id?: unknown;
      parentId?: unknown;
      name?: unknown;
      appliedTags?: unknown;
      edit?: unknown;
      setName?: unknown;
    };
    if (
      typeof t.id !== 'string' ||
      typeof t.parentId !== 'string' ||
      typeof t.name !== 'string' ||
      typeof t.edit !== 'function' ||
      typeof t.setName !== 'function'
    ) {
      return null;
    }
    const appliedTags =
      Array.isArray(t.appliedTags) ? t.appliedTags.filter((id): id is string => typeof id === 'string') : undefined;
    const sourceThread = value as EditableCronThread;
    return {
      id: t.id,
      parentId: t.parentId,
      name: t.name,
      appliedTags,
      // Discord.js thread mutators read `this.client.rest`, so keep the live thread instance as `this`.
      edit: (t.edit as EditableCronThread['edit']).bind(sourceThread),
      setName: (t.setName as EditableCronThread['setName']).bind(sourceThread),
    };
  };

  // Get all active threads in the forum.
  let threads: ReadonlyMap<string, unknown> = new Map();
  try {
    const fetched = await forum.threads.fetchActive();
    threads = fetched.threads;
  } catch (err) {
    log?.warn({ err, forumId }, 'cron-sync: failed to fetch active threads; continuing with metadata/status phases only');
  }

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
          const cadence = fullJob.def.schedule ? detectCadence(fullJob.def.schedule) : null;
          updates.cadence = cadence;
        }

        if (needsTags) {
          const classified = await autoTagCron(runtime, fullJob.name, fullJob.def.prompt, purposeTags, { model: autoTagModel, cwd });
          if (classified.length > 0) updates.purposeTags = classified;
        }

        if (needsModel) {
          const cadence = updates.cadence ?? record.cadence ?? (fullJob.def.schedule ? detectCadence(fullJob.def.schedule) : null);
          if (cadence !== null) {
            const model = await classifyCronModel(runtime, fullJob.name, fullJob.def.prompt, cadence, { model: autoTagModel, cwd });
            updates.model = model;
          }
        }

        await statsStore.upsertRecord(record.cronId, record.threadId, updates);
      }

      // Apply tags to Discord thread.
      const thread = threads.get(fullJob.threadId);
      const editableThread = asEditableCronThread(thread);
      if (editableThread) {
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

        const currentTagIds: string[] = editableThread.appliedTags ?? [];
        const desiredSet = new Set(uniqueTagIds);
        const tagsOutOfSync =
          currentTagIds.length !== uniqueTagIds.length
          || currentTagIds.some((id) => !desiredSet.has(id));

        if (tagsOutOfSync) {
          try {
            await editableThread.edit({ appliedTags: uniqueTagIds });
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
    const editableThread = asEditableCronThread(thread);
    if (editableThread && editableThread.name !== expectedName) {
      try {
        await editableThread.setName(expectedName);
        namesUpdated++;
        log?.info({ threadId: fullJob.threadId, oldName: editableThread.name, newName: expectedName }, 'cron-sync:phase2 name updated');
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

      // Update projection hash after successful status message sync.
      const currentHash = computeDefinitionHash(record);
      if (record.projectionHash !== currentHash || record.projectionStatus !== 'synced') {
        await statsStore.upsertRecord(fullJob.cronId, fullJob.threadId, {
          projectionStatus: 'synced',
          projectionSyncedAt: new Date().toISOString(),
          projectionHash: currentHash,
        });
      }
    } catch (err) {
      log?.warn({ err, jobId: job.id }, 'cron-sync:phase3 status message failed');
    }
    await sleep(throttleMs);
  }

  // Phase 3.5: Prompt message backfill.
  for (const job of jobs) {
    const fullJob = scheduler.getJob(job.id);
    if (!fullJob?.cronId) continue;

    const record = statsStore.getRecord(fullJob.cronId);
    if (!record?.prompt || record.promptMessageId) continue;

    try {
      let thread: ThreadChannel | null = null;
      const cached = client.channels.cache.get(fullJob.threadId);
      if (cached && cached.isThread()) {
        thread = cached as ThreadChannel;
      } else {
        try {
          const fetched = await client.channels.fetch(fullJob.threadId);
          if (fetched && fetched.isThread()) thread = fetched as ThreadChannel;
        } catch {
          // Thread may have been deleted.
        }
      }
      if (!thread) continue;

      const embed = new EmbedBuilder()
        .setTitle('\uD83D\uDCCB Cron Prompt')
        .setDescription(buildPromptMessageDescription(record))
        .setColor(0x5865F2);

      const msg = await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });

      try {
        await msg.pin();
      } catch {
        // Non-fatal if pin fails.
      }

      await statsStore.upsertRecord(record.cronId, record.threadId, { promptMessageId: msg.id });
      promptMessagesCreated++;
    } catch (err) {
      log?.warn({ err, cronId: fullJob.cronId }, 'cron-sync:phase3.5 prompt message failed');
    }
    await sleep(throttleMs);
  }

  // Phase 4: Orphan detection (non-destructive, log only).
  for (const thread of threads.values()) {
    const editableThread = asEditableCronThread(thread);
    if (!editableThread) continue;
    if (editableThread.parentId !== forumId) continue;
    if (!jobThreadIds.has(editableThread.id)) {
      orphansDetected++;
      log?.warn({ threadId: editableThread.id, name: editableThread.name }, 'cron-sync:phase4 orphan thread (no registered job)');
    }
  }

  // Phase 5: Projection reconciliation — repair missing/drifted/stale Discord projections
  // from canonical local state. This ensures local records are the source of truth.
  const allRecords = statsStore.getCanonicalDefinitions();
  for (const [cronId, record] of Object.entries(allRecords)) {
    const currentHash = computeDefinitionHash(record);
    const status = record.projectionStatus;

    const needsReconciliation =
      status === 'missing' ||
      status === 'drifted' ||
      status === 'pending-resync' ||
      (record.projectionHash !== undefined && record.projectionHash !== currentHash);

    if (!needsReconciliation) continue;

    if (status === 'missing') {
      // Thread was deleted — recreate from canonical definition.
      if (!record.channel || !record.prompt) continue;

      try {
        const baseName = record.prompt.slice(0, 50).replace(/\n/g, ' ').trim() || cronId;
        const cadence = record.cadence ?? null;
        const threadName = buildCronThreadName(baseName, cadence);
        const starterContent = buildMissingProjectionStarterContent(cronId, record);

        const newThread = await forum.threads.create({
          name: threadName,
          message: { content: starterContent },
        });

        // Update the record with the new thread ID and mark synced.
        await statsStore.upsertRecord(cronId, newThread.id, {
          projectionStatus: 'synced',
          projectionSyncedAt: new Date().toISOString(),
          projectionHash: currentHash,
          statusMessageId: undefined,
          promptMessageId: undefined,
        });

        // Re-register in scheduler from canonical definition.
        // Clean up any stale scheduler entry first (e.g., from canonical orphan
        // recovery at boot or threadDelete resilience — the cron may still be
        // registered under the old/deleted thread ID).
        const def: ParsedCronDef = {
          triggerType: record.triggerType ?? 'schedule',
          schedule: record.schedule,
          timezone: record.timezone ?? 'UTC',
          channel: record.channel,
          prompt: record.prompt,
        };
        try {
          const staleJob = scheduler.getJobByCronId(cronId);
          if (staleJob && staleJob.id !== newThread.id) {
            scheduler.unregister(staleJob.id);
          }
          scheduler.register(newThread.id, newThread.id, forum.guildId, threadName, def, cronId);
          if (record.disabled) scheduler.disable(newThread.id);
        } catch {
          // Registration failed — will retry next sync cycle.
        }

        projectionsRepaired++;
        log?.info({ cronId, newThreadId: newThread.id }, 'cron-sync:phase5 recreated missing projection');
      } catch (err) {
        log?.warn({ err, cronId }, 'cron-sync:phase5 failed to recreate missing projection');
      }
      await sleep(throttleMs);
    } else {
      // Drifted, pending-resync, or hash mismatch — update status message and mark synced.
      // The status message content was already refreshed in Phase 3 for scheduler-registered
      // jobs; for any remaining records, ensure the projection metadata is up to date.
      try {
        const liveRecord = statsStore.getRecord(cronId);
        if (liveRecord) {
          try {
            await ensureStatusMessage(client, liveRecord.threadId, cronId, liveRecord, statsStore, { log });
          } catch {
            // Thread may not exist; status message update is best-effort.
          }

          // Refresh prompt message for drifted projections — unpin stale before pinning replacement.
          if (liveRecord.prompt && liveRecord.promptMessageId) {
            try {
              let thread: ThreadChannel | null = null;
              const cached = client.channels.cache.get(liveRecord.threadId);
              if (cached && cached.isThread()) {
                thread = cached as ThreadChannel;
              } else {
                try {
                  const fetched = await client.channels.fetch(liveRecord.threadId);
                  if (fetched && fetched.isThread()) thread = fetched as ThreadChannel;
                } catch { /* thread may not exist */ }
              }

              if (thread) {
                const embed = new EmbedBuilder()
                  .setTitle('\uD83D\uDCCB Cron Prompt')
                  .setDescription(buildPromptMessageDescription(liveRecord))
                  .setColor(0x5865F2);

                let edited = false;
                try {
                  const existing = await thread.messages.fetch(liveRecord.promptMessageId);
                  if (existing) {
                    await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
                    edited = true;
                  }
                } catch {
                  // Edit failed — unpin old message before creating replacement.
                  await tryUnpinMessage(thread, liveRecord.promptMessageId, log);
                }

                if (!edited) {
                  const msg = await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
                  try { await msg.pin(); } catch { /* non-fatal */ }
                  await statsStore.upsertRecord(cronId, liveRecord.threadId, { promptMessageId: msg.id });
                }
              }
            } catch (err) {
              log?.warn({ err, cronId }, 'cron-sync:phase5 prompt message refresh failed');
            }
          }

          await statsStore.upsertRecord(cronId, liveRecord.threadId, {
            projectionStatus: 'synced',
            projectionSyncedAt: new Date().toISOString(),
            projectionHash: currentHash,
          });
        }
        projectionsRepaired++;
      } catch (err) {
        log?.warn({ err, cronId }, 'cron-sync:phase5 failed to reconcile drifted projection');
      }
      await sleep(throttleMs);
    }
  }

  log?.info({ tagsApplied, namesUpdated, statusMessagesUpdated, promptMessagesCreated, orphansDetected, projectionsRepaired }, 'cron-sync: complete');
  return { tagsApplied, namesUpdated, statusMessagesUpdated, promptMessagesCreated, orphansDetected, projectionsRepaired };
}
