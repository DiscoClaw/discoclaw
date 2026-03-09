import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { ActionContext, ActionCategoryFlags, DiscordActionResult, RequesterMemberContext } from './actions.js';
import { appendActionResults, buildTieredDiscordActionsPromptSection, executeDiscordActions, parseDiscordActions } from './actions.js';
import { DiscordTransportClient } from './transport-client.js';
import { fmtTime, resolveChannel } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import type { CronContext } from './actions-crons.js';
import type { DeferActionRequest, DeferredRun } from './actions-defer.js';
import type { DeferScheduler } from './defer-scheduler.js';
import { DeferScheduler as DeferSchedulerImpl } from './defer-scheduler.js';
import type { DiscordChannelContext } from './channel-context.js';
import { resolveDiscordChannelContext } from './channel-context.js';
import type { ForgeContext } from './actions-forge.js';
import type { PlanContext } from './actions-plan.js';
import type { MemoryContext } from './actions-memory.js';
import type { ConfigContext } from './actions-config.js';
import type { ImagegenContext } from './actions-imagegen.js';
import type { VoiceContext } from './actions-voice.js';
import type { SpawnContext } from './actions-spawn.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { appendUnavailableActionTypesNotice, appendParseFailureNotice } from './output-common.js';
import {
  buildPromptSectionEstimates,
  buildContextFiles,
  buildOpenTasksSection,
  buildScheduledSelfInvocationPrompt,
  inlineContextFilesWithMeta,
  loadWorkspacePaFiles,
  resolveEffectiveTools,
} from './prompt-common.js';
import type { InlinedContextSection } from './prompt-common.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { globalMetrics } from '../observability/metrics.js';
import type { StatusPoster } from './status-channel.js';

type ThreadChannelShape = {
  isThread?: () => boolean;
  parentId?: unknown;
};

const REQUESTER_DENY_ALL = { __requesterDenyAll: true } as const;

type DeferredRunnerState = {
  allowChannelIds?: Set<string>;
  runtimeModel: string;
  discordActionsEnabled: boolean;
  discordActionsChannels: boolean;
  discordActionsMessaging: boolean;
  discordActionsGuild: boolean;
  discordActionsModeration: boolean;
  discordActionsPolls: boolean;
  discordActionsTasks?: boolean;
  discordActionsCrons?: boolean;
  discordActionsBotProfile?: boolean;
  discordActionsForge?: boolean;
  discordActionsPlan?: boolean;
  discordActionsConfig?: boolean;
  discordActionsImagegen?: boolean;
  discordActionsVoice?: boolean;
  discordActionsSpawn?: boolean;
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
  imagegenCtx?: ImagegenContext;
  voiceCtx?: VoiceContext;
  spawnCtx?: SpawnContext;
};

export type ConfigureDeferredSchedulerOpts = {
  maxDelaySeconds: number;
  maxConcurrent: number;
  deferMaxDepth: number;
  state: DeferredRunnerState;
  runtime: RuntimeAdapter;
  runtimeTools: string[];
  runtimeTimeoutMs: number;
  workspaceCwd: string;
  discordChannelContext?: DiscordChannelContext;
  appendSystemPrompt?: string;
  useGroupDirCwd: boolean;
  botDisplayName: string;
  log?: LoggerLike;
  status?: StatusPoster | null;
};

function getThreadParentId(candidate: unknown): string | null {
  const channel = candidate as ThreadChannelShape | null | undefined;
  if (!channel) return null;
  const isThread = typeof channel.isThread === 'function' ? channel.isThread() : false;
  if (!isThread) return null;
  if (channel.parentId === null || channel.parentId === undefined) return null;
  return String(channel.parentId);
}

function isRequesterDenyAll(
  requesterMember: RequesterMemberContext,
): requesterMember is typeof REQUESTER_DENY_ALL {
  return Boolean(requesterMember && typeof requesterMember === 'object' && '__requesterDenyAll' in requesterMember);
}

async function resolveRequesterMember(context: ActionContext): Promise<RequesterMemberContext> {
  if (!context.requesterId) return REQUESTER_DENY_ALL;
  const fetchRequester = (context.guild.members as { fetch?: (userId: string) => Promise<GuildMember> })?.fetch;
  if (typeof fetchRequester !== 'function') return REQUESTER_DENY_ALL;
  return fetchRequester.call(context.guild.members, context.requesterId).catch(() => REQUESTER_DENY_ALL);
}

function threadSendPermissionFor(channelType: ChannelType | undefined): bigint {
  return (
    channelType === ChannelType.PublicThread
    || channelType === ChannelType.PrivateThread
    || channelType === ChannelType.AnnouncementThread
  )
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function requesterCanAccessTargetChannel(
  channel: unknown,
  requesterMember: Exclude<RequesterMemberContext, typeof REQUESTER_DENY_ALL | undefined>,
): boolean {
  if (!channel || typeof channel !== 'object') return false;
  if (!('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') return false;
  const resolved = channel.permissionsFor(requesterMember);
  const channelType = 'type' in channel ? channel.type as ChannelType | undefined : undefined;
  return Boolean(
    resolved?.has?.(PermissionFlagsBits.ViewChannel | threadSendPermissionFor(channelType)),
  );
}

function buildDeferredActionFlags(state: DeferredRunnerState, depth: number, maxDepth: number): ActionCategoryFlags {
  return {
    channels: state.discordActionsChannels,
    messaging: state.discordActionsMessaging,
    guild: state.discordActionsGuild,
    moderation: state.discordActionsModeration,
    polls: state.discordActionsPolls,
    tasks: Boolean(state.discordActionsTasks),
    crons: Boolean(state.discordActionsCrons),
    botProfile: Boolean(state.discordActionsBotProfile),
    forge: Boolean(state.discordActionsForge),
    plan: Boolean(state.discordActionsPlan),
    // Deferred runs do not carry a user identity, so memory actions stay disabled.
    memory: false,
    config: Boolean(state.discordActionsConfig),
    defer: depth < maxDepth,
    imagegen: Boolean(state.discordActionsImagegen),
    voice: Boolean(state.discordActionsVoice),
    spawn: Boolean(state.discordActionsSpawn),
  };
}

export function configureDeferredScheduler(
  opts: ConfigureDeferredSchedulerOpts,
): DeferScheduler<DeferActionRequest, ActionContext> {
  const handleDeferredRun = async (run: DeferredRun): Promise<void> => {
    const { action, context } = run;
    const guild = context.guild;
    if (!guild) {
      opts.log?.warn({ flow: 'defer', run, action }, 'defer:missing-guild');
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      opts.status?.handlerError({ sessionKey: 'defer' }, 'deferred run skipped: no guild context');
      return;
    }

    const channel = resolveChannel(guild, action.channel);
    if (!channel) {
      opts.log?.warn({ flow: 'defer', run, channel: action.channel }, 'defer:target channel not found');
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      opts.status?.handlerError({ sessionKey: `defer:${action.channel}` }, `deferred run skipped: channel "${action.channel}" not found`);
      return;
    }

    if (opts.state.allowChannelIds?.size) {
      const parentId = getThreadParentId(channel) ?? '';
      const allowed =
        opts.state.allowChannelIds.has(channel.id) ||
        (parentId && opts.state.allowChannelIds.has(parentId));
      if (!allowed) {
        opts.log?.warn({ flow: 'defer', channelId: channel.id }, 'defer:target channel not allowlisted');
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        opts.status?.handlerError({ sessionKey: `defer:${channel.id}` }, `deferred run skipped: channel ${channel.id} not in allowlist`);
        return;
      }
    }

    const threadParentId = getThreadParentId(channel);
    const requesterMember = await resolveRequesterMember(context);
    if (
      isRequesterDenyAll(requesterMember)
      || (requesterMember && !requesterCanAccessTargetChannel(channel, requesterMember))
    ) {
      opts.log?.warn({ flow: 'defer', channelId: channel.id, requesterId: context.requesterId }, 'defer:target channel permission denied');
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      opts.status?.handlerError(
        { sessionKey: `defer:${channel.id}` },
        `deferred run skipped: requester lacks permission for channel ${channel.id}`,
      );
      return;
    }
    const channelCtx = resolveDiscordChannelContext({
      ctx: opts.discordChannelContext,
      isDm: false,
      channelId: channel.id,
      threadParentId,
    });

    const paFiles = await loadWorkspacePaFiles(opts.workspaceCwd, { skip: !!opts.appendSystemPrompt });
    const contextFiles = buildContextFiles(paFiles, opts.discordChannelContext, channelCtx.contextPath);
    let inlinedContext: { text: string; sections: InlinedContextSection[] } = {
      text: '',
      sections: [],
    };
    if (contextFiles.length > 0) {
      try {
        inlinedContext = await inlineContextFilesWithMeta(contextFiles, {
          required: new Set(opts.discordChannelContext?.paContextFiles ?? []),
        });
      } catch (err) {
        opts.log?.warn({ flow: 'defer', channelId: channel.id, err }, 'defer:context inline failed');
      }
    }

    const deferDepth = (context.deferDepth ?? 0) + 1;
    const deferredActionFlags = buildDeferredActionFlags(opts.state, deferDepth, opts.deferMaxDepth);
    const openTasksSection = buildOpenTasksSection(opts.state.taskCtx?.store);
    let actionsReferenceSection = '';
    let actionSchemaSelection:
      | {
        includedCategories: string[];
        tierBuckets: { core: string[]; channelContextual: string[]; keywordTriggered: string[] };
        keywordHits: string[];
      }
      | null = null;
    if (opts.state.discordActionsEnabled) {
      const actionSelection = buildTieredDiscordActionsPromptSection(
        deferredActionFlags,
        opts.botDisplayName,
        {
          channelName: channelCtx.channelName,
          channelContextPath: channelCtx.contextPath,
          isThread: threadParentId !== null,
          userText: action.prompt,
        },
      );
      actionsReferenceSection = actionSelection.prompt;
      actionSchemaSelection = {
        includedCategories: actionSelection.includedCategories,
        tierBuckets: actionSelection.tierBuckets,
        keywordHits: actionSelection.keywordHits,
      };
    }

    const promptSectionEstimates = buildPromptSectionEstimates({
      contextSections: inlinedContext.sections,
      channelContextPath: channelCtx.contextPath,
      openTasksSection,
      actionsReferenceSection,
    });
    opts.log?.info(
      {
        flow: 'defer',
        channelId: channel.id,
        sections: promptSectionEstimates.sections,
        totalChars: promptSectionEstimates.totalChars,
        totalEstTokens: promptSectionEstimates.totalEstTokens,
        actionSchemaSelection,
      },
      'defer:prompt:section-estimates',
    );

    const noteLines: string[] = [];
    let effectiveTools = opts.runtimeTools;
    try {
      const toolsInfo = await resolveEffectiveTools({
        workspaceCwd: opts.workspaceCwd,
        runtimeTools: opts.runtimeTools,
        runtimeCapabilities: opts.runtime.capabilities,
        runtimeId: opts.runtime.id,
        log: opts.log,
      });
      effectiveTools = toolsInfo.effectiveTools;
      if (toolsInfo.permissionNote) noteLines.push(`Permission note: ${toolsInfo.permissionNote}`);
      if (toolsInfo.runtimeCapabilityNote) noteLines.push(`Runtime capability note: ${toolsInfo.runtimeCapabilityNote}`);
    } catch (err) {
      opts.log?.warn({ flow: 'defer', channelId: channel.id, err }, 'defer:resolve effective tools failed');
    }

    const prompt = buildScheduledSelfInvocationPrompt({
      inlinedContext: inlinedContext.text,
      openTasksSection,
      actionsReferenceSection,
      noteLines,
      invocationNotice: `Deferred follow-up scheduled for <#${channel.id}> (runs at ${fmtTime(run.runsAt)}).`,
      userMessage: action.prompt,
    });

    const addDirs: string[] = [];
    if (opts.useGroupDirCwd) addDirs.push(opts.workspaceCwd);
    if (opts.discordChannelContext) addDirs.push(opts.discordChannelContext.contentDir);
    const uniqueAddDirs = addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined;

    const t0 = Date.now();
    globalMetrics.recordInvokeStart('defer');
    opts.log?.info({ flow: 'defer', channelId: channel.id }, 'obs.invoke.start');
    let finalText = '';
    let deltaText = '';
    let runtimeError: string | undefined;
    let invokeResultRecorded = false;
    try {
      for await (const evt of opts.runtime.invoke({
        prompt,
        model: resolveModel(opts.state.runtimeModel, opts.runtime.id),
        cwd: opts.workspaceCwd,
        addDirs: uniqueAddDirs,
        tools: effectiveTools,
        timeoutMs: opts.runtimeTimeoutMs,
      })) {
        if (evt.type === 'text_final') {
          finalText = evt.text;
        } else if (evt.type === 'text_delta') {
          deltaText += evt.text;
        } else if (evt.type === 'error') {
          runtimeError = evt.message;
          finalText = mapRuntimeErrorToUserMessage(evt.message);
          globalMetrics.recordInvokeResult('defer', Date.now() - t0, false, evt.message);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          opts.status?.runtimeError({ sessionKey: `defer:${channel.id}` }, evt.message);
          opts.log?.warn({ flow: 'defer', channelId: channel.id, error: evt.message }, 'obs.invoke.error');
          invokeResultRecorded = true;
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtimeError ??= msg;
      finalText = mapRuntimeErrorToUserMessage(msg);
      if (!invokeResultRecorded) {
        globalMetrics.recordInvokeResult('defer', Date.now() - t0, false, msg);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        opts.status?.runtimeError({ sessionKey: `defer:${channel.id}` }, msg);
        invokeResultRecorded = true;
      }
      opts.log?.warn({ flow: 'defer', channelId: channel.id, err }, 'defer:runtime invocation failed');
    }
    if (!invokeResultRecorded) {
      globalMetrics.recordInvokeResult('defer', Date.now() - t0, true);
      opts.log?.info({ flow: 'defer', channelId: channel.id, ms: Date.now() - t0, ok: true }, 'obs.invoke.end');
    }

    const processedText = finalText || deltaText || '';
    const parsed = parseDiscordActions(processedText, deferredActionFlags);
    const actCtx: ActionContext = {
      guild,
      client: context.client,
      channelId: channel.id,
      messageId: `defer-${Date.now()}`,
      requesterId: context.requesterId,
      threadParentId,
      deferScheduler: context.deferScheduler,
      deferDepth,
      transport: new DiscordTransportClient(guild, context.client),
      confirmation: {
        mode: 'automated',
      },
    };

    let actionResults: DiscordActionResult[] = [];
    if (parsed.actions.length > 0) {
      actionResults = await executeDiscordActions(parsed.actions, actCtx, opts.log, {
        taskCtx: opts.state.taskCtx,
        cronCtx: opts.state.cronCtx,
        forgeCtx: opts.state.forgeCtx,
        planCtx: opts.state.planCtx,
        memoryCtx: opts.state.memoryCtx,
        configCtx: opts.state.configCtx,
        imagegenCtx: opts.state.imagegenCtx,
        voiceCtx: opts.state.voiceCtx,
        spawnCtx: opts.state.spawnCtx,
      });
      for (let i = 0; i < actionResults.length; i++) {
        const result = actionResults[i];
        globalMetrics.recordActionResult(result.ok);
        opts.log?.info({ flow: 'defer', channelId: channel.id, ok: result.ok }, 'obs.action.result');
        if (!result.ok) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          opts.status?.actionFailed(parsed.actions[i].type, result.error);
        }
      }
    }

    let outgoingText = appendActionResults(parsed.cleanText.trim(), parsed.actions, actionResults);
    outgoingText = appendUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
    outgoingText = appendParseFailureNotice(outgoingText, parsed.parseFailures).trim();
    if (!outgoingText && runtimeError) {
      outgoingText = runtimeError;
    }

    if (!outgoingText) {
      opts.log?.warn({ flow: 'defer', channelId: channel.id }, 'defer:empty output, nothing to send');
      return;
    }
    try {
      await channel.send({ content: outgoingText, allowedMentions: NO_MENTIONS });
    } catch (err) {
      opts.log?.warn({ flow: 'defer', channelId: channel.id, err }, 'defer:failed to post follow-up');
    }
  };

  const deferScheduler = new DeferSchedulerImpl({
    maxDelaySeconds: opts.maxDelaySeconds,
    maxConcurrent: opts.maxConcurrent,
    jobHandler: handleDeferredRun,
  });
  opts.log?.info(
    { maxDelaySeconds: opts.maxDelaySeconds, maxConcurrent: opts.maxConcurrent },
    'defer:scheduler configured',
  );
  return deferScheduler;
}
