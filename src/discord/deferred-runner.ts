import type { ActionContext, ActionCategoryFlags, DiscordActionResult } from './actions.js';
import { buildDisplayResultLines, discordActionsPromptSection, executeDiscordActions, parseDiscordActions } from './actions.js';
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
import type { TaskContext } from '../tasks/task-context.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { appendUnavailableActionTypesNotice, appendParseFailureNotice } from './output-common.js';
import {
  buildContextFiles,
  buildPromptPreamble,
  inlineContextFiles,
  loadWorkspacePaFiles,
  resolveEffectiveTools,
} from './prompt-common.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { globalMetrics } from '../observability/metrics.js';
import type { StatusPoster } from './status-channel.js';

type ThreadChannelShape = {
  isThread?: () => boolean;
  parentId?: unknown;
};

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
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
  imagegenCtx?: ImagegenContext;
  voiceCtx?: VoiceContext;
};

export type ConfigureDeferredSchedulerOpts = {
  maxDelaySeconds: number;
  maxConcurrent: number;
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

function buildDeferredActionFlags(state: DeferredRunnerState): ActionCategoryFlags {
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
    defer: false,
    imagegen: Boolean(state.discordActionsImagegen),
    voice: Boolean(state.discordActionsVoice),
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
      return;
    }

    const channel = resolveChannel(guild, action.channel);
    if (!channel) {
      opts.log?.warn({ flow: 'defer', run, channel: action.channel }, 'defer:target channel not found');
      return;
    }

    if (opts.state.allowChannelIds?.size) {
      const parentId = getThreadParentId(channel) ?? '';
      const allowed =
        opts.state.allowChannelIds.has(channel.id) ||
        (parentId && opts.state.allowChannelIds.has(parentId));
      if (!allowed) {
        opts.log?.warn({ flow: 'defer', channelId: channel.id }, 'defer:target channel not allowlisted');
        return;
      }
    }

    const threadParentId = getThreadParentId(channel);
    const channelCtx = resolveDiscordChannelContext({
      ctx: opts.discordChannelContext,
      isDm: false,
      channelId: channel.id,
      threadParentId,
    });

    const paFiles = await loadWorkspacePaFiles(opts.workspaceCwd, { skip: !!opts.appendSystemPrompt });
    const contextFiles = buildContextFiles(paFiles, opts.discordChannelContext, channelCtx.contextPath);
    let inlinedContext = '';
    if (contextFiles.length > 0) {
      try {
        inlinedContext = await inlineContextFiles(contextFiles, {
          required: new Set(opts.discordChannelContext?.paContextFiles ?? []),
        });
      } catch (err) {
        opts.log?.warn({ flow: 'defer', channelId: channel.id, err }, 'defer:context inline failed');
      }
    }

    const deferredActionFlags = buildDeferredActionFlags(opts.state);
    let prompt =
      buildPromptPreamble(inlinedContext) + '\n\n' +
      `---\nDeferred follow-up scheduled for <#${channel.id}> (runs at ${fmtTime(run.runsAt)}).\n---\n` +
      `User message:\n${action.prompt}`;

    if (opts.state.discordActionsEnabled) {
      prompt += '\n\n---\n' + discordActionsPromptSection(deferredActionFlags, opts.botDisplayName);
    }

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

    if (noteLines.length > 0) {
      prompt += `\n\n---\n${noteLines.join('\n')}\n`;
    }

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
      threadParentId,
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

    const displayLines = buildDisplayResultLines(parsed.actions, actionResults);
    let outgoingText = parsed.cleanText.trim();
    if (displayLines.length > 0) {
      outgoingText = outgoingText ? `${outgoingText}\n\n${displayLines.join('\n')}` : displayLines.join('\n');
    }
    outgoingText = appendUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
    outgoingText = appendParseFailureNotice(outgoingText, parsed.parseFailures).trim();
    if (!outgoingText && runtimeError) {
      outgoingText = runtimeError;
    }

    if (!outgoingText) return;
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
