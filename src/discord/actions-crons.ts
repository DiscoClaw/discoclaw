import type { Client } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { CronRunStats } from '../cron/run-stats.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { CronExecutorContext } from '../cron/executor.js';
import { CADENCE_TAGS, generateCronId } from '../cron/run-stats.js';
import { safeCronId } from '../cron/job-lock.js';
import { detectCadence } from '../cron/cadence.js';
import { autoTagCron, classifyCronModel } from '../cron/auto-tag.js';
import { buildCronThreadName, ensureStatusMessage, resolveForumChannel } from '../cron/discord-sync.js';
import { loadTagMap } from '../beads/discord-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronActionRequest =
  | { type: 'cronCreate'; name: string; schedule: string; timezone?: string; channel: string; prompt: string; tags?: string; model?: 'haiku' | 'opus' }
  | { type: 'cronUpdate'; cronId: string; schedule?: string; timezone?: string; channel?: string; prompt?: string; model?: 'haiku' | 'opus'; tags?: string }
  | { type: 'cronList'; status?: string }
  | { type: 'cronShow'; cronId: string }
  | { type: 'cronPause'; cronId: string }
  | { type: 'cronResume'; cronId: string }
  | { type: 'cronDelete'; cronId: string }
  | { type: 'cronTrigger'; cronId: string; force?: boolean }
  | { type: 'cronSync' };

const CRON_TYPE_MAP: Record<CronActionRequest['type'], true> = {
  cronCreate: true,
  cronUpdate: true,
  cronList: true,
  cronShow: true,
  cronPause: true,
  cronResume: true,
  cronDelete: true,
  cronTrigger: true,
  cronSync: true,
};
export const CRON_ACTION_TYPES = new Set<string>(Object.keys(CRON_TYPE_MAP));

export type CronContext = {
  scheduler: CronScheduler;
  client: Client;
  forumId: string;
  tagMapPath: string;
  statsStore: CronRunStats;
  runtime: RuntimeAdapter;
  autoTag: boolean;
  autoTagModel: string;
  cwd: string;
  allowUserIds: Set<string>;
  log?: LoggerLike;
  // Used by cronTrigger to build a full executor context.
  // If not provided, manual triggers run with reduced capabilities (no tools, no actions).
  executorCtx?: CronExecutorContext;
  // Thread IDs currently being created by cronCreate. The threadCreate listener
  // checks this to avoid double-handling before scheduler.register() completes.
  pendingThreadIds: Set<string>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStarterContent(schedule: string, timezone: string, channel: string, prompt: string): string {
  return `**Schedule:** \`${schedule}\` (${timezone})\n**Channel:** #${channel}\n\n${prompt}`;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeCronAction(
  action: CronActionRequest,
  ctx: ActionContext,
  cronCtx: CronContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'cronCreate': {
      if (!action.name || !action.schedule || !action.channel || !action.prompt) {
        return { ok: false, error: 'cronCreate requires name, schedule, channel, and prompt' };
      }

      const cronId = generateCronId();
      const timezone = action.timezone ?? 'UTC';
      const cadence = detectCadence(action.schedule);

      // Create forum thread.
      const forum = await resolveForumChannel(cronCtx.client, cronCtx.forumId);
      if (!forum) {
        return { ok: false, error: 'Cron forum channel not found' };
      }

      const tagMap = await loadTagMap(cronCtx.tagMapPath);

      // Auto-tag if enabled.
      const cadenceSet = new Set<string>(CADENCE_TAGS);
      const purposeTagNames = Object.keys(tagMap).filter((k) => !cadenceSet.has(k));
      let purposeTags: string[] = [];
      let model: 'haiku' | 'opus' | null = null;

      if (action.tags) {
        purposeTags = action.tags.split(',').map((t) => t.trim()).filter(Boolean);
      }

      if (cronCtx.autoTag && purposeTagNames.length > 0 && purposeTags.length === 0) {
        try {
          purposeTags = await autoTagCron(cronCtx.runtime, action.name, action.prompt, purposeTagNames, { model: cronCtx.autoTagModel, cwd: cronCtx.cwd });
        } catch (err) {
          cronCtx.log?.warn({ err, cronId }, 'cron:action:create auto-tag failed');
        }
      }

      // Classify model.
      if (action.model) {
        model = action.model;
      } else {
        try {
          model = await classifyCronModel(cronCtx.runtime, action.name, action.prompt, cadence, { model: cronCtx.autoTagModel, cwd: cronCtx.cwd });
        } catch {
          model = 'haiku';
        }
      }

      // Resolve tag IDs for forum.
      const allTagNames = [...purposeTags, cadence];
      const appliedTagIds = allTagNames.map((t) => tagMap[t]).filter(Boolean);
      const uniqueTagIds = [...new Set(appliedTagIds)].slice(0, 5);

      const threadName = buildCronThreadName(action.name, cadence);
      const starterContent = buildStarterContent(action.schedule, timezone, action.channel, action.prompt);

      // Validate the schedule before creating the thread to avoid orphaned threads.
      const def = { schedule: action.schedule, timezone, channel: action.channel, prompt: action.prompt };

      let thread;
      try {
        thread = await forum.threads.create({
          name: threadName,
          message: {
            content: starterContent.slice(0, 2000),
            allowedMentions: { parse: [] },
          },
          appliedTags: uniqueTagIds,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Failed to create forum thread: ${msg}` };
      }

      // Mark thread as pending so the threadCreate listener skips it.
      cronCtx.pendingThreadIds.add(thread.id);

      // Register with scheduler, then clear the pending marker.
      try {
        cronCtx.scheduler.register(thread.id, thread.id, ctx.guild.id, action.name, def, cronId);
      } catch (err) {
        return { ok: false, error: `Invalid cron schedule: ${action.schedule}` };
      } finally {
        cronCtx.pendingThreadIds.delete(thread.id);
      }

      // Save stats. On create, set the classified model but don't set modelOverride —
      // override is only for explicit user changes via cronUpdate.
      const record = await cronCtx.statsStore.upsertRecord(cronId, thread.id, {
        cadence,
        purposeTags,
        model,
      });

      // Create status message.
      try {
        await ensureStatusMessage(cronCtx.client, thread.id, cronId, record, cronCtx.statsStore, { log: cronCtx.log });
      } catch {}

      return { ok: true, summary: `Cron "${action.name}" created (${cronId}), schedule: ${action.schedule}, model: ${model}` };
    }

    case 'cronUpdate': {
      if (!action.cronId) {
        return { ok: false, error: 'cronUpdate requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      const job = cronCtx.scheduler.getJob(record.threadId);
      if (!job) {
        return { ok: false, error: `Cron "${action.cronId}" not registered in scheduler` };
      }

      const updates: Partial<typeof record> = {};
      const changes: string[] = [];

      // Model override.
      if (action.model) {
        updates.modelOverride = action.model;
        changes.push(`model → ${action.model}`);
      }

      // Tags override.
      if (action.tags) {
        updates.purposeTags = action.tags.split(',').map((t) => t.trim()).filter(Boolean);
        changes.push(`tags → ${updates.purposeTags.join(', ')}`);
      }

      // Definition changes (schedule, timezone, channel, prompt).
      const newSchedule = action.schedule ?? job.def.schedule;
      const newTimezone = action.timezone ?? job.def.timezone;
      const newChannel = action.channel ?? job.def.channel;
      const newPrompt = action.prompt ?? job.def.prompt;

      const defChanged = action.schedule !== undefined || action.timezone !== undefined || action.channel !== undefined || action.prompt !== undefined;

      if (defChanged) {
        // Update cadence if schedule changed.
        if (action.schedule) {
          updates.cadence = detectCadence(action.schedule);
          changes.push(`schedule → ${action.schedule}`);
        }
        if (action.timezone !== undefined) changes.push(`timezone → ${action.timezone}`);
        if (action.channel !== undefined) changes.push(`channel → ${action.channel}`);
        if (action.prompt !== undefined) changes.push(`prompt updated`);

        // Try to edit the thread's starter message (works for bot-created threads).
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          try {
            const starter = await thread.fetchStarterMessage();
            if (starter && starter.author.id === cronCtx.client.user?.id) {
              const newContent = buildStarterContent(newSchedule, newTimezone, newChannel, newPrompt);
              await starter.edit({ content: newContent.slice(0, 2000), allowedMentions: { parse: [] } });
            } else {
              // Can't edit user's message — post update note.
              const note = `**Cron Updated**\n**Schedule:** \`${newSchedule}\` (${newTimezone})\n**Channel:** #${newChannel}\n\nPlease update the starter message to reflect these changes.`;
              await thread.send({ content: note, allowedMentions: { parse: [] } });
            }
          } catch (err) {
            cronCtx.log?.warn({ err, cronId: action.cronId }, 'cron:action:update edit failed');
          }
        }

        // Reload scheduler.
        const newDef = { schedule: newSchedule, timezone: newTimezone, channel: newChannel, prompt: newPrompt };
        try {
          cronCtx.scheduler.register(record.threadId, record.threadId, job.guildId, job.name, newDef, action.cronId);
        } catch (err) {
          return { ok: false, error: `Invalid cron schedule: ${newSchedule}` };
        }
      }

      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, updates);

      // Update status message.
      try {
        const updatedRecord = cronCtx.statsStore.getRecord(action.cronId);
        if (updatedRecord) {
          await ensureStatusMessage(cronCtx.client, record.threadId, action.cronId, updatedRecord, cronCtx.statsStore, { log: cronCtx.log });
        }
      } catch {}

      // Update thread tags if needed.
      if (action.tags !== undefined || action.schedule !== undefined) {
        try {
          const tagMap = await loadTagMap(cronCtx.tagMapPath);
          const updatedRecord = cronCtx.statsStore.getRecord(action.cronId);
          if (updatedRecord) {
            const allTags = [...updatedRecord.purposeTags];
            if (updatedRecord.cadence) allTags.push(updatedRecord.cadence);
            const tagIds = allTags.map((t) => tagMap[t]).filter(Boolean);
            const uniqueTagIds = [...new Set(tagIds)].slice(0, 5);
            if (uniqueTagIds.length > 0) {
              const thread = cronCtx.client.channels.cache.get(record.threadId);
              if (thread && thread.isThread()) {
                await (thread as any).edit({ appliedTags: uniqueTagIds });
              }
            }
          }
        } catch {}
      }

      return { ok: true, summary: `Cron ${action.cronId} updated: ${changes.join(', ') || 'no changes'}` };
    }

    case 'cronList': {
      const jobs = cronCtx.scheduler.listJobs();
      if (jobs.length === 0) {
        return { ok: true, summary: 'No cron jobs registered.' };
      }

      const lines = jobs.map((j) => {
        const fullJob = cronCtx.scheduler.getJob(j.id);
        const record = fullJob?.cronId ? cronCtx.statsStore.getRecord(fullJob.cronId) : undefined;
        const status = record?.disabled ? 'paused' : (record?.lastRunStatus ?? 'pending');
        const displayStatus = fullJob?.running ? `${status} \uD83D\uDD04` : status;
        const model = record?.modelOverride ?? record?.model ?? '?';
        const runs = record?.runCount ?? 0;
        const tags = record?.purposeTags?.join(', ') || '';
        const nextRun = j.nextRun ? `<t:${Math.floor(j.nextRun.getTime() / 1000)}:R>` : 'N/A';
        const cronId = fullJob?.cronId ?? '?';
        return `\`${cronId}\` **${j.name}** | \`${j.schedule}\` | ${displayStatus} | ${model} | ${runs} runs | next: ${nextRun}${tags ? ` | ${tags}` : ''}`;
      });
      return { ok: true, summary: lines.join('\n') };
    }

    case 'cronShow': {
      if (!action.cronId) {
        return { ok: false, error: 'cronShow requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      const job = cronCtx.scheduler.getJob(record.threadId);
      const lines: string[] = [];
      lines.push(`**Cron: ${job?.name ?? 'Unknown'}** (\`${action.cronId}\`)`);
      lines.push(`Thread: ${record.threadId}`);
      if (job) {
        lines.push(`Schedule: \`${job.def.schedule}\` (${job.def.timezone})`);
        const nextRun = job.cron?.nextRun() ?? null;
        lines.push(`Next run: ${nextRun ? `<t:${Math.floor(nextRun.getTime() / 1000)}:F>` : 'N/A'}`);
      }
      lines.push(`Status: ${record.disabled ? 'paused' : 'active'}`);
      if (job?.running) {
        lines.push(`Runtime: \uD83D\uDD04 running`);
      }
      lines.push(`Model: ${record.modelOverride ?? record.model ?? 'N/A'}${record.modelOverride ? ' (override)' : ''}`);
      lines.push(`Cadence: ${record.cadence ?? 'N/A'}`);
      lines.push(`Runs: ${record.runCount} | Last: ${record.lastRunStatus ?? 'never'}`);
      if (record.lastRunAt) lines.push(`Last run: <t:${Math.floor(new Date(record.lastRunAt).getTime() / 1000)}:R>`);
      if (record.purposeTags.length > 0) lines.push(`Tags: ${record.purposeTags.join(', ')}`);
      if (record.lastErrorMessage) lines.push(`Last error: ${record.lastErrorMessage}`);

      return { ok: true, summary: lines.join('\n') };
    }

    case 'cronPause': {
      if (!action.cronId) {
        return { ok: false, error: 'cronPause requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      cronCtx.scheduler.disable(record.threadId);
      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { disabled: true });

      // Post notification.
      try {
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          await (thread as any).send({ content: '\u23F8\uFE0F **Cron paused**', allowedMentions: { parse: [] } });
        }
      } catch {}

      return { ok: true, summary: `Cron ${action.cronId} paused` };
    }

    case 'cronResume': {
      if (!action.cronId) {
        return { ok: false, error: 'cronResume requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      cronCtx.scheduler.enable(record.threadId);
      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { disabled: false });

      // Post notification.
      try {
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          await (thread as any).send({ content: '\u25B6\uFE0F **Cron resumed**', allowedMentions: { parse: [] } });
        }
      } catch {}

      return { ok: true, summary: `Cron ${action.cronId} resumed` };
    }

    case 'cronDelete': {
      if (!action.cronId) {
        return { ok: false, error: 'cronDelete requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      cronCtx.scheduler.unregister(record.threadId);
      await cronCtx.statsStore.removeRecord(action.cronId);

      // Archive the thread.
      const thread = cronCtx.client.channels.cache.get(record.threadId);
      if (thread && thread.isThread()) {
        try {
          await (thread as any).send({ content: '\uD83D\uDDD1\uFE0F **Cron deleted**', allowedMentions: { parse: [] } });
        } catch {}
        try {
          await (thread as any).setArchived(true);
        } catch (err) {
          cronCtx.log?.warn({ err, cronId: action.cronId, threadId: record.threadId }, 'cron:action:delete archive failed');
          return { ok: true, summary: `Cron ${action.cronId} deleted but thread could not be archived — archive it manually` };
        }
      }

      return { ok: true, summary: `Cron ${action.cronId} deleted and thread archived` };
    }

    case 'cronTrigger': {
      if (!action.cronId) {
        return { ok: false, error: 'cronTrigger requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      const job = cronCtx.scheduler.getJob(record.threadId);
      if (!job) {
        return { ok: false, error: `Cron "${action.cronId}" not found in scheduler` };
      }

      // Force: delete any existing file lock and clear in-memory guard before executing.
      if (action.force) {
        const lockDir = cronCtx.executorCtx?.lockDir;
        if (!lockDir) {
          return { ok: false, error: 'force requires configured lockDir' };
        }
        const lockPath = path.join(lockDir, safeCronId(action.cronId) + '.lock');
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
          cronCtx.log?.info({ cronId: action.cronId }, 'cron:trigger force-deleted lock');
        } catch (err) {
          cronCtx.log?.warn({ err, cronId: action.cronId }, 'cron:trigger force lock delete failed');
        }
        job.running = false;
      }

      // Fire the executor (deferred import to avoid circular).
      try {
        const { executeCronJob } = await import('../cron/executor.js');
        // Use the real executor context if available (wired in from index.ts),
        // falling back to a minimal context with reduced capabilities.
        const execCtx: CronExecutorContext = cronCtx.executorCtx ?? {
          client: cronCtx.client,
          runtime: cronCtx.runtime,
          model: record.modelOverride ?? record.model ?? 'haiku',
          cwd: cronCtx.cwd,
          tools: [],
          timeoutMs: 600_000,
          status: null,
          log: cronCtx.log,
          discordActionsEnabled: false,
          actionFlags: { channels: false, messaging: false, guild: false, moderation: false, polls: false, beads: false, crons: false, botProfile: false },
          statsStore: cronCtx.statsStore,
        };
        void executeCronJob(job, execCtx);
        return { ok: true, summary: `Cron ${action.cronId} triggered (running in background)` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Trigger failed: ${msg}` };
      }
    }

    case 'cronSync': {
      try {
        const { runCronSync } = await import('../cron/cron-sync.js');
        const result = await runCronSync({
          client: cronCtx.client,
          forumId: cronCtx.forumId,
          scheduler: cronCtx.scheduler,
          statsStore: cronCtx.statsStore,
          runtime: cronCtx.runtime,
          tagMapPath: cronCtx.tagMapPath,
          autoTag: cronCtx.autoTag,
          autoTagModel: cronCtx.autoTagModel,
          cwd: cronCtx.cwd,
          log: cronCtx.log,
        });
        return {
          ok: true,
          summary: `Cron sync complete: ${result.tagsApplied} tags, ${result.namesUpdated} names, ${result.statusMessagesUpdated} status msgs, ${result.orphansDetected} orphans`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Cron sync failed: ${msg}` };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function cronActionsPromptSection(): string {
  return `### Cron Scheduled Tasks

**cronCreate** — Create a new scheduled task:
\`\`\`
<discord-action>{"type":"cronCreate","name":"Morning Report","schedule":"0 7 * * 1-5","timezone":"America/Los_Angeles","channel":"general","prompt":"Generate a brief morning status update","model":"haiku"}</discord-action>
\`\`\`
- \`name\` (required): Human-readable name.
- \`schedule\` (required): 5-field cron expression (e.g., "0 7 * * 1-5").
- \`channel\` (required): Target channel name or ID.
- \`prompt\` (required): The instruction text.
- \`timezone\` (optional, default: UTC): IANA timezone.
- \`tags\` (optional): Comma-separated purpose tags.
- \`model\` (optional): "haiku" or "opus" (auto-classified if omitted).

**cronUpdate** — Update a cron's settings:
\`\`\`
<discord-action>{"type":"cronUpdate","cronId":"cron-a1b2c3d4","schedule":"0 9 * * *","model":"opus"}</discord-action>
\`\`\`
- \`cronId\` (required): The stable cron ID.
- \`schedule\`, \`timezone\`, \`channel\`, \`prompt\`, \`model\`, \`tags\` (optional).

**cronList** — List all cron jobs:
\`\`\`
<discord-action>{"type":"cronList"}</discord-action>
\`\`\`

**cronShow** — Show full details for a cron:
\`\`\`
<discord-action>{"type":"cronShow","cronId":"cron-a1b2c3d4"}</discord-action>
\`\`\`

**cronPause** / **cronResume** — Pause or resume a cron:
\`\`\`
<discord-action>{"type":"cronPause","cronId":"cron-a1b2c3d4"}</discord-action>
<discord-action>{"type":"cronResume","cronId":"cron-a1b2c3d4"}</discord-action>
\`\`\`

**cronDelete** — Remove a cron job and archive its thread:
\`\`\`
<discord-action>{"type":"cronDelete","cronId":"cron-a1b2c3d4"}</discord-action>
\`\`\`
Note: cronDelete **archives** the thread (reversible) — it does not permanently
delete it. The thread history is preserved and the thread can be unarchived later
via the Discord UI, which will re-register the cron job automatically. Permanent
thread deletion can only be done manually through Discord.

**cronTrigger** — Immediately execute a cron (manual fire):
\`\`\`
<discord-action>{"type":"cronTrigger","cronId":"cron-a1b2c3d4"}</discord-action>
\`\`\`
Force override (breaks lock even if another run is active — risk of overlap):
\`\`\`
<discord-action>{"type":"cronTrigger","cronId":"cron-a1b2c3d4","force":true}</discord-action>
\`\`\`

**cronSync** — Run full bidirectional sync:
\`\`\`
<discord-action>{"type":"cronSync"}</discord-action>
\`\`\``;
}
