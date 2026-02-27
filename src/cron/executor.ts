import type { Client, Guild } from 'discord.js';
import type { RuntimeAdapter, ImageData, EngineEvent } from '../runtime/types.js';
import type { CronJob } from './types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { ActionCategoryFlags, ActionContext } from '../discord/actions.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { CronContext } from '../discord/actions-crons.js';
import type { ForgeContext } from '../discord/actions-forge.js';
import type { PlanContext } from '../discord/actions-plan.js';
import type { MemoryContext } from '../discord/actions-memory.js';
import type { ImagegenContext } from '../discord/actions-imagegen.js';
import type { VoiceContext } from '../discord/actions-voice.js';
import type { DeferScheduler } from '../discord/defer-scheduler.js';
import type { DeferActionRequest } from '../discord/actions-defer.js';
import type { CronRunStats } from './run-stats.js';
import type { CronRunControl } from './run-control.js';
import { acquireCronLock, releaseCronLock } from './job-lock.js';
import { resolveChannel } from '../discord/action-utils.js';
import * as discordActions from '../discord/actions.js';
import { sendChunks, appendUnavailableActionTypesNotice, appendParseFailureNotice } from '../discord/output-common.js';
import { buildPromptPreamble, loadWorkspacePaFiles, inlineContextFiles, resolveEffectiveTools } from '../discord/prompt-common.js';
import { ensureStatusMessage } from './discord-sync.js';
import { globalMetrics } from '../observability/metrics.js';
import { mapRuntimeErrorToUserMessage } from '../discord/user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { buildCronPromptBody } from './cron-prompt.js';
import { handleJsonRouteOutput } from './json-router.js';

export type CronExecutorContext = {
  client: Client;
  runtime: RuntimeAdapter;
  model: string;
  cronExecModel?: string;
  cwd: string;
  tools: string[];
  timeoutMs: number;
  status: StatusPoster | null;
  log?: LoggerLike;
  // If set, restrict cron output to these channel IDs (or thread parent IDs).
  allowChannelIds?: Set<string>;
  discordActionsEnabled: boolean;
  actionFlags: ActionCategoryFlags;
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  imagegenCtx?: ImagegenContext;
  voiceCtx?: VoiceContext;
  statsStore?: CronRunStats;
  lockDir?: string;
  runControl?: CronRunControl;
};


async function recordError(ctx: CronExecutorContext, job: CronJob, msg: string): Promise<void> {
  if (ctx.statsStore && job.cronId) {
    try {
      await ctx.statsStore.recordRun(job.cronId, 'error', msg.slice(0, 200));
    } catch {
      // Best-effort.
    }
  }
}

export async function executeCronJob(job: CronJob, ctx: CronExecutorContext): Promise<void> {
  const metrics = globalMetrics;
  let cancelRequested = false;
  const cancelReason = 'Run canceled by cron control action';
  let runtimeIterator: AsyncIterator<EngineEvent> | undefined;
  const requestCancel = () => {
    cancelRequested = true;
    if (runtimeIterator?.return) {
      void runtimeIterator.return();
    }
  };

  // Overlap guard: skip if previous run is still going (in-memory, no lock touched).
  if (job.running) {
    metrics.increment('cron.run.skipped');
    ctx.log?.warn({ jobId: job.id, name: job.name }, 'cron:skip (previous run still active)');
    return;
  }

  // File-based lock: prevents duplicate execution across processes.
  let lockToken: string | undefined;
  if (ctx.lockDir && job.cronId) {
    try {
      lockToken = await acquireCronLock(ctx.lockDir, job.cronId);
    } catch (err) {
      metrics.increment('cron.run.skipped');
      ctx.log?.warn({ jobId: job.id, cronId: job.cronId, err }, 'cron:skip (lock acquire failed)');
      return;
    }
  }

  job.running = true;
  ctx.runControl?.register(job.id, requestCancel);

  try {
    // Best-effort: write running status to persistent store before execution begins.
    if (ctx.statsStore && job.cronId) {
      try {
        await ctx.statsStore.recordRunStart(job.cronId);
      } catch {
        // Non-fatal — don't block execution.
      }
    }

    // Resolve the target channel from the job's owning guild.
    const guild = ctx.client.guilds.cache.get(job.guildId);
    if (!guild) {
      ctx.log?.error({ jobId: job.id, guildId: job.guildId }, 'cron:exec guild not found');
      await ctx.status?.runtimeError({ sessionKey: `cron:${job.id}` }, `Cron "${job.name}": guild ${job.guildId} not found`);
      await recordError(ctx, job, `guild ${job.guildId} not found`);
      return;
    }

    const targetChannel = resolveChannel(guild, job.def.channel);
    if (!targetChannel) {
      ctx.log?.error({ jobId: job.id, channel: job.def.channel }, 'cron:exec target channel not found');
      await ctx.status?.runtimeError(
        { sessionKey: `cron:${job.id}`, channelName: job.def.channel },
        `Cron "${job.name}": target channel "${job.def.channel}" not found`,
      );
      await recordError(ctx, job, `target channel "${job.def.channel}" not found`);
      return;
    }

    type ChannelAllowlistShape = {
      id?: string;
      parentId?: string | null;
      isThread?: () => boolean;
    };
    const channelForSend = targetChannel as {
      id: string;
      send: (opts: { content: string; allowedMentions: unknown; files?: unknown[] }) => Promise<unknown>;
    };
    if (ctx.allowChannelIds) {
      const ch = targetChannel as unknown as ChannelAllowlistShape;
      const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
      const parentId = isThread ? String(ch.parentId ?? '') : '';
      const allowed =
        ctx.allowChannelIds.has(String(ch.id ?? '')) ||
        (parentId && ctx.allowChannelIds.has(parentId));
      if (!allowed) {
        ctx.log?.error({ jobId: job.id, channel: job.def.channel }, 'cron:exec target channel not allowlisted');
        await ctx.status?.runtimeError(
          { sessionKey: `cron:${job.id}`, channelName: job.def.channel },
          `Cron "${job.name}": target channel "${job.def.channel}" is not allowlisted`,
        );
        await recordError(ctx, job, `target channel "${job.def.channel}" not allowlisted`);
        return;
      }
    }

    let inlinedContext = '';
    try {
      const paFiles = await loadWorkspacePaFiles(ctx.cwd);
      inlinedContext = await inlineContextFiles(paFiles);
      ctx.log?.info?.(
        { jobId: job.id, paFileCount: paFiles.length },
        'cron:exec loaded workspace PA files',
      );
    } catch (paErr) {
      ctx.log?.warn?.({ jobId: job.id, err: paErr }, 'cron:exec PA file loading failed, continuing without context');
    }

    // Fetch run record early — needed for prompt flags (silent, routingMode) and model selection.
    const preRunRecord = ctx.statsStore && job.cronId ? ctx.statsStore.getRecord(job.cronId) : undefined;

    let prompt =
      buildPromptPreamble(inlinedContext) +
      '\n\n' +
      buildCronPromptBody({
        jobName: job.name,
        promptTemplate: job.def.prompt,
        channel: job.def.channel,
        channelId: channelForSend.id,
        silent: preRunRecord?.silent,
        routingMode: preRunRecord?.routingMode === 'json' ? 'json' : undefined,
      });

    const tools = await resolveEffectiveTools({
      workspaceCwd: ctx.cwd,
      runtimeTools: ctx.tools,
      runtimeCapabilities: ctx.runtime.capabilities,
      runtimeId: ctx.runtime.id,
      log: ctx.log,
    });
    const effectiveTools = tools.effectiveTools;
    if (tools.permissionNote || tools.runtimeCapabilityNote) {
      const noteLines = [
        tools.permissionNote ? `Permission note: ${tools.permissionNote}` : null,
        tools.runtimeCapabilityNote ? `Runtime capability note: ${tools.runtimeCapabilityNote}` : null,
      ].filter((line): line is string => Boolean(line));
      prompt += `\n\n---\n${noteLines.join('\n')}\n`;
    }

    // Per-cron model selection: per-job override > AI-classified > cron-exec default > chat fallback.
    const cronDefault = ctx.cronExecModel || ctx.model;
    let effectiveModel = cronDefault;
    if (preRunRecord) {
      effectiveModel = preRunRecord.modelOverride ?? preRunRecord.model ?? cronDefault;
    }

    ctx.log?.info(
      { jobId: job.id, name: job.name, channel: job.def.channel, model: effectiveModel, permissionTier: tools.permissionTier },
      'cron:exec start',
    );

    // Best-effort: update pinned status message to show running indicator.
    if (preRunRecord && job.cronId) {
      try {
        await ensureStatusMessage(ctx.client, job.threadId, job.cronId, preRunRecord, ctx.statsStore!, { log: ctx.log, running: true });
      } catch {
        // Non-fatal — don't block execution.
      }
    }

    metrics.recordInvokeStart('cron');
    ctx.log?.info({ flow: 'cron', jobId: job.id, cronId: job.cronId }, 'obs.invoke.start');

    let finalText = '';
    let deltaText = '';
    const collectedImages: ImageData[] = [];
    const t0 = Date.now();
    try {
      runtimeIterator = ctx.runtime.invoke({
        prompt,
        model: resolveModel(effectiveModel, ctx.runtime.id),
        cwd: ctx.cwd,
        addDirs: [ctx.cwd],
        timeoutMs: ctx.timeoutMs,
        tools: effectiveTools,
      })[Symbol.asyncIterator]();
      if (cancelRequested && runtimeIterator.return) {
        await runtimeIterator.return();
      }
      while (true) {
        const next = await runtimeIterator.next();
        if (next.done) break;
        const evt = next.value;
        if (cancelRequested) break;

        if (evt.type === 'text_final') {
          finalText = evt.text;
        } else if (evt.type === 'text_delta') {
          deltaText += evt.text;
        } else if (evt.type === 'image_data') {
          collectedImages.push(evt.image);
        } else if (evt.type === 'error') {
          metrics.recordInvokeResult('cron', Date.now() - t0, false, evt.message);
          metrics.increment('cron.run.error');
          ctx.log?.error({ jobId: job.id, error: evt.message }, 'cron:exec runtime error');
          ctx.log?.warn({ flow: 'cron', jobId: job.id, error: evt.message }, 'obs.invoke.error');
          await ctx.status?.runtimeError(
            { sessionKey: `cron:${job.id}`, channelName: job.def.channel },
            `Cron "${job.name}": ${evt.message}`,
          );
          try {
            await sendChunks(channelForSend, mapRuntimeErrorToUserMessage(evt.message));
          } catch {
            // Best-effort user-facing signal; status channel/log already carry details.
          }
          await recordError(ctx, job, evt.message);
          return;
        }
      }
    } catch (err) {
      if (!cancelRequested) throw err;
    }
    if (cancelRequested) {
      if (runtimeIterator?.return) {
        await runtimeIterator.return();
      }
      metrics.increment('cron.run.canceled');
      ctx.log?.warn({ jobId: job.id, cronId: job.cronId }, 'cron:exec canceled');
      await recordError(ctx, job, cancelReason);
      return;
    }
    metrics.recordInvokeResult('cron', Date.now() - t0, true);
    ctx.log?.info({ flow: 'cron', jobId: job.id, ms: Date.now() - t0, ok: true }, 'obs.invoke.end');

    const output = finalText || deltaText;
    if (!output.trim() && collectedImages.length === 0) {
      metrics.increment('cron.run.skipped');
      ctx.log?.warn({ jobId: job.id }, 'cron:exec empty output');
      if (ctx.statsStore && job.cronId) {
        try {
          await ctx.statsStore.recordRun(job.cronId, 'success');
        } catch {
          // Best-effort.
        }
      }
      return;
    }

    let processedText = output;
    let strippedUnrecognizedTypes: string[] = [];
    let parseFailuresCount = 0;

    // Handle Discord actions if enabled.
    if (ctx.discordActionsEnabled) {
      const parsed = discordActions.parseDiscordActions(processedText, ctx.actionFlags);
      const { cleanText, actions } = parsed;
      strippedUnrecognizedTypes = parsed.strippedUnrecognizedTypes;
      parseFailuresCount = parsed.parseFailures;
      if (actions.length > 0) {
        const actCtx = {
          guild,
          client: ctx.client,
          channelId: targetChannel.id,
          messageId: '',
          deferScheduler: ctx.deferScheduler,
          confirmation: {
            mode: 'automated' as const,
          },
        };
        const results = await discordActions.executeDiscordActions(actions, actCtx, ctx.log, {
          taskCtx: ctx.taskCtx,
          cronCtx: ctx.cronCtx,
          forgeCtx: ctx.forgeCtx,
          planCtx: ctx.planCtx,
          memoryCtx: ctx.memoryCtx,
          imagegenCtx: ctx.imagegenCtx,
          voiceCtx: ctx.voiceCtx,
        });
        for (const result of results) {
          metrics.recordActionResult(result.ok);
          ctx.log?.info({ flow: 'cron', jobId: job.id, ok: result.ok }, 'obs.action.result');
        }
        const displayLines = discordActions.buildDisplayResultLines(actions, results);
        const anyActionSucceeded = results.some((r) => r.ok);
        processedText = displayLines.length > 0
          ? cleanText.trimEnd() + '\n\n' + displayLines.join('\n')
          : cleanText.trimEnd();
        // When all display lines were suppressed and there's no prose, skip posting.
        if (!processedText.trim() && anyActionSucceeded && strippedUnrecognizedTypes.length === 0 && parseFailuresCount === 0) {
          ctx.log?.info({ jobId: job.id }, 'cron:reply suppressed (actions-only, no display text)');
        }

        if (ctx.status) {
          for (let i = 0; i < results.length; i++) {
            if (!results[i].ok) {
              await ctx.status.actionFailed(actions[i].type, (results[i] as { ok: false; error: string }).error);
            }
          }
        }
      } else {
        processedText = cleanText;
      }
    }
    processedText = appendUnavailableActionTypesNotice(processedText, strippedUnrecognizedTypes);
    processedText = appendParseFailureNotice(processedText, parseFailuresCount);

    // Suppress sentinel outputs (e.g. crons whose prompts say "output nothing if idle").
    // Mirrors the reaction handler's logic at reaction-handler.ts:662-674.
    const strippedText = processedText.replace(/\s+/g, ' ').trim();
    const isSuppressible = strippedText === 'HEARTBEAT_OK' || strippedText === '(no output)';
    if (isSuppressible && collectedImages.length === 0) {
      ctx.log?.info({ jobId: job.id, name: job.name, sentinel: strippedText }, 'cron:exec sentinel output suppressed');
      if (ctx.statsStore && job.cronId) {
        try {
          await ctx.statsStore.recordRun(job.cronId, 'success');
        } catch {
          // Best-effort.
        }
      }
      metrics.increment('cron.run.success');
      return;
    }

    // Silent-mode short-response gate: suppress paraphrased "nothing to report" responses.
    // Skip in JSON routing mode — handleJsonRouteOutput already treats [] as a no-op,
    // and short JSON payloads (e.g. a single-entry array) contain real content.
    if (preRunRecord?.silent && preRunRecord?.routingMode !== 'json' && collectedImages.length === 0 && strippedText.length <= 80) {
      ctx.log?.info({ jobId: job.id, name: job.name, len: strippedText.length }, 'cron:exec silent short-response suppressed');
      if (ctx.statsStore && job.cronId) {
        try {
          await ctx.statsStore.recordRun(job.cronId, 'success');
        } catch {
          // Best-effort.
        }
      }
      metrics.increment('cron.run.success');
      return;
    }

    if (preRunRecord?.routingMode === 'json') {
      const resolveJsonChannel = (ref: string) => {
        const ch = resolveChannel(guild, ref);
        if (!ch) return undefined;
        if (ctx.allowChannelIds) {
          const chObj = ch as unknown as { id?: string; parentId?: string | null; isThread?: () => boolean };
          const chId = chObj.id ?? '';
          const isThread = typeof chObj.isThread === 'function' ? chObj.isThread() : false;
          const parentId = isThread ? String(chObj.parentId ?? '') : '';
          const allowed = ctx.allowChannelIds.has(chId) || (Boolean(parentId) && ctx.allowChannelIds.has(parentId));
          if (!allowed) {
            ctx.log?.warn({ jobId: job.id, channel: ref }, 'cron:json-routing channel not allowlisted, skipping');
            return undefined;
          }
        }
        return ch as unknown as typeof channelForSend;
      };
      await handleJsonRouteOutput(output, resolveJsonChannel, channelForSend, {
        log: ctx.log,
        jobId: job.id,
      });
    } else {
      await sendChunks(channelForSend, processedText, collectedImages);
    }

    ctx.log?.info({ jobId: job.id, name: job.name, channel: job.def.channel }, 'cron:exec done');
    metrics.increment('cron.run.success');

    // Record successful run.
    if (ctx.statsStore && job.cronId) {
      try {
        await ctx.statsStore.recordRun(job.cronId, 'success');
      } catch (statsErr) {
        ctx.log?.warn({ err: statsErr, jobId: job.id }, 'cron:exec stats record failed');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    metrics.increment('cron.run.error');
    ctx.log?.error({ err, jobId: job.id }, 'cron:exec failed');
    await ctx.status?.runtimeError(
      { sessionKey: `cron:${job.id}`, channelName: job.def.channel },
      `Cron "${job.name}": ${msg}`,
    );

    if (ctx.client) {
      const guild = ctx.client.guilds.cache.get(job.guildId);
      const targetChannel = guild ? resolveChannel(guild, job.def.channel) : null;
      if (targetChannel) {
        const channelForSend = targetChannel as {
          send: (opts: { content: string; allowedMentions: unknown; files?: unknown[] }) => Promise<unknown>;
        };
        try {
          await sendChunks(channelForSend, mapRuntimeErrorToUserMessage(msg));
        } catch {
          // Best-effort.
        }
      }
    }

    await recordError(ctx, job, msg);
  } finally {
    if (lockToken && ctx.lockDir && job.cronId) {
      await releaseCronLock(ctx.lockDir, job.cronId, lockToken).catch((err) => {
        ctx.log?.warn({ err, jobId: job.id, cronId: job.cronId }, 'cron:exec lock release failed');
      });
    }
    ctx.runControl?.clear(job.id, requestCancel);
    job.running = false;

    // Update bot-owned status message.
    if (ctx.statsStore && job.cronId) {
      try {
        const record = ctx.statsStore.getRecord(job.cronId);
        if (record) {
          await ensureStatusMessage(ctx.client, job.threadId, job.cronId, record, ctx.statsStore, { log: ctx.log });
        }
      } catch (statusErr) {
        ctx.log?.warn({ err: statusErr, jobId: job.id }, 'cron:exec status message update failed');
      }
    }
  }
}
