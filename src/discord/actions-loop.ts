import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildMember, GuildTextBasedChannel } from 'discord.js';
import type {
  ActionCategoryFlags,
  ActionContext,
  DiscordActionRequest,
  DiscordActionResult,
  RequesterMemberContext,
  SubsystemContexts,
} from './actions.js';
import { fmtTime, resolveChannel } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { DiscordTransportClient } from './transport-client.js';
import { resolveDiscordChannelContext } from './channel-context.js';
import type { DiscordChannelContext } from './channel-context.js';
import { appendParseFailureNotice, buildUnavailableActionTypesNotice } from './output-common.js';
import {
  buildContextFiles,
  buildOpenTasksSection,
  buildScheduledSelfInvocationPrompt,
  buildPromptSectionEstimates,
  inlineContextFilesWithMeta,
  loadWorkspacePaFiles,
  resolveEffectiveTools,
} from './prompt-common.js';
import type { InlinedContextSection } from './prompt-common.js';
import {
  LoopScheduler as LoopSchedulerImpl,
  type LoopJobInfo as ScheduledLoopJobInfo,
  type LoopSchedulerRun,
} from './defer-scheduler.js';
import type { CronContext } from './actions-crons.js';
import type { ForgeContext } from './actions-forge.js';
import type { PlanContext } from './actions-plan.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import type { StatusPoster } from './status-channel.js';
import { IMAGEGEN_ACTION_TYPES } from './actions-imagegen.js';
import { appendOutsideFence } from './output-utils.js';

export type LoopCreateActionRequest = {
  type: 'loopCreate';
  channel: string;
  prompt: string;
  intervalSeconds: number;
  label?: string;
};

export type LoopListActionRequest = {
  type: 'loopList';
};

export type LoopCancelActionRequest = {
  type: 'loopCancel';
  id: number;
};

export type LoopActionRequest =
  | LoopCreateActionRequest
  | LoopListActionRequest
  | LoopCancelActionRequest;

export const LOOP_ACTION_TYPES = new Set<string>(['loopCreate', 'loopList', 'loopCancel']);

export const LOOP_TICK_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'readMessages',
  'fetchMessage',
  'listPins',
  'channelInfo',
  'threadListArchived',
  'taskList',
  'taskShow',
  'cronList',
  'cronShow',
  'forgeStatus',
  'planList',
  'planShow',
  'loopList',
]);

export function buildLoopTickActionFlags(): ActionCategoryFlags {
  return {
    channels: true,
    messaging: true,
    guild: false,
    moderation: false,
    polls: false,
    tasks: true,
    crons: true,
    botProfile: false,
    forge: true,
    plan: true,
    memory: false,
    defer: false,
    loop: true,
    config: false,
    imagegen: false,
    voice: false,
    spawn: false,
  };
}

type LoopPromptSelection = {
  prompt: string;
  includedCategories: string[];
  tierBuckets: { core: string[]; channelContextual: string[]; keywordTriggered: string[] };
  keywordHits: string[];
};

type LoopParsedActionsResult = {
  cleanText: string;
  actions: DiscordActionRequest[];
  strippedUnrecognizedTypes: string[];
  parseFailures: number;
};

type LoopActionsApi = {
  parseDiscordActions: (
    text: string,
    flags: ActionCategoryFlags,
    allowedActionTypes?: Iterable<string>,
  ) => LoopParsedActionsResult;
  executeDiscordActions: (
    actions: DiscordActionRequest[],
    ctx: ActionContext,
    log?: LoggerLike,
    subs?: SubsystemContexts,
  ) => Promise<DiscordActionResult[]>;
  buildTieredDiscordActionsPromptSection: (
    flags: ActionCategoryFlags,
    botDisplayName?: string,
    opts?: {
      channelName?: string;
      channelContextPath?: string | null;
      isThread?: boolean;
      userText?: string;
    },
  ) => LoopPromptSelection;
  appendActionResults: (
    body: string,
    actions: { type: string }[],
    results: DiscordActionResult[],
  ) => string;
};

export type LoopRunnerState = {
  allowChannelIds?: Set<string>;
  runtimeModel: string;
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
};

export type ConfigureLoopSchedulerOpts = {
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  maxConcurrent: number;
  state: LoopRunnerState;
  runtime: RuntimeAdapter;
  runtimeTools: string[];
  runtimeTimeoutMs: number;
  workspaceCwd: string;
  discordChannelContext?: DiscordChannelContext;
  appendSystemPrompt?: string;
  useGroupDirCwd: boolean;
  botDisplayName: string;
  actionsApi: LoopActionsApi;
  log?: LoggerLike;
  status?: StatusPoster | null;
};

type LoopOriginMeta = {
  originChannelId: string;
  originThreadId: string | null;
};

type ThreadChannelShape = {
  isThread?: () => boolean;
  parentId?: unknown;
};

type ConfiguredLoopScheduler = LoopSchedulerImpl<LoopCreateActionRequest, ActionContext, LoopOriginMeta>;
type LoopJobInfo = ScheduledLoopJobInfo<LoopCreateActionRequest, LoopOriginMeta>;
type LoopTickRun = LoopSchedulerRun<LoopCreateActionRequest, ActionContext, LoopOriginMeta>;

class LoopTerminalError extends Error {
  readonly code: 'channel-not-found' | 'guild-not-found';

  constructor(code: 'channel-not-found' | 'guild-not-found', message: string) {
    super(message);
    this.code = code;
  }
}

let configuredLoopScheduler: ConfiguredLoopScheduler | null = null;
let configuredLoopState: LoopRunnerState | null = null;

const REQUESTER_DENY_ALL = { __requesterDenyAll: true } as const;

type TextChannelLike = GuildTextBasedChannel & {
  send: (opts: { content: string; allowedMentions: unknown }) => Promise<unknown>;
};

function formatDuration(seconds: number): string {
  const parts: string[] = [];
  let remaining = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(remaining / 3600);
  if (hours > 0) {
    parts.push(`${hours}h`);
    remaining -= hours * 3600;
  }
  const minutes = Math.floor(remaining / 60);
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remaining -= minutes * 60;
  }
  if (remaining > 0 || parts.length === 0) {
    parts.push(`${remaining}s`);
  }
  return parts.join(' ');
}

function buildLoopCreateRejection(channel: string, reason: string): string {
  const target = channel || 'requested channel';
  return `Loop for ${target} rejected: ${reason}`;
}

function configuredConcurrentCapLabel(): string {
  return configuredLoopScheduler ? String(configuredLoopScheduler.concurrentCap) : 'the configured';
}

function buildLoopActionSummaryPrefix(label: string): string {
  return label ? `Loop "${label}"` : 'Loop';
}

function formatLoopOrigin(meta: LoopOriginMeta): string {
  if (meta.originThreadId) {
    return `thread:${meta.originThreadId} (channel:${meta.originChannelId})`;
  }
  return `channel:${meta.originChannelId}`;
}

function buildLoopActionsReferenceSection(
  selection: LoopPromptSelection,
): string {
  if (selection.includedCategories.includes('loop')) return selection.prompt;
  return `${selection.prompt}\n\n${loopActionsPromptSection()}`;
}

function buildLoopUnavailableActionTypesNotice(strippedTypes: string[]): string {
  const passthroughTypes: string[] = [];
  const loopUnsupportedTypes: string[] = [];

  for (const rawType of strippedTypes) {
    const type = rawType.trim();
    if (!type) continue;
    if (IMAGEGEN_ACTION_TYPES.has(type)) {
      loopUnsupportedTypes.push(type);
    } else {
      passthroughTypes.push(type);
    }
  }

  const parts: string[] = [];
  const passthroughNotice = buildUnavailableActionTypesNotice(passthroughTypes);
  if (passthroughNotice) parts.push(passthroughNotice);

  const uniqueLoopUnsupportedTypes = Array.from(new Set(loopUnsupportedTypes));
  if (uniqueLoopUnsupportedTypes.length > 0) {
    const rendered = uniqueLoopUnsupportedTypes.map((type) => `\`${type}\``).join(', ');
    const noun = uniqueLoopUnsupportedTypes.length === 1 ? 'type' : 'types';
    parts.push(
      `Ignored unavailable action ${noun}: ${rendered} (image generation is not available during loop ticks).`,
    );
  }

  return parts.join('\n');
}

function appendLoopUnavailableActionTypesNotice(text: string, strippedTypes: string[]): string {
  const notice = buildLoopUnavailableActionTypesNotice(strippedTypes);
  return appendOutsideFence(String(text ?? '').trimEnd(), notice);
}

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

function ensureLoopTextChannel(
  guild: ActionContext['guild'],
  ref: string,
): TextChannelLike {
  const channel = resolveChannel(guild, ref) as TextChannelLike | undefined;
  if (!channel) {
    throw new LoopTerminalError('channel-not-found', `loop target channel "${ref}" not found`);
  }
  return channel;
}

function ensureLoopAllowlisted(
  channel: TextChannelLike,
  allowChannelIds?: Set<string>,
): string | null {
  const threadParentId = getThreadParentId(channel);
  if (!allowChannelIds?.size) return threadParentId;
  const allowed =
    allowChannelIds.has(channel.id) ||
    (threadParentId !== null && allowChannelIds.has(threadParentId));
  if (!allowed) {
    throw new Error(`loop target channel ${channel.id} not in allowlist`);
  }
  return threadParentId;
}

async function ensureLoopRequesterAccess(
  context: ActionContext,
  channel: TextChannelLike,
): Promise<void> {
  const requesterMember = await resolveRequesterMember(context);
  if (
    isRequesterDenyAll(requesterMember)
    || (requesterMember && !requesterCanAccessTargetChannel(channel, requesterMember))
  ) {
    throw new Error(`loop requester lacks permission for channel ${channel.id}`);
  }
}

async function buildLoopPrompt(
  opts: ConfigureLoopSchedulerOpts,
  channel: TextChannelLike,
  action: LoopCreateActionRequest,
): Promise<string> {
  const threadParentId = getThreadParentId(channel);
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
      opts.log?.warn({ flow: 'loop', channelId: channel.id, err }, 'loop:context inline failed');
    }
  }

  const openTasksSection = buildOpenTasksSection(opts.state.taskCtx?.store);
  const loopFlags = buildLoopTickActionFlags();
  const actionSelection = opts.actionsApi.buildTieredDiscordActionsPromptSection(
    loopFlags,
    opts.botDisplayName,
    {
      channelName: channelCtx.channelName,
      channelContextPath: channelCtx.contextPath,
      isThread: threadParentId !== null,
      userText: action.prompt,
    },
  );
  const actionsReferenceSection = buildLoopActionsReferenceSection(actionSelection);

  const promptSectionEstimates = buildPromptSectionEstimates({
    contextSections: inlinedContext.sections,
    channelContextPath: channelCtx.contextPath,
    openTasksSection,
    actionsReferenceSection,
  });
  opts.log?.info(
    {
      flow: 'loop',
      channelId: channel.id,
      sections: promptSectionEstimates.sections,
      totalChars: promptSectionEstimates.totalChars,
      totalEstTokens: promptSectionEstimates.totalEstTokens,
      actionSchemaSelection: {
        includedCategories: actionSelection.includedCategories,
        tierBuckets: actionSelection.tierBuckets,
        keywordHits: actionSelection.keywordHits,
      },
    },
    'loop:prompt:section-estimates',
  );

  const noteLines: string[] = [];
  try {
    const toolsInfo = await resolveEffectiveTools({
      workspaceCwd: opts.workspaceCwd,
      runtimeTools: opts.runtimeTools,
      runtimeCapabilities: opts.runtime.capabilities,
      runtimeId: opts.runtime.id,
      log: opts.log,
    });
    if (toolsInfo.permissionNote) noteLines.push(`Permission note: ${toolsInfo.permissionNote}`);
    if (toolsInfo.runtimeCapabilityNote) noteLines.push(`Runtime capability note: ${toolsInfo.runtimeCapabilityNote}`);
  } catch (err) {
    opts.log?.warn({ flow: 'loop', channelId: channel.id, err }, 'loop:resolve effective tools failed');
  }

  return buildScheduledSelfInvocationPrompt({
    inlinedContext: inlinedContext.text,
    openTasksSection,
    actionsReferenceSection,
    noteLines,
    invocationNotice:
      `Repeating loop tick for <#${channel.id}>.\n` +
      'Loop prompts are isolated: there is no conversation history.',
    userMessage: action.prompt,
  });
}

async function handleLoopTick(
  opts: ConfigureLoopSchedulerOpts,
  run: LoopTickRun,
): Promise<void> {
  const { action, context } = run;
  const guild = context.guild;
  if (!guild) {
    throw new LoopTerminalError('guild-not-found', 'loop guild context missing');
  }

  const channel = ensureLoopTextChannel(guild, action.channel);
  const threadParentId = ensureLoopAllowlisted(channel, opts.state.allowChannelIds);
  await ensureLoopRequesterAccess(context, channel);

  const prompt = await buildLoopPrompt(opts, channel, action);
  const addDirs: string[] = [];
  if (opts.useGroupDirCwd) addDirs.push(opts.workspaceCwd);
  if (opts.discordChannelContext) addDirs.push(opts.discordChannelContext.contentDir);
  const uniqueAddDirs = addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined;

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
  } catch {
    // buildLoopPrompt already logged a best-effort warning.
  }

  let finalText = '';
  let deltaText = '';
  let runtimeError: string | undefined;
  try {
    for await (const evt of opts.runtime.invoke({
      prompt,
      systemPrompt: opts.appendSystemPrompt,
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
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtimeError = msg;
    finalText = mapRuntimeErrorToUserMessage(msg);
    opts.log?.warn({ flow: 'loop', channelId: channel.id, err }, 'loop:runtime invocation failed');
  }

  const processedText = finalText || deltaText || '';
  const parsed = opts.actionsApi.parseDiscordActions(
    processedText,
    buildLoopTickActionFlags(),
    LOOP_TICK_ALLOWED_ACTIONS,
  );

  const actCtx: ActionContext = {
    guild,
    client: context.client,
    channelId: channel.id,
    messageId: `loop-${run.id}-${Date.now()}`,
    requesterId: context.requesterId,
    threadParentId,
    transport: new DiscordTransportClient(guild, context.client),
    confirmation: {
      mode: 'automated',
    },
  };

  let actionResults: DiscordActionResult[] = [];
  if (parsed.actions.length > 0) {
    actionResults = await opts.actionsApi.executeDiscordActions(parsed.actions, actCtx, opts.log, {
      taskCtx: opts.state.taskCtx,
      cronCtx: opts.state.cronCtx,
      forgeCtx: opts.state.forgeCtx,
      planCtx: opts.state.planCtx,
    });
  }

  let outgoingText = opts.actionsApi.appendActionResults(parsed.cleanText.trim(), parsed.actions, actionResults);
  outgoingText = appendLoopUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
  outgoingText = appendParseFailureNotice(outgoingText, parsed.parseFailures).trim();
  if (!outgoingText && runtimeError) {
    outgoingText = runtimeError;
  }

  if (!outgoingText) return;
  await channel.send({ content: outgoingText, allowedMentions: NO_MENTIONS });
}

export function configureLoopScheduler(opts: ConfigureLoopSchedulerOpts): ConfiguredLoopScheduler {
  configuredLoopScheduler?.cancelAll();
  configuredLoopState = opts.state;
  configuredLoopScheduler = new LoopSchedulerImpl({
    minIntervalSeconds: opts.minIntervalSeconds,
    maxIntervalSeconds: opts.maxIntervalSeconds,
    maxConcurrent: opts.maxConcurrent,
    maxConsecutiveFailures: 3,
    isTerminalError: (err) => err instanceof LoopTerminalError,
    tickHandler: (run) => handleLoopTick(opts, run),
    log: opts.log as LoggerLike | undefined,
  });
  opts.log?.info(
    {
      minIntervalSeconds: opts.minIntervalSeconds,
      maxIntervalSeconds: opts.maxIntervalSeconds,
      maxConcurrent: opts.maxConcurrent,
    },
    'loop:scheduler configured',
  );
  return configuredLoopScheduler;
}

export function hasConfiguredLoopScheduler(): boolean {
  return configuredLoopScheduler !== null;
}

export async function executeLoopAction(
  action: LoopActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const scheduler = configuredLoopScheduler;
  const state = configuredLoopState;
  if (!scheduler || !state) {
    return { ok: false, error: 'Loop actions are not configured for this bot' };
  }

  switch (action.type) {
    case 'loopCreate': {
      const channel = action.channel?.trim();
      if (!channel) {
        return { ok: false, error: 'Loop actions require a target channel' };
      }
      const prompt = action.prompt?.trim();
      if (!prompt) {
        return { ok: false, error: 'Loop actions require a prompt to re-run' };
      }
      const label = action.label?.trim() ?? '';
      let resolvedChannel: TextChannelLike;
      try {
        resolvedChannel = ensureLoopTextChannel(ctx.guild, channel);
        ensureLoopAllowlisted(resolvedChannel, state.allowChannelIds);
        await ensureLoopRequesterAccess(ctx, resolvedChannel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: buildLoopCreateRejection(channel, msg) };
      }
      const normalized: LoopCreateActionRequest = {
        ...action,
        channel,
        prompt,
        label,
        intervalSeconds: action.intervalSeconds,
      };
      const result = scheduler.create({
        action: normalized,
        context: ctx,
        meta: {
          originChannelId: ctx.threadParentId ?? ctx.channelId,
          originThreadId: ctx.threadParentId ? ctx.channelId : null,
        },
      });
      if (!result.ok) {
        return { ok: false, error: buildLoopCreateRejection(channel, result.error) };
      }
      return {
        ok: true,
        summary:
          `${buildLoopActionSummaryPrefix(label)} scheduled for ${channel} every ${formatDuration(result.job.action.intervalSeconds)} ` +
          `(id=${result.job.id}, next run ${fmtTime(result.job.nextRunAt)})`,
      };
    }
    case 'loopList': {
      const active = scheduler.list();
      if (active.length === 0) {
        return { ok: true, summary: 'No active loops.' };
      }
      const lines = active.map((job, index) => {
        const remainingSec = Math.max(0, Math.floor((job.nextRunAt.getTime() - Date.now()) / 1000));
        return `${index + 1}. id=${job.id} | label=${job.action.label || '-'} | channel=${job.action.channel} | every=${formatDuration(job.action.intervalSeconds)} | nextRunAt=${fmtTime(job.nextRunAt)} | remaining=${formatDuration(remainingSec)} | origin=${formatLoopOrigin(job.meta)} | failures=${job.consecutiveFailures} | prompt="${job.action.prompt}"`;
      });
      return { ok: true, summary: `Active loops (${active.length}):\n${lines.join('\n')}` };
    }
    case 'loopCancel': {
      if (!Number.isInteger(action.id) || action.id <= 0) {
        return { ok: false, error: 'loopCancel requires a positive numeric id' };
      }
      if (!scheduler.cancel(action.id)) {
        return { ok: false, error: `Loop ${action.id} was not found` };
      }
      return { ok: true, summary: `Loop ${action.id} canceled` };
    }
  }
}

export function loopActionsPromptSection(): string {
  const cap = configuredConcurrentCapLabel();
  return `### Repeating loops
Use <discord-action>{"type":"loopCreate","channel":"general","intervalSeconds":900,"prompt":"Check the forge status for forge-123 and report changes","label":"forge-watch"}</discord-action> to schedule a repeating self-invocation. Prefer this for recurring checks instead of chaining \`defer\` actions together. The scheduler enforces a maximum of ${cap} concurrent active loops. Every loop is inspectable via \`loopList\`, including its interval, next run time, origin channel/thread, purpose label, and failure state.

Use <discord-action>{"type":"loopList"}</discord-action> to inspect active loops and <discord-action>{"type":"loopCancel","id":123}</discord-action> to stop one. Each loop tick runs with no conversation history, so the \`prompt\` must be fully self-contained.`;
}
