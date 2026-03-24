import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { Cron } from 'croner';
import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { CronRunStats } from '../cron/run-stats.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { CronExecutorContext } from '../cron/executor.js';
import type { DeferScheduler } from './defer-scheduler.js';
import type { DeferActionRequest } from './actions-defer.js';
import { CADENCE_TAGS, generateCronId, computeDefinitionHash } from '../cron/run-stats.js';
import { detectCadence } from '../cron/cadence.js';
import type { ForumCountSync } from './forum-count-sync.js';
import { autoTagCron, classifyCronModel } from '../cron/auto-tag.js';
import { buildCronThreadName, ensureStatusMessage, resolveForumChannel } from '../cron/discord-sync.js';
import type { TagMap } from '../cron/discord-sync.js';
import type { CronSyncCoordinator } from '../cron/cron-sync-coordinator.js';
import { reloadCronTagMapInPlace } from '../cron/tag-map.js';
import { getDefaultTimezone } from '../cron/default-timezone.js';
import { CHANNEL_ACTION_TYPES } from './actions-channels.js';
import { MESSAGING_ACTION_TYPES } from './actions-messaging.js';
import { GUILD_ACTION_TYPES } from './actions-guild.js';
import { MODERATION_ACTION_TYPES } from './actions-moderation.js';
import { POLL_ACTION_TYPES } from './actions-poll.js';
import { TASK_ACTION_TYPES } from '../tasks/task-actions.js';
import { BOT_PROFILE_ACTION_TYPES } from './actions-bot-profile.js';
import { FORGE_ACTION_TYPES } from './actions-forge.js';
import { PLAN_ACTION_TYPES } from './actions-plan.js';
import { MEMORY_ACTION_TYPES } from './actions-memory.js';
import { DEFER_ACTION_TYPES } from './actions-defer.js';
import { CONFIG_ACTION_TYPES } from './actions-config.js';
import { REACTION_PROMPT_ACTION_TYPES } from './reaction-prompts.js';
import { IMAGEGEN_ACTION_TYPES } from './actions-imagegen.js';
import { VOICE_ACTION_TYPES } from './actions-voice.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronActionRequest =
  | { type: 'cronCreate'; name: string; schedule: string; timezone?: string; channel: string; prompt: string; tags?: string; model?: string; inputMode?: 'prompt' | 'shell'; inputShell?: string; routingMode?: 'json'; allowedActions?: string; chain?: string }
  | { type: 'cronUpdate'; cronId: string; schedule?: string; timezone?: string; channel?: string; prompt?: string; model?: string; tags?: string; silent?: boolean; inputMode?: 'prompt' | 'shell'; inputShell?: string; routingMode?: 'json'; allowedActions?: string; state?: string; chain?: string }
  | { type: 'cronList'; status?: string }
  | { type: 'cronShow'; cronId: string }
  | { type: 'cronPause'; cronId: string }
  | { type: 'cronResume'; cronId: string }
  | { type: 'cronDelete'; cronId: string }
  | { type: 'cronTrigger'; cronId: string; force?: boolean }
  | { type: 'cronSync' }
  | { type: 'cronTagMapReload' }
  | { type: 'cronExport' };

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
  cronTagMapReload: true,
  cronExport: true,
};
export const CRON_ACTION_TYPES = new Set<string>(Object.keys(CRON_TYPE_MAP));

// Combined set of all known action types, used to validate allowedActions entries.
const ALL_KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  ...CHANNEL_ACTION_TYPES,
  ...MESSAGING_ACTION_TYPES,
  ...REACTION_PROMPT_ACTION_TYPES,
  ...GUILD_ACTION_TYPES,
  ...MODERATION_ACTION_TYPES,
  ...POLL_ACTION_TYPES,
  ...TASK_ACTION_TYPES,
  ...CRON_ACTION_TYPES,
  ...BOT_PROFILE_ACTION_TYPES,
  ...FORGE_ACTION_TYPES,
  ...PLAN_ACTION_TYPES,
  ...MEMORY_ACTION_TYPES,
  ...DEFER_ACTION_TYPES,
  ...CONFIG_ACTION_TYPES,
  ...IMAGEGEN_ACTION_TYPES,
  ...VOICE_ACTION_TYPES,
]);

export type CronContext = {
  scheduler: CronScheduler;
  client: Client;
  forumId: string;
  tagMapPath: string;
  tagMap: TagMap;
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
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
  forumCountSync?: ForumCountSync;
  syncCoordinator?: CronSyncCoordinator;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCronInputMode(inputMode?: 'prompt' | 'shell', inputShell?: string): 'prompt' | 'shell' {
  return inputMode === 'shell' || Boolean(inputShell?.trim()) ? 'shell' : 'prompt';
}

function describeCronInputMode(inputMode?: 'prompt' | 'shell', inputShell?: string): string {
  return normalizeCronInputMode(inputMode, inputShell) === 'shell' ? 'shell-input' : 'prompt-only';
}

function validateCronInputConfig(
  inputMode: 'prompt' | 'shell' | undefined,
  inputShellRaw: string | undefined,
): { inputShell?: string } | { error: string } {
  const inputShell = inputShellRaw?.trim() ? inputShellRaw.trim() : undefined;
  const inputShellSupplied = inputShellRaw !== undefined;

  if (inputMode !== undefined && inputMode !== 'prompt' && inputMode !== 'shell') {
    return { error: `Invalid inputMode "${inputMode}": must be "prompt" or "shell"` };
  }
  if (inputMode === 'shell' && !inputShell) {
    return { error: 'inputShell is required when inputMode is "shell"' };
  }
  if (inputShellSupplied && inputMode !== 'shell') {
    return { error: 'inputShell can only be provided when inputMode is "shell"' };
  }

  return { inputShell };
}

function truncateProjectionText(text: string, limit: number, continuation: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${continuation}`;
}

function buildStarterContent(
  schedule: string,
  timezone: string,
  channel: string,
  prompt: string,
  inputMode?: 'prompt' | 'shell',
  inputShell?: string,
): string {
  const truncatedPrompt = prompt.length > 200
    ? `${prompt.slice(0, 200)}… *(full prompt pinned below)*`
    : prompt;
  const lines = [
    `**Schedule:** \`${schedule}\` (${timezone})`,
    `**Channel:** #${channel}`,
    `**Input:** ${describeCronInputMode(inputMode, inputShell)}`,
  ];

  if (normalizeCronInputMode(inputMode, inputShell) === 'shell' && inputShell?.trim()) {
    lines.push(
      '```bash',
      truncateProjectionText(inputShell.trim(), 300, '\n# ... shell truncated'),
      '```',
    );
  }

  lines.push('', truncatedPrompt);
  return lines.join('\n');
}

function validateCronDefinition(def: { schedule: string; timezone: string }): string | null {
  const timezone = String(def.timezone ?? '').trim();
  if (!timezone) {
    return 'timezone is required';
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return `invalid timezone "${def.timezone}"`;
  }

  try {
    new Cron(def.schedule, { timezone }).stop();
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg || 'invalid schedule';
  }
}

function requestRunningJobCancel(cronCtx: CronContext, threadId: string, cronId: string): boolean {
  const canceled = cronCtx.executorCtx?.runControl?.requestCancel(threadId) ?? false;
  if (canceled) {
    cronCtx.log?.info({ cronId, threadId }, 'cron:action requested cancel for in-flight run');
  }
  return canceled;
}

/**
 * Parse and validate a comma-separated chain string. Returns parsed cronIds or an error message.
 */
function parseAndValidateChain(chainStr: string, statsStore: CronRunStats, selfCronId?: string): { ids: string[] } | { error: string } {
  if (chainStr === '') {
    return { ids: [] };
  }
  const ids = chainStr.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { error: 'chain requires at least one cronId if provided' };
  }
  // Validate each cronId exists.
  const missing = ids.filter((id) => !statsStore.getRecord(id));
  if (missing.length > 0) {
    return { error: `chain contains unknown cronIds: ${missing.join(', ')}` };
  }
  // No self-referencing.
  if (selfCronId && ids.includes(selfCronId)) {
    return { error: 'chain cannot reference itself' };
  }
  return { ids };
}

/**
 * Detect cycles in the chain graph. Returns true if adding the proposed chain
 * to `cronId` would create a cycle.
 */
function detectChainCycle(cronId: string, proposedChain: string[], statsStore: CronRunStats): boolean {
  // BFS from each downstream job, checking if we can reach cronId.
  const visited = new Set<string>();
  const queue = [...proposedChain];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === cronId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const rec = statsStore.getRecord(current);
    if (rec?.chain) {
      for (const next of rec.chain) {
        if (!visited.has(next)) queue.push(next);
      }
    }
  }
  return false;
}

type CronThreadOps = {
  edit?: (opts: { appliedTags: string[] }) => Promise<unknown>;
  send?: (opts: { content: string; allowedMentions: { parse: string[] } }) => Promise<unknown>;
  setArchived?: (archived: boolean) => Promise<unknown>;
};

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
      const timezone = action.timezone ?? getDefaultTimezone();
      const def = { triggerType: 'schedule' as const, schedule: action.schedule, timezone, channel: action.channel, prompt: action.prompt };
      const validationError = validateCronDefinition(def);
      if (validationError) {
        return { ok: false, error: `Invalid cron definition: ${validationError}` };
      }
      const cadence = detectCadence(def.schedule);

      const inputConfig = validateCronInputConfig(action.inputMode, action.inputShell);
      if ('error' in inputConfig) {
        return { ok: false, error: inputConfig.error };
      }
      const createInputUpdates = {
        ...(action.inputMode !== undefined ? { inputMode: action.inputMode } : {}),
        ...(action.inputMode === 'shell' ? { inputShell: inputConfig.inputShell } : {}),
      };

      // Validate allowedActions if provided.
      let parsedAllowedActions: string[] | undefined;
      if (action.allowedActions !== undefined) {
        const parts = action.allowedActions.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) {
          return { ok: false, error: 'allowedActions requires at least one entry if provided' };
        }
        const unknown = parts.filter((p) => !ALL_KNOWN_ACTION_TYPES.has(p));
        if (unknown.length > 0) {
          return { ok: false, error: `allowedActions contains unrecognized action types: ${unknown.join(', ')}` };
        }
        parsedAllowedActions = parts;
      }

      // Validate chain if provided.
      let parsedChain: string[] | undefined;
      if (action.chain !== undefined) {
        const chainResult = parseAndValidateChain(action.chain, cronCtx.statsStore);
        if ('error' in chainResult) {
          return { ok: false, error: chainResult.error };
        }
        if (chainResult.ids.length > 0) {
          // No cycle detection needed on create — this job doesn't exist yet so
          // no other job can reference it as a downstream target.
          parsedChain = chainResult.ids;
        }
      }

      // Reload shared cache from disk (best-effort; failure keeps cached)
      await reloadCronTagMapInPlace(cronCtx.tagMapPath, cronCtx.tagMap).catch((err) => {
        cronCtx.log?.warn({ err, tagMapPath: cronCtx.tagMapPath }, 'cron:action tag-map reload failed; using cached');
      });
      // Snapshot for deterministic use within this action
      const tagMap = { ...cronCtx.tagMap };

      // Auto-tag if enabled.
      const cadenceSet = new Set<string>(CADENCE_TAGS);
      const purposeTagNames = Object.keys(tagMap).filter((k) => !cadenceSet.has(k));
      let purposeTags: string[] = [];
      let model: string | null = null;

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
          model = 'fast';
        }
      }

      // Validate routing mode.
      if (action.routingMode !== undefined && action.routingMode !== 'json') {
        return { ok: false, error: `Invalid routingMode "${action.routingMode}": must be "json"` };
      }

      // --- Canonical local write FIRST (commit point) ---
      // Save stats with cronId as placeholder threadId; real threadId set after projection.
      // On create, set the classified model but don't set modelOverride —
      // override is only for explicit user changes via cronUpdate.
      const canonicalRecord = await cronCtx.statsStore.upsertRecord(cronId, cronId, {
        cadence,
        purposeTags,
        model,
        schedule: action.schedule,
        timezone,
        channel: action.channel,
        prompt: action.prompt,
        authorId: ctx.requesterId,
        projectionStatus: 'pending-resync' as const,
        ...createInputUpdates,
        ...(action.routingMode ? { routingMode: action.routingMode } : {}),
        ...(parsedAllowedActions !== undefined && { allowedActions: parsedAllowedActions }),
        ...(parsedChain !== undefined && { chain: parsedChain }),
      });
      const defHash = computeDefinitionHash(canonicalRecord);

      // --- Discord projection sync (best-effort) ---
      let projectionNote = '';
      try {
        const forum = await resolveForumChannel(cronCtx.client, cronCtx.forumId);
        if (!forum) {
          throw new Error('Cron forum channel not found');
        }

        // Resolve tag IDs for forum.
        const allTagNames = [...purposeTags, cadence];
        const appliedTagIds = allTagNames.map((t) => tagMap[t]).filter(Boolean);
        const uniqueTagIds = [...new Set(appliedTagIds)].slice(0, 5);

        const threadName = buildCronThreadName(action.name, cadence);
        const starterContent = buildStarterContent(
          action.schedule,
          timezone,
          action.channel,
          action.prompt,
          action.inputMode,
          inputConfig.inputShell,
        );

        const thread = await forum.threads.create({
          name: threadName,
          message: {
            content: starterContent.slice(0, 2000),
            allowedMentions: { parse: [] },
          },
          appliedTags: uniqueTagIds,
        });

        // Mark thread as pending so the threadCreate listener skips it.
        cronCtx.pendingThreadIds.add(thread.id);

        // Register with scheduler, then clear the pending marker.
        try {
          cronCtx.scheduler.register(thread.id, thread.id, ctx.guild.id, action.name, def, cronId);
        } finally {
          cronCtx.pendingThreadIds.delete(thread.id);
        }

        // Update record with real threadId and mark projection synced.
        const record = await cronCtx.statsStore.upsertRecord(cronId, thread.id, {
          projectionStatus: 'synced' as const,
          projectionSyncedAt: new Date().toISOString(),
          projectionHash: defHash,
        });

        // Create status message.
        try {
          await ensureStatusMessage(cronCtx.client, thread.id, cronId, record, cronCtx.statsStore, { log: cronCtx.log });
        } catch {}

        // Post pinned prompt message (embed) so the full prompt is always retrievable.
        try {
          const embed = new EmbedBuilder()
            .setTitle('\uD83D\uDCCB Cron Prompt')
            .setDescription(action.prompt.slice(0, 4096))
            .setColor(0x5865F2);
          const promptMsg = await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
          try { await promptMsg.pin(); } catch { /* non-fatal */ }
          await cronCtx.statsStore.upsertRecord(cronId, thread.id, { promptMessageId: promptMsg.id });
        } catch (err) {
          cronCtx.log?.warn({ err, cronId }, 'cron:action:create prompt message failed');
        }

        cronCtx.forumCountSync?.requestUpdate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        projectionNote = ` (projection: pending — ${msg})`;
        cronCtx.log?.warn({ err, cronId }, 'cron:action:create Discord projection failed; local record committed');
      }

      return { ok: true, summary: `Cron "${action.name}" created (${cronId}), schedule: ${action.schedule}, model: ${model}${action.routingMode ? `, routing: ${action.routingMode}` : ''}${parsedChain ? `, chain: ${parsedChain.join(', ')}` : ''}${projectionNote}` };
    }

    case 'cronUpdate': {
      if (!action.cronId) {
        return { ok: false, error: 'cronUpdate requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      const inputConfig = validateCronInputConfig(action.inputMode, action.inputShell);
      if ('error' in inputConfig) {
        return { ok: false, error: inputConfig.error };
      }
      const currentInputMode = normalizeCronInputMode(record.inputMode, record.inputShell);
      const currentInputShell = record.inputShell?.trim() ? record.inputShell.trim() : undefined;

      // Scheduler job may be absent if projection is missing; updates proceed against canonical local record.
      const job = cronCtx.scheduler.getJob(record.threadId);

      const updates: Partial<typeof record> = {};
      const changes: string[] = [];
      const warnings: string[] = [];

      // Silent mode.
      if (action.silent !== undefined) {
        updates.silent = action.silent;
        changes.push(`silent → ${action.silent}`);
      }

      if (action.inputMode !== undefined) {
        updates.inputMode = action.inputMode;
        updates.inputShell = action.inputMode === 'shell' ? inputConfig.inputShell : undefined;
        changes.push(`input → ${describeCronInputMode(action.inputMode, inputConfig.inputShell)}`);
      }

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

      // Routing mode.
      if (action.routingMode !== undefined) {
        if (action.routingMode && action.routingMode !== 'json') {
          return { ok: false, error: `Invalid routingMode "${action.routingMode}": must be "json"` };
        }
        updates.routingMode = action.routingMode || undefined;
        changes.push(`routingMode → ${action.routingMode || 'cleared'}`);
      }

      // Allowed actions override.
      if (action.allowedActions !== undefined) {
        if (action.allowedActions === '') {
          updates.allowedActions = undefined;
          changes.push('allowedActions cleared');
        } else {
          const parts = action.allowedActions.split(',').map((s) => s.trim()).filter(Boolean);
          if (parts.length === 0) {
            return { ok: false, error: 'allowedActions requires at least one entry if provided' };
          }
          const unknown = parts.filter((p) => !ALL_KNOWN_ACTION_TYPES.has(p));
          if (unknown.length > 0) {
            return { ok: false, error: `allowedActions contains unrecognized action types: ${unknown.join(', ')}` };
          }
          updates.allowedActions = parts;
          changes.push(`allowedActions → ${parts.join(', ')}`);
        }
      }

      // Chain override.
      if (action.chain !== undefined) {
        if (action.chain === '') {
          updates.chain = undefined;
          changes.push('chain cleared');
        } else {
          const chainResult = parseAndValidateChain(action.chain, cronCtx.statsStore, action.cronId);
          if ('error' in chainResult) {
            return { ok: false, error: chainResult.error };
          }
          if (detectChainCycle(action.cronId, chainResult.ids, cronCtx.statsStore)) {
            return { ok: false, error: 'chain would create a cycle' };
          }
          updates.chain = chainResult.ids;
          changes.push(`chain → ${chainResult.ids.join(', ')}`);
        }
      }

      // State override (manual JSON manipulation).
      if (action.state !== undefined) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(action.state) as Record<string, unknown>;
        } catch {
          return { ok: false, error: 'state must be valid JSON' };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { ok: false, error: 'state must be a JSON object' };
        }
        updates.state = parsed;
        changes.push(Object.keys(parsed).length === 0 ? 'state cleared' : 'state updated');
      }

      // Definition changes (schedule, timezone, channel, prompt).
      // Use canonical record as primary source, scheduler as fallback.
      const newSchedule = action.schedule ?? record.schedule ?? job?.def.schedule ?? '';
      const newTimezone = action.timezone ?? record.timezone ?? job?.def.timezone ?? getDefaultTimezone();
      const newChannel = action.channel ?? record.channel ?? job?.def.channel ?? '';
      const newPrompt = action.prompt ?? record.prompt ?? job?.def.prompt ?? '';
      const newInputMode = action.inputMode ?? currentInputMode;
      const newInputShell = action.inputMode === 'shell'
        ? inputConfig.inputShell
        : action.inputMode === 'prompt'
          ? undefined
          : currentInputShell;
      const newDef = { triggerType: record.triggerType ?? job?.def.triggerType ?? ('schedule' as const), schedule: newSchedule, timezone: newTimezone, channel: newChannel, prompt: newPrompt };

      const defChanged = action.schedule !== undefined || action.timezone !== undefined || action.channel !== undefined || action.prompt !== undefined;
      const projectionContentChanged = defChanged || action.inputMode !== undefined;

      if (defChanged) {
        const validationError = validateCronDefinition(newDef);
        if (validationError) {
          return { ok: false, error: `Invalid cron definition: ${validationError}` };
        }

        // Update cadence if schedule changed.
        if (action.schedule) {
          updates.cadence = detectCadence(action.schedule);
          changes.push(`schedule → ${action.schedule}`);
        }
        if (action.timezone !== undefined) changes.push(`timezone → ${action.timezone}`);
        if (action.channel !== undefined) changes.push(`channel → ${action.channel}`);
        if (action.prompt !== undefined) changes.push(`prompt updated`);

        // Persist updated definition fields.
        updates.schedule = newSchedule;
        updates.timezone = newTimezone;
        updates.channel = newChannel;
        updates.prompt = newPrompt;
      }

      if (action.prompt !== undefined && action.state === undefined && Object.keys(record.state ?? {}).length > 0) {
        warnings.push('prompt updated but existing persistent state was kept; clear stale state with state: "{}" if it no longer applies');
      }

      // --- Canonical local write FIRST (commit point) ---
      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, updates);

      // --- Scheduler re-registration (local, not Discord) ---
      if (defChanged) {
        if (job) {
          try {
            cronCtx.scheduler.register(record.threadId, record.threadId, job.guildId, job.name, newDef, action.cronId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`scheduler re-registration failed: ${msg}`);
          }
        } else {
          warnings.push('not in scheduler — definition updated locally only');
        }
      }

      // --- Discord projection sync (best-effort) ---
      let discordSyncOk = true;

      // Try to edit the thread's starter message (works for bot-created threads).
      if (projectionContentChanged) {
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          try {
            const starter = await thread.fetchStarterMessage();
            const starterContent = buildStarterContent(
              newSchedule,
              newTimezone,
              newChannel,
              newPrompt,
              newInputMode,
              newInputShell,
            );
            if (starter && starter.author.id === cronCtx.client.user?.id) {
              await starter.edit({ content: starterContent.slice(0, 2000), allowedMentions: { parse: [] } });
            } else {
              // Can't edit user's message — post update note.
              const note = `**Cron Updated**\n${starterContent}\n\nPlease update the starter message to reflect these changes.`;
              await thread.send({ content: note, allowedMentions: { parse: [] } });
            }
          } catch (err) {
            discordSyncOk = false;
            cronCtx.log?.warn({ err, cronId: action.cronId }, 'cron:action:update edit failed');
          }
        }
      }

      // Update status message.
      try {
        const updatedRecord = cronCtx.statsStore.getRecord(action.cronId);
        if (updatedRecord) {
          await ensureStatusMessage(cronCtx.client, record.threadId, action.cronId, updatedRecord, cronCtx.statsStore, { log: cronCtx.log });
        }
      } catch {
        discordSyncOk = false;
      }

      // Update or create the pinned prompt message when prompt changes.
      if (action.prompt !== undefined) {
        try {
          const updatedRecord = cronCtx.statsStore.getRecord(action.cronId);
          const embed = new EmbedBuilder()
            .setTitle('\uD83D\uDCCB Cron Prompt')
            .setDescription(newPrompt.slice(0, 4096))
            .setColor(0x5865F2);

          if (updatedRecord?.promptMessageId) {
            // Try to edit the existing prompt message.
            const thread = cronCtx.client.channels.cache.get(record.threadId);
            if (thread && thread.isThread()) {
              try {
                const existing = await (thread as unknown as { messages: { fetch: (id: string) => Promise<{ edit: (opts: unknown) => Promise<unknown> }> } }).messages.fetch(updatedRecord.promptMessageId);
                await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
              } catch {
                // Message may have been deleted; create a new one.
                const msg = await (thread as unknown as { send: (opts: unknown) => Promise<{ id: string; pin: () => Promise<unknown> }> }).send({ embeds: [embed], allowedMentions: { parse: [] } });
                try { await msg.pin(); } catch { /* non-fatal */ }
                await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { promptMessageId: msg.id });
              }
            }
          } else {
            // No existing prompt message — create one.
            const thread = cronCtx.client.channels.cache.get(record.threadId);
            if (thread && thread.isThread()) {
              const msg = await (thread as unknown as { send: (opts: unknown) => Promise<{ id: string; pin: () => Promise<unknown> }> }).send({ embeds: [embed], allowedMentions: { parse: [] } });
              try { await msg.pin(); } catch { /* non-fatal */ }
              await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { promptMessageId: msg.id });
            }
          }
        } catch (err) {
          discordSyncOk = false;
          cronCtx.log?.warn({ err, cronId: action.cronId }, 'cron:action:update prompt message failed');
        }
      }

      // Update thread tags if needed.
      if (action.tags !== undefined || action.schedule !== undefined) {
        try {
          // Reload shared cache from disk (best-effort; failure keeps cached)
          await reloadCronTagMapInPlace(cronCtx.tagMapPath, cronCtx.tagMap).catch((err) => {
            cronCtx.log?.warn({ err, tagMapPath: cronCtx.tagMapPath }, 'cron:action tag-map reload failed; using cached');
          });
          // Snapshot for deterministic use within this action
          const tagMap = { ...cronCtx.tagMap };
          const updatedRecord = cronCtx.statsStore.getRecord(action.cronId);
          if (updatedRecord) {
            const allTags = [...updatedRecord.purposeTags];
            if (updatedRecord.cadence) allTags.push(updatedRecord.cadence);
            const tagIds = allTags.map((t) => tagMap[t]).filter(Boolean);
            const uniqueTagIds = [...new Set(tagIds)].slice(0, 5);
            if (uniqueTagIds.length > 0) {
              const thread = cronCtx.client.channels.cache.get(record.threadId);
              if (thread && thread.isThread()) {
                const threadOps = thread as CronThreadOps;
                if (typeof threadOps.edit === 'function') {
                  await threadOps.edit({ appliedTags: uniqueTagIds });
                }
              }
            }
          }
        } catch {
          discordSyncOk = false;
        }
      }

      // Update projection status based on Discord sync outcome.
      try {
        const defRecord = cronCtx.statsStore.getRecord(action.cronId);
        if (defRecord) {
          await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, {
            projectionStatus: discordSyncOk ? ('synced' as const) : ('drifted' as const),
            ...(discordSyncOk ? { projectionSyncedAt: new Date().toISOString(), projectionHash: computeDefinitionHash(defRecord) } : {}),
          });
        }
      } catch { /* projection status update is best-effort */ }

      const projectionNote = discordSyncOk ? '' : ' (projection: drifted)';
      const summary = `Cron ${action.cronId} updated: ${changes.join(', ') || 'no changes'}${projectionNote}`;
      return { ok: true, summary: warnings.length > 0 ? `${summary}. Warning: ${warnings.join('; ')}` : summary };
    }

    case 'cronList': {
      // Read from canonical local store (source of truth), enrich with scheduler runtime data.
      const allRecords = cronCtx.statsStore.getCanonicalDefinitions();
      const entries = Object.entries(allRecords);
      if (entries.length === 0) {
        return { ok: true, summary: 'No cron jobs registered.' };
      }

      const lines = entries.map(([cronId, rec]) => {
        const job = cronCtx.scheduler.getJob(rec.threadId);
        const name = job?.name ?? cronId;
        const schedule = rec.schedule ?? job?.def.schedule ?? '?';
        const status = rec.disabled ? 'paused' : (rec.lastRunStatus ?? 'pending');
        const displayStatus = job?.running ? `${status} \uD83D\uDD04` : status;
        const model = rec.modelOverride ?? rec.model ?? '?';
        const runs = rec.runCount ?? 0;
        const tags = rec.purposeTags?.join(', ') || '';
        const nextRun = job?.cron?.nextRun() ? `<t:${Math.floor(job.cron.nextRun()!.getTime() / 1000)}:R>` : 'N/A';
        const chained = rec.chain && rec.chain.length > 0 ? ' | chained' : '';
        const projection = rec.projectionStatus && rec.projectionStatus !== 'synced' ? ` | proj:${rec.projectionStatus}` : '';
        return `\`${cronId}\` **${name}** | \`${schedule}\` | ${displayStatus} | ${model} | ${runs} runs | next: ${nextRun}${tags ? ` | ${tags}` : ''}${chained}${projection}`;
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
      // Schedule from canonical record, falling back to scheduler.
      const schedule = record.schedule ?? job?.def.schedule;
      const tz = record.timezone ?? job?.def.timezone;
      if (schedule) {
        lines.push(`Schedule: \`${schedule}\` (${tz ?? 'N/A'})`);
      }
      const nextRun = job?.cron?.nextRun() ?? null;
      lines.push(`Next run: ${nextRun ? `<t:${Math.floor(nextRun.getTime() / 1000)}:F>` : 'N/A'}`);
      lines.push(`Status: ${record.disabled ? 'paused' : 'active'}`);
      if (job?.running) {
        lines.push(`Runtime: \uD83D\uDD04 running`);
      }
      lines.push(`Model: ${record.modelOverride ?? record.model ?? 'N/A'}${record.modelOverride ? ' (override)' : ''}`);
      if (record.silent) lines.push(`Silent: yes`);
      lines.push(`Input: ${describeCronInputMode(record.inputMode, record.inputShell)}`);
      if (normalizeCronInputMode(record.inputMode, record.inputShell) === 'shell' && record.inputShell?.trim()) {
        lines.push(`Input shell: \`${record.inputShell.trim()}\``);
      }
      if (record.routingMode) lines.push(`Routing: ${record.routingMode}`);
      lines.push(`Cadence: ${record.cadence ?? 'N/A'}`);
      lines.push(`Runs: ${record.runCount} | Last: ${record.lastRunStatus ?? 'never'}`);
      if (record.lastRunAt) lines.push(`Last run: <t:${Math.floor(new Date(record.lastRunAt).getTime() / 1000)}:R>`);
      if (record.purposeTags.length > 0) lines.push(`Tags: ${record.purposeTags.join(', ')}`);
      if (record.allowedActions && record.allowedActions.length > 0) lines.push(`Allowed actions: ${record.allowedActions.join(', ')}`);
      if (record.chain && record.chain.length > 0) {
        const chainEntries = record.chain.map((id) => {
          const downstream = cronCtx.statsStore.getRecord(id);
          const downstreamJob = downstream ? cronCtx.scheduler.getJob(downstream.threadId) : undefined;
          return `\`${id}\`${downstreamJob ? ` (${downstreamJob.name})` : ''}`;
        });
        lines.push(`Chain: ${chainEntries.join(', ')}`);
      }
      if (record.lastErrorMessage) lines.push(`Last error: ${record.lastErrorMessage}`);
      if (record.state && Object.keys(record.state).length > 0) {
        const stateJson = JSON.stringify(record.state);
        lines.push(`State: ${stateJson.length > 500 ? stateJson.slice(0, 500) + '... (truncated)' : stateJson}`);
      }
      // Surface projection status so operators see sync state.
      if (record.projectionStatus && record.projectionStatus !== 'synced') {
        lines.push(`Projection: ${record.projectionStatus}`);
      }
      // Return full prompt text — prefer the persisted record prompt (always full),
      // falling back to the scheduler def (also full).
      const promptText = record.prompt ?? job?.def.prompt;
      if (promptText) {
        lines.push(`Prompt: ${promptText}`);
      }

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

      // --- Canonical local write FIRST (commit point) ---
      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { disabled: true });

      // --- Scheduler disable (best-effort — job may not be registered if projection is missing) ---
      const disabled = cronCtx.scheduler.disable(record.threadId);
      const canceled = disabled ? requestRunningJobCancel(cronCtx, record.threadId, action.cronId) : false;

      // --- Discord notification (best-effort) ---
      try {
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          const threadOps = thread as CronThreadOps;
          if (typeof threadOps.send === 'function') {
            await threadOps.send({ content: '\u23F8\uFE0F **Cron paused**', allowedMentions: { parse: [] } });
          }
        }
      } catch {}

      const notes: string[] = [];
      if (canceled) notes.push('active run cancel requested');
      if (!disabled) notes.push('not in scheduler — projection may need resync');
      return { ok: true, summary: `Cron ${action.cronId} paused${notes.length > 0 ? ` (${notes.join('; ')})` : ''}` };
    }

    case 'cronResume': {
      if (!action.cronId) {
        return { ok: false, error: 'cronResume requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      // --- Canonical local write FIRST (commit point) ---
      await cronCtx.statsStore.upsertRecord(action.cronId, record.threadId, { disabled: false });

      // --- Scheduler enable (best-effort — job may not be registered if projection is missing) ---
      const enabled = cronCtx.scheduler.enable(record.threadId);

      // --- Discord notification (best-effort) ---
      try {
        const thread = cronCtx.client.channels.cache.get(record.threadId);
        if (thread && thread.isThread()) {
          const threadOps = thread as CronThreadOps;
          if (typeof threadOps.send === 'function') {
            await threadOps.send({ content: '\u25B6\uFE0F **Cron resumed**', allowedMentions: { parse: [] } });
          }
        }
      } catch {}

      const note = !enabled ? ' (not in scheduler — projection may need resync)' : '';
      return { ok: true, summary: `Cron ${action.cronId} resumed${note}` };
    }

    case 'cronDelete': {
      if (!action.cronId) {
        return { ok: false, error: 'cronDelete requires cronId' };
      }

      const record = cronCtx.statsStore.getRecord(action.cronId);
      if (!record) {
        return { ok: false, error: `Cron "${action.cronId}" not found` };
      }

      // --- Canonical local remove FIRST (commit point) ---
      const canceled = requestRunningJobCancel(cronCtx, record.threadId, action.cronId);
      cronCtx.scheduler.unregister(record.threadId);
      await cronCtx.statsStore.removeRecord(action.cronId);
      cronCtx.forumCountSync?.requestUpdate();

      // --- Discord projection cleanup (best-effort) ---
      const thread = cronCtx.client.channels.cache.get(record.threadId);
      if (thread && thread.isThread()) {
        const threadOps = thread as CronThreadOps;
        try {
          if (typeof threadOps.send === 'function') {
            await threadOps.send({ content: '\uD83D\uDDD1\uFE0F **Cron deleted**', allowedMentions: { parse: [] } });
          }
        } catch {}
        try {
          if (typeof threadOps.setArchived === 'function') {
            await threadOps.setArchived(true);
          }
        } catch (err) {
          cronCtx.log?.warn({ err, cronId: action.cronId, threadId: record.threadId }, 'cron:action:delete archive failed');
          return {
            ok: true,
            summary: canceled
              ? `Cron ${action.cronId} deleted (active run cancel requested) but thread could not be archived — archive it manually`
              : `Cron ${action.cronId} deleted but thread could not be archived — archive it manually`,
          };
        }
      }

      return {
        ok: true,
        summary: canceled
          ? `Cron ${action.cronId} deleted and thread archived (active run cancel requested)`
          : `Cron ${action.cronId} deleted and thread archived`,
      };
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

      if (action.force) {
        return {
          ok: false,
          error: 'cronTrigger force is disabled in Discord actions; use an admin terminal flow for break-glass overrides',
        };
      }

      // Fire the executor (deferred import to avoid circular).
      try {
        const { executeCronJob } = await import('../cron/executor.js');
        // Use the real executor context if available (wired in from index.ts),
        // falling back to a minimal context with reduced capabilities.
        const execCtx: CronExecutorContext = cronCtx.executorCtx ?? {
          client: cronCtx.client,
          runtime: cronCtx.runtime,
          model: record.modelOverride ?? record.model ?? 'fast',
          cwd: cronCtx.cwd,
          tools: [],
          timeoutMs: 600_000,
          status: null,
          log: cronCtx.log,
          discordActionsEnabled: false,
          actionFlags: { channels: false, messaging: false, guild: false, moderation: false, polls: false, tasks: false, crons: false, botProfile: false, forge: false, plan: false, memory: false, config: false, defer: false },
          deferScheduler: cronCtx.deferScheduler,
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
        if (cronCtx.syncCoordinator) {
          const result = await cronCtx.syncCoordinator.sync();
          if (result === null) {
            return { ok: true, summary: 'Cron sync already running; request coalesced' };
          }
          return {
            ok: true,
            summary: `Cron sync complete: ${result.tagsApplied} tags, ${result.namesUpdated} names, ${result.statusMessagesUpdated} status msgs, ${result.promptMessagesCreated} prompt msgs, ${result.orphansDetected} orphans`,
          };
        } else {
          // Fallback (no coordinator): reload + snapshot + runCronSync + forumCountSync
          await reloadCronTagMapInPlace(cronCtx.tagMapPath, cronCtx.tagMap).catch((err) => {
            cronCtx.log?.warn({ err, tagMapPath: cronCtx.tagMapPath }, 'cron:sync tag-map reload failed; using cached');
          });
          const tagMapSnapshot = { ...cronCtx.tagMap };
          const { runCronSync } = await import('../cron/cron-sync.js');
          const result = await runCronSync({
            client: cronCtx.client,
            forumId: cronCtx.forumId,
            scheduler: cronCtx.scheduler,
            statsStore: cronCtx.statsStore,
            runtime: cronCtx.runtime,
            tagMap: tagMapSnapshot,
            autoTag: cronCtx.autoTag,
            autoTagModel: cronCtx.autoTagModel,
            cwd: cronCtx.cwd,
            log: cronCtx.log,
          });
          cronCtx.forumCountSync?.requestUpdate();
          return {
            ok: true,
            summary: `Cron sync complete: ${result.tagsApplied} tags, ${result.namesUpdated} names, ${result.statusMessagesUpdated} status msgs, ${result.promptMessagesCreated} prompt msgs, ${result.orphansDetected} orphans`,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Cron sync failed: ${msg}` };
      }
    }

    case 'cronExport': {
      // Operator-facing export backed only by canonical local state — no Discord dependency.
      const defs = cronCtx.statsStore.getCanonicalDefinitions();
      const entries = Object.entries(defs);
      if (entries.length === 0) {
        return { ok: true, summary: 'No cron jobs to export.' };
      }
      const exported = entries.map(([cronId, rec]) => ({
        cronId,
        schedule: rec.schedule ?? null,
        timezone: rec.timezone ?? null,
        channel: rec.channel ?? null,
        prompt: rec.prompt ?? null,
        disabled: rec.disabled,
        model: rec.modelOverride ?? rec.model ?? null,
        inputMode: normalizeCronInputMode(rec.inputMode, rec.inputShell),
        inputShell: rec.inputShell ?? null,
        cadence: rec.cadence ?? null,
        purposeTags: rec.purposeTags,
        triggerType: rec.triggerType ?? 'schedule',
        routingMode: rec.routingMode ?? null,
        allowedActions: rec.allowedActions ?? null,
        chain: rec.chain ?? null,
        projectionStatus: rec.projectionStatus ?? null,
        runCount: rec.runCount,
        lastRunStatus: rec.lastRunStatus ?? null,
        lastRunAt: rec.lastRunAt ?? null,
      }));
      return { ok: true, summary: `**Cron Export** (${entries.length} jobs, local store)\n\`\`\`json\n${JSON.stringify(exported, null, 2)}\n\`\`\`` };
    }

    case 'cronTagMapReload': {
      const oldCount = Object.keys(cronCtx.tagMap).length;
      try {
        const newCount = await reloadCronTagMapInPlace(cronCtx.tagMapPath, cronCtx.tagMap);
        const tagNames = Object.keys(cronCtx.tagMap).slice(0, 10);
        const tagList = tagNames.join(', ') + (Object.keys(cronCtx.tagMap).length > 10 ? ', ...' : '');
        let summary = `Tag map reloaded: ${oldCount} → ${newCount} tags [${tagList}]`;
        if (cronCtx.syncCoordinator) {
          cronCtx.syncCoordinator.sync().catch((err) => {
            cronCtx.log?.warn({ err }, 'cron:tagMapReload post-reload sync failed');
          });
          summary += '; sync queued';
        } else {
          summary += '; no sync coordinator configured';
        }
        return { ok: true, summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Tag map reload failed: ${msg}` };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function cronActionsPromptSection(): string {
  return `### Cron Scheduled Tasks

**cronCreate** — \`{"type":"cronCreate","name":"Morning Report","schedule":"0 7 * * 1-5","channel":"general","prompt":"Generate a status update"}\`
Required: \`name\`, \`schedule\` (5-field cron), \`channel\` (name/ID), \`prompt\`.
Optional: \`timezone\` (IANA, default: system), \`model\` (fast|capable|deep), \`tags\` (comma-sep).
Advanced: \`inputMode\` ("shell" + \`inputShell\` for pre-command), \`routingMode\` ("json"), \`allowedActions\` (comma-sep action types), \`chain\` (comma-sep cronIds for pipeline).

**cronUpdate** — \`{"type":"cronUpdate","cronId":"cron-a1b2c3d4","schedule":"0 9 * * *"}\`
\`cronId\` required. Any cronCreate field optional. Also: \`silent\` (bool), \`state\` (JSON string to replace persistent state — clear with \`"{}"\` when changing prompt schema).

**cronList** — \`{"type":"cronList"}\`

**cronShow** — \`{"type":"cronShow","cronId":"cron-a1b2c3d4"}\` — full prompt, schedule, status, config.

**cronPause** / **cronResume** — \`{"type":"cronPause","cronId":"cron-a1b2c3d4"}\`

**cronDelete** — \`{"type":"cronDelete","cronId":"cron-a1b2c3d4"}\` — archives thread (reversible). Unarchiving re-registers the job.

**cronTrigger** — \`{"type":"cronTrigger","cronId":"cron-a1b2c3d4"}\` — immediate manual fire.

**cronSync** — \`{"type":"cronSync"}\` — full bidirectional sync.

**cronExport** — \`{"type":"cronExport"}\` — JSON snapshot of all cron definitions from local store.

**cronTagMapReload** — \`{"type":"cronTagMapReload"}\``;
}
