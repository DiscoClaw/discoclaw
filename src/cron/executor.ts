import { randomUUID } from 'node:crypto';
import type { Client, Guild } from 'discord.js';
import { execa } from 'execa';
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
import { resolveDefaultModel as resolveImagegenDefaultModel } from '../discord/actions-imagegen.js';
import type { ImagegenContext } from '../discord/actions-imagegen.js';
import type { VoiceContext } from '../discord/actions-voice.js';
import type { DeferScheduler } from '../discord/defer-scheduler.js';
import type { DeferActionRequest } from '../discord/actions-defer.js';
import type { CronRunStats } from './run-stats.js';
import type { CronRunControl } from './run-control.js';
import { acquireCronLock, releaseCronLock } from './job-lock.js';
import { resolveChannel } from '../discord/action-utils.js';
import { DiscordTransportClient } from '../discord/transport-client.js';
import * as discordActions from '../discord/actions.js';
import { withoutRequesterGatedActionFlags } from '../discord/actions.js';
import { sendChunks, appendUnavailableActionTypesNotice, appendParseFailureNotice } from '../discord/output-common.js';
import { buildPromptPreamble, loadWorkspacePaFiles, inlineContextFiles, resolveEffectiveTools } from '../discord/prompt-common.js';
import { ensureStatusMessage } from './discord-sync.js';
import { globalMetrics } from '../observability/metrics.js';
import { globalTraceStore } from '../observability/trace-store.js';
import { mapRuntimeErrorToUserMessage } from '../discord/user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { cliExecaEnv, stripAnsi } from '../runtime/cli-shared.js';
import { resolveGroundedToolCapabilities } from '../runtime/tool-capabilities.js';
import { buildCronPromptBody } from './cron-prompt.js';
import type { CronShellResult } from './cron-prompt.js';
import { buildTieredDiscordActionsPromptSection } from '../discord/actions.js';
import { handleJsonRouteOutput } from './json-router.js';

export type CronExecutorContext = {
  client: Client;
  runtime: RuntimeAdapter;
  model: string;
  cronExecModel?: string;
  cwd: string;
  tools: string[];
  enableHybridPipeline?: boolean;
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
  botDisplayName?: string;
  statsStore?: CronRunStats;
  lockDir?: string;
  runControl?: CronRunControl;
  chainDepth?: number;
  getSchedulerJob?: (threadId: string) => CronJob | undefined;
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

async function recordSuccess(ctx: CronExecutorContext, job: CronJob): Promise<void> {
  if (ctx.statsStore && job.cronId) {
    try {
      await ctx.statsStore.recordRun(job.cronId, 'success');
    } catch {
      // Best-effort.
    }
    void fireChainedJobs(job.cronId, ctx);
  }
}

const MAX_CHAIN_DEPTH = 10;
const CRON_REQUESTER_DENY_ALL_PREFIX = '__cron_requester_deny_all__';
const activeCronRunKeys = new Set<string>();
const queuedCronRerunKeys = new Set<string>();

type CronShellFailureKind = 'spawn-failure' | 'timeout' | 'signal' | 'non-zero-exit';

type CronShellOutcome =
  | { kind: 'success'; shellResult: CronShellResult }
  | { kind: CronShellFailureKind; message: string };

type CronOutputDirective = 'post' | 'no-post';

type ParsedCronOutput = {
  directive?: CronOutputDirective;
  text: string;
};

type CronActionRequester = {
  requesterId: string;
  trusted: boolean;
  reason?: 'missing-author' | 'bot-author';
};

function resolveCronActionRequester(job: CronJob, authorId: string | undefined, botUserId: string | undefined): CronActionRequester {
  const normalizedAuthorId = authorId?.trim() ?? '';
  const normalizedBotUserId = botUserId?.trim() ?? '';
  if (!normalizedAuthorId) {
    return {
      requesterId: `${CRON_REQUESTER_DENY_ALL_PREFIX}:${job.cronId || job.id}`,
      trusted: false,
      reason: 'missing-author',
    };
  }
  if (normalizedBotUserId && normalizedAuthorId === normalizedBotUserId) {
    return {
      requesterId: `${CRON_REQUESTER_DENY_ALL_PREFIX}:${job.cronId || job.id}`,
      trusted: false,
      reason: 'bot-author',
    };
  }
  return {
    requesterId: normalizedAuthorId,
    trusted: true,
  };
}

async function runCronInputShell(command: string, cwd: string, timeoutMs: number): Promise<CronShellOutcome> {
  try {
    const result = await execa('bash', ['-lc', command], {
      reject: false,
      timeout: timeoutMs,
      cwd,
      env: cliExecaEnv(),
    });

    if (result.timedOut) {
      return {
        kind: 'timeout',
        message: `cron pre-command timed out after ${timeoutMs}ms`,
      };
    }

    if (result.failed && result.exitCode == null && !result.signal) {
      return {
        kind: 'spawn-failure',
        message: 'cron pre-command failed to spawn',
      };
    }

    if (result.signal) {
      return {
        kind: 'signal',
        message: `cron pre-command exited from signal ${result.signal}`,
      };
    }

    if (result.exitCode !== 0) {
      return {
        kind: 'non-zero-exit',
        message: `cron pre-command exited with code ${result.exitCode}`,
      };
    }

    return {
      kind: 'success',
      shellResult: {
        exitCode: result.exitCode ?? 0,
        stdout: stripAnsi(result.stdout),
        stderr: stripAnsi(result.stderr),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'spawn-failure',
      message: `cron pre-command failed to spawn: ${message}`,
    };
  }
}

function parseCronOutputDirective(output: string, job: CronJob, ctx: CronExecutorContext): ParsedCronOutput {
  const cronOutputRegex = /<cron-output>([\s\S]*?)<\/cron-output>/g;
  const matches = Array.from(output.matchAll(cronOutputRegex));
  const text = output.replace(cronOutputRegex, '').trim();

  if (matches.length === 0) {
    return { text };
  }

  if (matches.length > 1) {
    ctx.log?.warn({ jobId: job.id, cronId: job.cronId, blockCount: matches.length }, 'cron:exec <cron-output> ambiguous, ignoring');
    return { text };
  }

  const block = matches[0]?.[1]?.trim() ?? '';
  try {
    const parsed = JSON.parse(block) as { mode?: unknown };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.log?.warn({ jobId: job.id, cronId: job.cronId }, 'cron:exec <cron-output> was not a JSON object, ignoring');
      return { text };
    }
    if (parsed.mode !== 'post' && parsed.mode !== 'no-post') {
      ctx.log?.warn({ jobId: job.id, cronId: job.cronId, mode: parsed.mode ?? null }, 'cron:exec <cron-output> mode invalid, ignoring');
      return { text };
    }
    return {
      directive: parsed.mode,
      text,
    };
  } catch (err) {
    ctx.log?.warn({ err, jobId: job.id, cronId: job.cronId }, 'cron:exec <cron-output> parse failed, ignoring');
    return { text };
  }
}

export async function fireChainedJobs(cronId: string, ctx: CronExecutorContext): Promise<void> {
  const chainDepth = ctx.chainDepth ?? 0;
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    ctx.log?.warn({ cronId, chainDepth }, 'chain:depth limit reached, skipping downstream');
    return;
  }

  if (!ctx.statsStore || !ctx.getSchedulerJob) return;

  const record = ctx.statsStore.getRecord(cronId);
  if (!record?.chain || record.chain.length === 0) return;

  const upstreamState = record.state;

  for (const downstreamCronId of record.chain) {
    const downstreamRecord = ctx.statsStore.getRecord(downstreamCronId);
    if (!downstreamRecord) {
      ctx.log?.warn({ cronId, downstream: downstreamCronId }, 'chain:downstream record not found, skipping');
      continue;
    }

    const downstreamJob = ctx.getSchedulerJob(downstreamRecord.threadId);
    if (!downstreamJob) {
      ctx.log?.warn({ cronId, downstream: downstreamCronId, threadId: downstreamRecord.threadId }, 'chain:downstream scheduler job not found, skipping');
      continue;
    }

    // Merge __upstream into downstream job's persisted state so the prompt's {{state}} includes handoff data.
    try {
      const forwardedState: Record<string, unknown> = {
        ...(downstreamRecord.state ?? {}),
        __upstream: { fromCronId: cronId, state: upstreamState ?? {} },
      };
      await ctx.statsStore.upsertRecord(downstreamCronId, downstreamRecord.threadId, { state: forwardedState });
      ctx.log?.info({ cronId, downstream: downstreamCronId }, 'chain:state forwarded');
    } catch (err) {
      ctx.log?.warn({ err, cronId, downstream: downstreamCronId }, 'chain:state forward failed');
    }

    // Fire-and-forget with incremented chain depth.
    const downstreamCtx: CronExecutorContext = { ...ctx, chainDepth: chainDepth + 1 };
    void executeCronJob(downstreamJob, downstreamCtx).catch((err) => {
      ctx.log?.warn({ err, cronId, downstream: downstreamCronId }, 'chain:downstream execution failed');
    });

    ctx.log?.info({ cronId, downstream: downstreamCronId }, 'chain:downstream fired');
  }
}

export async function executeCronJob(job: CronJob, ctx: CronExecutorContext): Promise<void> {
  const metrics = globalMetrics;
  let cancelRequested = false;
  const cancelReason = 'Run canceled by cron control action';
  let runtimeIterator: AsyncIterator<EngineEvent> | undefined;
  const runKey = job.cronId || job.id;
  const requestCancel = () => {
    cancelRequested = true;
    if (runtimeIterator?.return) {
      void runtimeIterator.return();
    }
  };

  // Overlap guard: skip if previous run is still going (in-memory, no lock touched).
  if (job.running) {
    metrics.increment('cron.run.skipped');
    if (activeCronRunKeys.has(runKey)) {
      queuedCronRerunKeys.add(runKey);
      ctx.log?.warn({ jobId: job.id, name: job.name, cronId: job.cronId }, 'cron:skip (previous run still active; queued rerun)');
    } else {
      ctx.log?.warn({ jobId: job.id, name: job.name, cronId: job.cronId }, 'cron:skip (previous run still active)');
    }
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

  const traceId = `cron_${randomUUID()}`;
  const sessionKey = `cron:${job.cronId || job.id}`;
  let traceOutcome = 'success';
  globalTraceStore.startTrace(traceId, sessionKey, 'cron', undefined);

  job.running = true;
  activeCronRunKeys.add(runKey);
  ctx.runControl?.register(job.id, requestCancel);

  // Pre-fetch the silent flag before the try block so the catch block can gate
  // channel error posts. Without this, errors (e.g. shell timeouts) spam the
  // channel even when the cron is configured as silent.
  const isSilent = Boolean(ctx.statsStore && job.cronId && ctx.statsStore.getRecord(job.cronId)?.silent);

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
    const inputShell = preRunRecord?.inputShell?.trim() ? preRunRecord.inputShell.trim() : undefined;
    const shellInputEnabled = preRunRecord?.inputMode === 'shell' || Boolean(inputShell);
    let shellResult: CronShellResult | undefined;
    if (shellInputEnabled && inputShell) {
      const shellOutcome = await runCronInputShell(inputShell, ctx.cwd, ctx.timeoutMs);
      if (shellOutcome.kind !== 'success') {
        ctx.log?.error({ jobId: job.id, cronId: job.cronId, kind: shellOutcome.kind }, 'cron:exec pre-command failed');
        throw new Error(shellOutcome.message);
      }
      shellResult = shellOutcome.shellResult;
      if (preRunRecord?.silent && shellResult.stdout === '' && shellResult.stderr === '') {
        ctx.log?.info({ jobId: job.id, cronId: job.cronId }, 'cron:exec silent shell input produced no output; skipping AI');
        metrics.increment('cron.run.success');
        await recordSuccess(ctx, job);
        return;
      }
    }

    const actionRequester = resolveCronActionRequester(job, preRunRecord?.authorId, ctx.client.user?.id);
    if (!actionRequester.trusted) {
      ctx.log?.warn(
        {
          jobId: job.id,
          cronId: job.cronId,
          authorId: preRunRecord?.authorId ?? null,
          reason: actionRequester.reason,
        },
        'cron:exec requester context unavailable; requester-gated guild-scoped discord actions will fail closed',
      );
    }
    const cronActionFlags = actionRequester.trusted
      ? ctx.actionFlags
      : withoutRequesterGatedActionFlags(ctx.actionFlags);

    let prompt =
      buildPromptPreamble(inlinedContext, {
        runtimeId: ctx.runtime.id,
        runtimeCapabilities: ctx.runtime.capabilities,
        runtimeTools: ctx.tools,
        enableHybridPipeline: ctx.enableHybridPipeline,
      }) +
      '\n\n' +
      buildCronPromptBody({
        jobName: job.name,
        promptTemplate: job.def.prompt,
        channel: job.def.channel,
        channelId: channelForSend.id,
        silent: preRunRecord?.silent,
        routingMode: preRunRecord?.routingMode === 'json' ? 'json' : undefined,
        state: preRunRecord?.state,
        inputMode: preRunRecord?.inputMode,
        inputShell,
        shellResult,
      });

    // Inject tiered action schema documentation when discord actions are enabled.
    if (ctx.discordActionsEnabled) {
      const actionSelection = buildTieredDiscordActionsPromptSection(
        cronActionFlags,
        ctx.botDisplayName,
        { userText: job.def.prompt, imagegenDefaultModel: ctx.imagegenCtx ? resolveImagegenDefaultModel(ctx.imagegenCtx) : undefined },
      );
      if (actionSelection.prompt) {
        prompt += '\n\n---\n' + actionSelection.prompt;
      }
    }

    const tools = await resolveEffectiveTools({
      workspaceCwd: ctx.cwd,
      runtimeTools: ctx.tools,
      runtimeCapabilities: resolveGroundedToolCapabilities(ctx.runtime),
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
    globalTraceStore.addEvent(traceId, {
      type: 'invoke_start',
      at: Date.now(),
      summary: `cron job "${job.name}"`,
      promptPreview: prompt.slice(0, 220),
    });
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
          traceOutcome = 'error';
          globalTraceStore.addEvent(traceId, {
            type: 'error',
            at: Date.now(),
            message: evt.message,
            stage: 'runtime',
          });
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
      traceOutcome = 'canceled';
      globalTraceStore.addEvent(traceId, {
        type: 'error',
        at: Date.now(),
        message: cancelReason,
        stage: 'runtime',
      });
      metrics.increment('cron.run.canceled');
      ctx.log?.warn({ jobId: job.id, cronId: job.cronId }, 'cron:exec canceled');
      await recordError(ctx, job, cancelReason);
      return;
    }
    globalTraceStore.addEvent(traceId, {
      type: 'invoke_end',
      at: Date.now(),
      ok: true,
      summary: `completed in ${Date.now() - t0}ms`,
    });
    metrics.recordInvokeResult('cron', Date.now() - t0, true);
    ctx.log?.info({ flow: 'cron', jobId: job.id, ms: Date.now() - t0, ok: true }, 'obs.invoke.end');

    let output = finalText || deltaText;

    // Extract <cron-state> blocks from the output — last one wins.
    const cronStateRegex = /<cron-state>([\s\S]*?)<\/cron-state>/g;
    let cronStateMatch: RegExpExecArray | null;
    let lastCronStateJson: string | undefined;
    while ((cronStateMatch = cronStateRegex.exec(output)) !== null) {
      lastCronStateJson = cronStateMatch[1];
    }
    if (lastCronStateJson !== undefined && ctx.statsStore && job.cronId) {
      try {
        const parsedState = JSON.parse(lastCronStateJson.trim()) as Record<string, unknown>;
        if (parsedState && typeof parsedState === 'object' && !Array.isArray(parsedState)) {
          await ctx.statsStore.upsertRecord(job.cronId, job.threadId, { state: parsedState });
          ctx.log?.info({ jobId: job.id, cronId: job.cronId }, 'cron:exec persisted updated state');
        } else {
          ctx.log?.warn({ jobId: job.id, cronId: job.cronId }, 'cron:exec <cron-state> was not a JSON object, ignoring');
        }
      } catch (stateErr) {
        ctx.log?.warn({ err: stateErr, jobId: job.id, cronId: job.cronId }, 'cron:exec <cron-state> parse failed, ignoring');
      }
      // Strip all <cron-state> blocks from the output text.
      output = output.replace(/<cron-state>[\s\S]*?<\/cron-state>/g, '').trim();
    }

    const cronOutput = parseCronOutputDirective(output, job, ctx);
    output = cronOutput.text;
    if (cronOutput.directive === 'no-post') {
      ctx.log?.info({ jobId: job.id, cronId: job.cronId }, 'cron:exec structured no-post suppressed');
      await recordSuccess(ctx, job);
      metrics.increment('cron.run.success');
      return;
    }

    if (!output.trim() && collectedImages.length === 0) {
      metrics.increment('cron.run.skipped');
      ctx.log?.warn({ jobId: job.id }, 'cron:exec empty output');
      await recordSuccess(ctx, job);
      return;
    }

    let processedText = output;
    let strippedUnrecognizedTypes: string[] = [];
    let parseFailuresCount = 0;

    // Handle Discord actions if enabled.
    if (ctx.discordActionsEnabled) {
      const parsed = discordActions.parseDiscordActions(processedText, cronActionFlags);
      const { cleanText, actions: parsedActions } = parsed;
      strippedUnrecognizedTypes = parsed.strippedUnrecognizedTypes;
      parseFailuresCount = parsed.parseFailures;

      // Per-job action type filtering: if the stats record declares allowedActions,
      // strip any action type not in that set before execution.
      const blockedActionTypes: string[] = [];
      const actions = (() => {
        const allowed = preRunRecord?.allowedActions;
        if (!allowed || allowed.length === 0) return parsedActions;
        const allowedSet = new Set(allowed);
        return parsedActions.filter((action) => {
          if (allowedSet.has(action.type)) return true;
          ctx.log?.warn({ jobId: job.id, cronId: job.cronId, actionType: action.type }, 'cron:exec action blocked by allowedActions');
          blockedActionTypes.push(action.type);
          return false;
        });
      })();

      if (actions.length > 0) {
        const actCtx = {
          guild,
          client: ctx.client,
          channelId: targetChannel.id,
          messageId: '',
          requesterId: actionRequester.requesterId,
          deferScheduler: ctx.deferScheduler,
          transport: new DiscordTransportClient(guild, ctx.client),
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
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          metrics.recordActionResult(result.ok);
          globalTraceStore.addEvent(traceId, {
            type: 'action_result',
            at: Date.now(),
            action: actions[i].type,
            ok: result.ok,
            detail: result.ok ? undefined : ('error' in result ? result.error : undefined),
          });
          ctx.log?.info({ flow: 'cron', jobId: job.id, ok: result.ok }, 'obs.action.result');
        }
        const anyActionSucceeded = results.some((r) => r.ok);
        processedText = discordActions.appendActionResults(cleanText.trimEnd(), actions, results);
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

      // Append a notice for each action type denied by allowedActions.
      if (blockedActionTypes.length > 0) {
        const blockedLines = blockedActionTypes.map(
          (type) => `Blocked action \`${type}\` (not in this job's allowedActions).`,
        );
        processedText = processedText.trimEnd() + '\n\n' + blockedLines.join('\n');
      }
    }
    processedText = appendUnavailableActionTypesNotice(processedText, strippedUnrecognizedTypes);
    processedText = appendParseFailureNotice(processedText, parseFailuresCount);

    // Suppress sentinel outputs (e.g. crons whose prompts say "output nothing if idle").
    // Mirrors the reaction handler's logic at reaction-handler.ts:662-674.
    const strippedText = processedText.replace(/\s+/g, ' ').trim();
    const isSuppressible = /^heartbeat(_ok)?$/i.test(strippedText) || strippedText === 'HEART' || strippedText === '(no output)' || /^[\u2764\uFE0F]+$/.test(strippedText);
    if (isSuppressible && collectedImages.length === 0) {
      ctx.log?.info({ jobId: job.id, name: job.name, sentinel: strippedText }, 'cron:exec sentinel output suppressed');
      await recordSuccess(ctx, job);
      metrics.increment('cron.run.success');
      return;
    }

    // Silent-mode short-response gate: suppress paraphrased "nothing to report" responses.
    // Skip in JSON routing mode — handleJsonRouteOutput already treats [] as a no-op,
    // and short JSON payloads (e.g. a single-entry array) contain real content.
    if (preRunRecord?.silent && preRunRecord?.routingMode !== 'json' && collectedImages.length === 0 && strippedText.length <= 80) {
      ctx.log?.info({ jobId: job.id, name: job.name, len: strippedText.length }, 'cron:exec silent short-response suppressed');
      await recordSuccess(ctx, job);
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
    try {
      await recordSuccess(ctx, job);
    } catch (statsErr) {
      ctx.log?.warn({ err: statsErr, jobId: job.id }, 'cron:exec stats record failed');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    traceOutcome = 'error';
    globalTraceStore.addEvent(traceId, {
      type: 'error',
      at: Date.now(),
      message: msg,
      name: err instanceof Error ? err.name : undefined,
      stage: 'cron_flow',
      stack: err instanceof Error ? err.stack?.slice(0, 400) : undefined,
    });
    metrics.increment('cron.run.error');
    ctx.log?.error({ err, jobId: job.id }, 'cron:exec failed');
    await ctx.status?.runtimeError(
      { sessionKey: `cron:${job.id}`, channelName: job.def.channel },
      `Cron "${job.name}": ${msg}`,
    );

    if (!isSilent && ctx.client) {
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
    globalTraceStore.endTrace(traceId, traceOutcome);
    const shouldRerun = queuedCronRerunKeys.delete(runKey);
    if (lockToken && ctx.lockDir && job.cronId) {
      await releaseCronLock(ctx.lockDir, job.cronId, lockToken).catch((err) => {
        ctx.log?.warn({ err, jobId: job.id, cronId: job.cronId }, 'cron:exec lock release failed');
      });
    }
    ctx.runControl?.clear(job.id, requestCancel);
    activeCronRunKeys.delete(runKey);
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

    if (shouldRerun) {
      ctx.log?.info({ jobId: job.id, cronId: job.cronId }, 'cron:rerun firing queued overlap');
      queueMicrotask(() => {
        void executeCronJob(job, ctx).catch((err) => {
          ctx.log?.warn({ err, jobId: job.id, cronId: job.cronId }, 'cron:rerun queued overlap failed');
        });
      });
    }
  }
}
