import type { GuildTextBasedChannel } from 'discord.js';
import type { ActionCategoryFlags, ActionContext, DiscordActionRequest, DiscordActionResult, SubsystemContexts } from './actions.js';
import { fmtTime, resolveChannel } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { DiscordTransportClient } from './transport-client.js';
import { resolveDiscordChannelContext } from './channel-context.js';
import type { DiscordChannelContext } from './channel-context.js';
import { appendParseFailureNotice, appendUnavailableActionTypesNotice } from './output-common.js';
import {
  buildContextFiles,
  buildOpenTasksSection,
  buildPromptPreamble,
  buildPromptSectionEstimates,
  inlineContextFilesWithMeta,
  loadWorkspacePaFiles,
  resolveEffectiveTools,
} from './prompt-common.js';
import type { InlinedContextSection } from './prompt-common.js';
import type { CronContext } from './actions-crons.js';
import type { ForgeContext } from './actions-forge.js';
import type { PlanContext } from './actions-plan.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { resolveModel } from '../runtime/model-tiers.js';
import type { StatusPoster } from './status-channel.js';

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

export type LoopJob = {
  id: number;
  label: string;
  intervalSeconds: number;
  prompt: string;
  channel: string;
  originChannelId: string;
  createdAt: Date;
  nextRunAt: Date;
  running: boolean;
  consecutiveFailures: number;
  timer: ReturnType<typeof setInterval>;
};

export type LoopJobInfo = Omit<LoopJob, 'timer'>;

type LoopCreateResult =
  | { ok: true; job: LoopJobInfo }
  | { ok: false; error: string };

type LoopTickContext = {
  action: LoopCreateActionRequest;
  context: ActionContext;
};

type LoopSchedulerOptions = {
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  maxConcurrent: number;
  tickHandler: (job: LoopJobInfo, tickContext: LoopTickContext) => Promise<void> | void;
  log?: LoggerLike;
};

class LoopTerminalError extends Error {
  readonly code: 'channel-not-found' | 'guild-not-found';

  constructor(code: 'channel-not-found' | 'guild-not-found', message: string) {
    super(message);
    this.code = code;
  }
}

export class LoopScheduler {
  private nextId = 1;
  private readonly activeJobs = new Map<number, LoopJob>();
  private readonly minIntervalSeconds: number;
  private readonly maxIntervalSeconds: number;
  private readonly maxConcurrent: number;
  private readonly tickHandler: LoopSchedulerOptions['tickHandler'];
  private readonly log?: LoggerLike;

  constructor(opts: LoopSchedulerOptions) {
    this.minIntervalSeconds = opts.minIntervalSeconds;
    this.maxIntervalSeconds = opts.maxIntervalSeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.tickHandler = opts.tickHandler;
    this.log = opts.log;
  }

  get concurrentCap(): number {
    return this.maxConcurrent;
  }

  create(action: LoopCreateActionRequest, context: ActionContext): LoopCreateResult {
    const intervalSeconds = action.intervalSeconds;
    if (!Number.isFinite(intervalSeconds)) {
      return { ok: false, error: 'intervalSeconds must be a number' };
    }
    if (intervalSeconds < this.minIntervalSeconds) {
      return {
        ok: false,
        error: `intervalSeconds must be at least ${this.minIntervalSeconds} seconds`,
      };
    }
    if (intervalSeconds > this.maxIntervalSeconds) {
      return {
        ok: false,
        error: `intervalSeconds cannot exceed ${this.maxIntervalSeconds} seconds`,
      };
    }
    if (this.activeJobs.size >= this.maxConcurrent) {
      return {
        ok: false,
        error: `Maximum of ${this.maxConcurrent} loops are already active`,
      };
    }

    const id = this.nextId++;
    const createdAt = new Date();
    const nextRunAt = new Date(createdAt.getTime() + intervalSeconds * 1000);
    const intervalMs = intervalSeconds * 1000;

    const timer = setInterval(() => {
      void this.runTick(id, { action, context });
    }, intervalMs);
    timer.unref?.();

    const job: LoopJob = {
      id,
      label: action.label ?? '',
      intervalSeconds,
      prompt: action.prompt,
      channel: action.channel,
      originChannelId: context.channelId,
      createdAt,
      nextRunAt,
      running: false,
      consecutiveFailures: 0,
      timer,
    };

    this.activeJobs.set(id, job);
    return { ok: true, job: this.snapshot(job) };
  }

  list(): LoopJobInfo[] {
    return [...this.activeJobs.values()]
      .map((job) => this.snapshot(job))
      .sort((a, b) => a.id - b.id);
  }

  cancel(id: number): boolean {
    const job = this.activeJobs.get(id);
    if (!job) return false;
    clearInterval(job.timer);
    this.activeJobs.delete(id);
    return true;
  }

  cancelAll(): number {
    const count = this.activeJobs.size;
    for (const job of this.activeJobs.values()) {
      clearInterval(job.timer);
    }
    this.activeJobs.clear();
    return count;
  }

  private snapshot(job: LoopJob): LoopJobInfo {
    return {
      id: job.id,
      label: job.label,
      intervalSeconds: job.intervalSeconds,
      prompt: job.prompt,
      channel: job.channel,
      originChannelId: job.originChannelId,
      createdAt: new Date(job.createdAt.getTime()),
      nextRunAt: new Date(job.nextRunAt.getTime()),
      running: job.running,
      consecutiveFailures: job.consecutiveFailures,
    };
  }

  private async runTick(id: number, tickContext: LoopTickContext): Promise<void> {
    const job = this.activeJobs.get(id);
    if (!job) return;

    job.nextRunAt = new Date(Date.now() + job.intervalSeconds * 1000);
    if (job.running) {
      this.log?.warn({ loopId: job.id, label: job.label, channel: job.channel }, 'loop:skip (previous tick still active)');
      return;
    }

    job.running = true;
    try {
      await Promise.resolve(this.tickHandler(this.snapshot(job), tickContext));
      const current = this.activeJobs.get(id);
      if (current) current.consecutiveFailures = 0;
    } catch (err) {
      const current = this.activeJobs.get(id);
      if (!current) return;

      if (err instanceof LoopTerminalError) {
        this.log?.warn({ loopId: current.id, code: err.code, err }, 'loop:terminal failure, canceling');
        this.cancel(id);
        return;
      }

      current.consecutiveFailures += 1;
      this.log?.warn(
        { loopId: current.id, failures: current.consecutiveFailures, err },
        'loop:tick failed',
      );
      if (current.consecutiveFailures >= 3) {
        this.log?.warn({ loopId: current.id, failures: current.consecutiveFailures }, 'loop:max failures reached, canceling');
        this.cancel(id);
      }
    } finally {
      const current = this.activeJobs.get(id);
      if (current) current.running = false;
    }
  }
}

let configuredLoopScheduler: LoopScheduler | null = null;

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

function buildLoopActionsReferenceSection(
  selection: LoopPromptSelection,
): string {
  if (selection.includedCategories.includes('loop')) return selection.prompt;
  return `${selection.prompt}\n\n${loopActionsPromptSection()}`;
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

async function buildLoopPrompt(
  opts: ConfigureLoopSchedulerOpts,
  channel: TextChannelLike,
  action: LoopCreateActionRequest,
): Promise<string> {
  const channelCtx = resolveDiscordChannelContext({
    ctx: opts.discordChannelContext,
    isDm: false,
    channelId: channel.id,
    threadParentId: null,
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
      isThread: false,
      userText: action.prompt,
    },
  );
  const actionsReferenceSection = buildLoopActionsReferenceSection(actionSelection);

  let prompt =
    buildPromptPreamble(inlinedContext.text) + '\n\n' +
    (openTasksSection
      ? `---\n${openTasksSection}\n\n`
      : '') +
    `---\n${actionsReferenceSection}\n`;

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

  if (noteLines.length > 0) {
    prompt += `\n---\n${noteLines.join('\n')}\n`;
  }

  prompt +=
    `---\nRepeating loop tick for <#${channel.id}>.\n` +
    `Loop prompts are isolated: there is no conversation history.\n---\n` +
    `User message:\n${action.prompt}`;
  return prompt;
}

async function handleLoopTick(
  opts: ConfigureLoopSchedulerOpts,
  job: LoopJobInfo,
  tickContext: LoopTickContext,
): Promise<void> {
  const { action, context } = tickContext;
  const guild = context.guild;
  if (!guild) {
    throw new LoopTerminalError('guild-not-found', 'loop guild context missing');
  }

  const channel = ensureLoopTextChannel(guild, job.channel);
  if (opts.state.allowChannelIds?.size) {
    const allowed = opts.state.allowChannelIds.has(channel.id);
    if (!allowed) {
      throw new Error(`loop target channel ${channel.id} not in allowlist`);
    }
  }

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
    throw new Error(msg);
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
    messageId: `loop-${job.id}-${Date.now()}`,
    requesterId: context.requesterId,
    threadParentId: null,
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
  outgoingText = appendUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
  outgoingText = appendParseFailureNotice(outgoingText, parsed.parseFailures).trim();
  if (!outgoingText && runtimeError) {
    outgoingText = runtimeError;
  }

  if (!outgoingText) return;
  await channel.send({ content: outgoingText, allowedMentions: NO_MENTIONS });
}

export function configureLoopScheduler(opts: ConfigureLoopSchedulerOpts): LoopScheduler {
  configuredLoopScheduler?.cancelAll();
  configuredLoopScheduler = new LoopScheduler({
    minIntervalSeconds: opts.minIntervalSeconds,
    maxIntervalSeconds: opts.maxIntervalSeconds,
    maxConcurrent: opts.maxConcurrent,
    tickHandler: (job, tickContext) => handleLoopTick(opts, job, tickContext),
    log: opts.log,
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

export async function executeLoopAction(
  action: LoopActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const scheduler = configuredLoopScheduler;
  if (!scheduler) {
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
      const normalized: LoopCreateActionRequest = {
        ...action,
        channel,
        prompt,
        label,
        intervalSeconds: action.intervalSeconds,
      };
      const result = scheduler.create(normalized, ctx);
      if (!result.ok) {
        return { ok: false, error: buildLoopCreateRejection(channel, result.error) };
      }
      return {
        ok: true,
        summary:
          `${buildLoopActionSummaryPrefix(label)} scheduled for ${channel} every ${formatDuration(result.job.intervalSeconds)} ` +
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
        return `${index + 1}. id=${job.id} | label=${job.label || '-'} | channel=${job.channel} | every=${formatDuration(job.intervalSeconds)} | nextRunAt=${fmtTime(job.nextRunAt)} | remaining=${formatDuration(remainingSec)} | origin=${job.originChannelId} | failures=${job.consecutiveFailures} | prompt="${job.prompt}"`;
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
Use <discord-action>{"type":"loopCreate","channel":"general","intervalSeconds":900,"prompt":"Check the forge status for forge-123 and report changes","label":"forge-watch"}</discord-action> to schedule a repeating self-invocation. The scheduler enforces a maximum of ${cap} concurrent active loops. Every loop is inspectable via \`loopList\`, including its interval, next run time, origin channel/thread, purpose label, and failure state.

Use <discord-action>{"type":"loopList"}</discord-action> to inspect active loops and <discord-action>{"type":"loopCancel","id":123}</discord-action> to stop one. Each loop tick runs with no conversation history, so the \`prompt\` must be fully self-contained.`;
}
