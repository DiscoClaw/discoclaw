import fs from 'node:fs/promises';
import path from 'node:path';
import type { Guild } from 'discord.js';
import type { RuntimeAdapter, ImageData } from '../runtime/types.js';
import { MAX_IMAGES_PER_INVOCATION } from '../runtime/types.js';
import type { SessionManager } from '../sessions.js';
import { isAllowlisted } from './allowlist.js';
import { KeyedQueue } from '../group-queue.js';
import type { DiscordChannelContext } from './channel-context.js';
import { ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './channel-context.js';
import { discordSessionKey } from './session-key.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection, buildDisplayResultLines, buildAllResultLines } from './actions.js';
import type { ActionCategoryFlags, ActionContext, DiscordActionResult } from './actions.js';
import type { DeferScheduler } from './defer-scheduler.js';
import type { DeferActionRequest } from './actions-defer.js';
import { hasQueryAction, QUERY_ACTION_TYPES } from './action-categories.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { CronContext } from './actions-crons.js';
import type { ForgeContext } from './actions-forge.js';
import { executePlanAction } from './actions-plan.js';
import type { PlanContext } from './actions-plan.js';
import type { MemoryContext } from './actions-memory.js';
import type { ConfigContext } from './actions-config.js';
import { autoImplementForgePlan } from './forge-auto-implement.js';
import type { ForgeAutoImplementDeps } from './forge-auto-implement.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { fetchMessageHistory } from './message-history.js';
import { loadSummary, saveSummary, generateSummary } from './summarizer.js';
import { parseMemoryCommand, handleMemoryCommand } from './memory-commands.js';
import { parsePlanCommand, handlePlanCommand, preparePlanRun, handlePlanSkip, closePlanIfComplete, NO_PHASES_SENTINEL, findPlanFile, looksLikePlanId } from './plan-commands.js';
import { handlePlanAudit } from './audit-handler.js';
import type { PlanAuditResult } from './audit-handler.js';
import type { PreparePlanRunResult } from './plan-commands.js';
import { parseForgeCommand, ForgeOrchestrator, buildPlanImplementationMessage } from './forge-commands.js';
import type { ForgeOrchestratorOpts, ForgeResult } from './forge-commands.js';
import { runNextPhase, resolveProjectCwd, readPhasesFile, buildPostRunSummary } from './plan-manager.js';
import type { PlanRunEvent } from './plan-manager.js';
import {
  acquireWriterLock as registryAcquireWriterLock,
  setActiveOrchestrator,
  getActiveOrchestrator,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
} from './forge-plan-registry.js';
import { applyUserTurnToDurable } from './user-turn-to-durable.js';
import type { StatusPoster } from './status-channel.js';
import { sanitizeErrorMessage, sanitizePhaseError } from './status-channel.js';
import { ToolAwareQueue } from './tool-aware-queue.js';
import { createStreamingProgress } from './streaming-progress.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { registerInFlightReply, isShuttingDown } from './inflight-replies.js';
import { registerAbort, tryAbortAll } from './abort-registry.js';
import { splitDiscord, truncateCodeBlocks, renderDiscordTail, renderActivityTail, formatBoldLabel, thinkingLabel, selectStreamingOutput, formatElapsed } from './output-utils.js';
import { buildContextFiles, inlineContextFiles, buildDurableMemorySection, buildShortTermMemorySection, buildTaskThreadSection, loadWorkspacePaFiles, loadWorkspaceMemoryFile, loadDailyLogFiles, resolveEffectiveTools } from './prompt-common.js';
import { taskThreadCache } from '../tasks/thread-cache.js';
import { buildTaskContextSummary } from '../tasks/context-summary.js';
import { TaskStore } from '../tasks/store.js';
import { isChannelPublic, appendEntry, buildExcerptSummary } from './shortterm-memory.js';
import { editThenSendChunks, shouldSuppressFollowUp, appendUnavailableActionTypesNotice } from './output-common.js';
import { downloadMessageImages, resolveMediaType } from './image-download.js';
import { resolveReplyReference } from './reply-reference.js';
import { resolveThreadContext } from './thread-context.js';
import { downloadTextAttachments } from './file-download.js';
import { messageContentIntentHint, mapRuntimeErrorToUserMessage } from './user-errors.js';
import { parseHelpCommand, handleHelpCommand } from './help-command.js';
import { parseHealthCommand, renderHealthReport, renderHealthToolsReport } from './health-command.js';
import { parseStatusCommand, collectStatusSnapshot, renderStatusReport } from './status-command.js';
import type { StatusCommandContext } from './status-command.js';
import { parseRestartCommand, handleRestartCommand } from './restart-command.js';
import { parseModelsCommand, handleModelsCommand } from './models-command.js';
import { parseUpdateCommand, handleUpdateCommand } from './update-command.js';
import { consumeDestructiveConfirmation } from './destructive-confirmation.js';
import type { HealthConfigSnapshot } from './health-command.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { globalMetrics } from '../observability/metrics.js';
import { OnboardingFlow } from '../onboarding/onboarding-flow.js';
import { completeOnboarding } from './onboarding-completion.js';
import type { SendTarget } from './onboarding-completion.js';
import { isOnboardingComplete } from '../workspace-bootstrap.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { getDefaultTimezone } from '../cron/default-timezone.js';

// Re-export output-utils symbols for consumers that import them from discord.ts.
export { splitDiscord, truncateCodeBlocks, renderDiscordTail, renderActivityTail, formatBoldLabel, thinkingLabel, selectStreamingOutput, formatElapsed };

export type BotParams = {
  token: string;
  allowUserIds: Set<string>;
  /** Directory for persistent data files (shutdown-context.json, inflight.json, etc.). */
  dataDir?: string;
  /** One-shot startup context injection (consumed on first AI invocation). */
  startupInjection?: string | null;
  // If set and the bot is in multiple guilds, selects the guild used for system bootstrap.
  // If unset and the bot is in exactly one guild, that guild is used.
  guildId?: string;
  botDisplayName: string;
  // If set, restricts non-DM messages to these channel IDs (or thread parent IDs).
  // If unset, all channels are allowed (user allowlist still applies).
  allowChannelIds?: Set<string>;
  log?: LoggerLike;
  discordChannelContext?: DiscordChannelContext;
  requireChannelContext: boolean;
  autoIndexChannelContext: boolean;
  // Best-effort: join threads so the bot can respond inside them.
  // Note: private threads still require the bot to be added to the thread.
  autoJoinThreads: boolean;
  // If false, do not pass `--session-id` to the runtime (useful if session persistence hangs).
  useRuntimeSessions: boolean;
  runtime: RuntimeAdapter;
  sessionManager: SessionManager;
  workspaceCwd: string;
  projectCwd: string;
  groupsDir: string;
  useGroupDirCwd: boolean;
  runtimeModel: string;
  runtimeTools: string[];
  runtimeTimeoutMs: number;
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
  discordActionsMemory?: boolean;
  discordActionsConfig?: boolean;
  discordActionsDefer?: boolean;
  deferMaxDelaySeconds?: number;
  deferMaxConcurrent?: number;
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
  messageHistoryBudget: number;
  summaryEnabled: boolean;
  summaryModel: string;
  summaryMaxChars: number;
  summaryEveryNTurns: number;
  summaryDataDir: string;
  durableMemoryEnabled: boolean;
  durableDataDir: string;
  durableInjectMaxChars: number;
  durableMaxItems: number;
  memoryCommandsEnabled: boolean;
  planCommandsEnabled?: boolean;
  planPhasesEnabled?: boolean;
  planPhaseMaxContextFiles?: number;
  planPhaseTimeoutMs?: number;
  planPhaseMaxAuditFixAttempts?: number;
  forgeCommandsEnabled?: boolean;
  forgeMaxAuditRounds?: number;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  forgeTimeoutMs?: number;
  forgeProgressThrottleMs?: number;
  forgeAutoImplement?: boolean;
  drafterRuntime?: RuntimeAdapter;
  auditorRuntime?: RuntimeAdapter;
  summaryToDurableEnabled: boolean;
  shortTermMemoryEnabled: boolean;
  shortTermDataDir: string;
  shortTermMaxEntries: number;
  shortTermMaxAgeMs: number;
  shortTermInjectMaxChars: number;
  statusChannel?: string;
  bootstrapEnsureTasksForum?: boolean;
  toolAwareStreaming?: boolean;
  streamStallWarningMs: number;
  actionFollowupDepth: number;
  reactionHandlerEnabled: boolean;
  reactionRemoveHandlerEnabled: boolean;
  reactionMaxAgeMs: number;
  healthCommandsEnabled?: boolean;
  healthVerboseAllowlist?: Set<string>;
  healthConfigSnapshot?: HealthConfigSnapshot;
  /** Runtime context for the !status command. Omit to disable the command. */
  statusCommandContext?: StatusCommandContext;
  metrics?: MetricsRegistry;
  botStatus?: 'online' | 'idle' | 'dnd' | 'invisible';
  botActivity?: string;
  botActivityType?: 'Playing' | 'Listening' | 'Watching' | 'Competing' | 'Custom';
  botAvatar?: string;
  appendSystemPrompt?: string;
  existingCronsId?: string;
  existingTasksId?: string;
};

export type QueueLike = Pick<KeyedQueue, 'run'> & { size?: () => number };
export type StatusRef = { current: StatusPoster | null };

const turnCounters = new Map<string, number>();
const summaryWorkQueue = new KeyedQueue();
const latestSummarySequence = new Map<string, number>();

/** Timestamp of the most recent allowlisted message; read by the !status dashboard. */
let lastProcessedMessage: number | null = null;

const acquireWriterLock = registryAcquireWriterLock;
const MAX_PLAN_RUN_PHASES = 50;

type ConversationContextOptions = {
  msg: any;
  params: Omit<BotParams, 'token'>;
  isThread: boolean;
  threadId: string | null;
  threadParentId: string | null;
};

type ConversationContextResult = {
  context?: string;
  pinnedSummary?: string;
  existingTaskId?: string;
};

async function gatherConversationContext(opts: ConversationContextOptions): Promise<ConversationContextResult> {
  const { msg, params, isThread, threadId, threadParentId } = opts;
  const taskCtx = params.taskCtx;

  let existingTaskId: string | undefined;
  if (isThread && threadId && threadParentId && taskCtx) {
    if (threadParentId === taskCtx.forumId) {
      try {
        const task = await taskThreadCache.get(threadId, taskCtx.store);
        if (task) existingTaskId = task.id;
      } catch {
        // best-effort — fall through to create a new task.
      }
    }
  }

  const contextParts: string[] = [];

  const replyRef = await resolveReplyReference(msg, params.botDisplayName, params.log);
  if (replyRef?.section) {
    contextParts.push(`Context (replied-to message):\n${replyRef.section}`);
  }

  const threadCtx = await resolveThreadContext(
    msg.channel as any,
    msg.id,
    { botDisplayName: params.botDisplayName, log: params.log },
  );
  if (threadCtx?.section) {
    contextParts.push(threadCtx.section);
  }

  if (contextParts.length === 0 && params.messageHistoryBudget > 0) {
    try {
      const history = await fetchMessageHistory(
        msg.channel,
        msg.id,
        { budgetChars: params.messageHistoryBudget, botDisplayName: params.botDisplayName },
      );
      if (history) {
        contextParts.push(`Context (recent channel messages):\n${history}`);
      }
    } catch (err) {
      params.log?.warn({ err }, 'discord:context history fallback failed');
    }
  }

  const pinnedSummary = await resolvePinnedMessagesSummary(
    msg.channel,
    params.botDisplayName,
    params.log,
  );

  const context = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;
  return { context, pinnedSummary, existingTaskId };
}

async function resolvePinnedMessagesSummary(
  channel: any,
  botDisplayName?: string,
  log?: LoggerLike,
  maxChars = 600,
): Promise<string | undefined> {
  const fetchPinned = channel?.messages?.fetchPinned;
  if (typeof fetchPinned !== 'function') return undefined;

  try {
    const pinned = await channel.messages.fetchPinned();
    if (!pinned || pinned.size === 0) return undefined;

    const lines: string[] = [];
    let remaining = maxChars;
    const maxMessages = 3;

    for (const pinnedMsg of pinned.values()) {
      if (lines.length >= maxMessages) break;
      let content = String(pinnedMsg.content ?? '').replace(/\s+/g, ' ').trim();
      if (!content) {
        if (pinnedMsg.attachments?.size) {
          content = '[attachment]';
        } else if (Array.isArray(pinnedMsg.embeds) && pinnedMsg.embeds.length > 0) {
          content = '[embed]';
        } else {
          continue;
        }
      }
      if (content.length > 200) {
        content = content.slice(0, 200) + '…';
      }

      const author = pinnedMsg.author?.bot
        ? (botDisplayName ?? 'Discoclaw')
        : (pinnedMsg.author?.displayName || pinnedMsg.author?.username || 'Unknown');
      const line = `[${author}]: ${content} (pinned id:${pinnedMsg.id})`;
      if (remaining - line.length <= 0 && lines.length > 0) break;
      lines.push(line);
      remaining -= line.length + 1;
    }

    if (lines.length === 0) return undefined;

    const header = pinned.size === 1 ? 'Pinned message:' : `Pinned messages (${pinned.size} total):`;
    return [header, ...lines].join('\n');
  } catch (err) {
    log?.warn({ err }, 'discord:context pinned fetch failed');
    return undefined;
  }
}

function parseConfirmToken(text: string): string | null {
  const m = /^!confirm\s+([a-z0-9_-]{6,64})\s*$/i.exec(text.trim());
  return m?.[1] ?? null;
}

export function groupDirNameFromSessionKey(sessionKey: string): string {
  // Keep it filesystem-safe and easy to inspect.
  return sessionKey.replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

export async function ensureGroupDir(groupsDir: string, sessionKey: string, botDisplayName?: string): Promise<string> {
  const name = botDisplayName ?? 'Discoclaw';
  const dir = path.join(groupsDir, groupDirNameFromSessionKey(sessionKey));
  await fs.mkdir(dir, { recursive: true });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  try {
    await fs.stat(claudeMd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    // Minimal per-group instructions, mirroring the nanoclaw style.
    const body =
      `# ${name} Group\n\n` +
      `Session key: \`${sessionKey}\`\n\n` +
      `This directory scopes conversation instructions for this Discord context.\n\n` +
      `Notes:\n` +
      `- The main workspace is mounted separately (see ${name} service env).\n` +
      `- Keep instructions short and specific; prefer referencing files in the workspace.\n`;
    await fs.writeFile(claudeMd, body, 'utf8');
  }
  return dir;
}

export function createMessageCreateHandler(params: Omit<BotParams, 'token'>, queue: QueueLike, statusRef?: StatusRef) {
  // --- Onboarding state ---
  let onboardingSession: OnboardingFlow | null = null;
  let activeOnboardingUserId: string | null = null;
  const sessionCreationGuards = new Map<string, Promise<void>>();
  const ONBOARDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
  let onboardingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let onboardingDisplayName: string | null = null;
  let onboardingCtxRef: { guild: any; client: any; channelId: string; messageId: string; channelName: string } | null = null;

  function destroyOnboardingSession() {
    onboardingSession = null;
    activeOnboardingUserId = null;
    onboardingDisplayName = null;
    onboardingCtxRef = null;
    if (onboardingTimeoutHandle) {
      clearTimeout(onboardingTimeoutHandle);
      onboardingTimeoutHandle = null;
    }
  }

  function resetOnboardingTimeout() {
    if (onboardingTimeoutHandle) clearTimeout(onboardingTimeoutHandle);
    onboardingTimeoutHandle = setTimeout(() => {
      void (async () => {
        const session = onboardingSession;
        const displayName = onboardingDisplayName ?? 'there';
        const ctxRef = onboardingCtxRef;
        try {
          if (!session || !ctxRef) return;
          const values = session.getValuesWithDefaults(displayName, getDefaultTimezone());
          const sendTarget: SendTarget = (ctxRef.client.channels.cache.get(ctxRef.channelId) as any)
            ?? { send: () => Promise.resolve() };
          const cronDispatch = (params.cronCtx && ctxRef.guild) ? {
            cronCtx: params.cronCtx,
            actionCtx: {
              guild: ctxRef.guild,
              client: ctxRef.client,
              channelId: ctxRef.channelId,
              messageId: ctxRef.messageId,
            } as ActionContext,
            log: params.log,
          } : undefined;
          await completeOnboarding(values, params.workspaceCwd, sendTarget, cronDispatch);
          params.log?.info({ workspaceCwd: params.workspaceCwd }, 'onboarding:timeout-defaults:complete');
        } catch (err) {
          params.log?.warn({ err }, 'onboarding:timeout-defaults:write failed');
        } finally {
          destroyOnboardingSession();
        }
      })();
    }, ONBOARDING_TIMEOUT_MS);
  }

  return async (msg: any) => {
    try {
      if (!msg?.author || msg.author.bot) return;

      // Skip system messages (joins, pins, boosts, etc.) — can't reply to them.
      // Default = 0, Reply = 19; everything else is a system message.
      const t = msg.type;
      if (t != null && t !== 0 && t !== 19) return;

      const metrics = params.metrics ?? globalMetrics;
      metrics.increment('discord.message.received');

      if (!isAllowlisted(params.allowUserIds, msg.author.id)) return;

      // Track last allowlisted message timestamp for !status dashboard.
      lastProcessedMessage = Date.now();

      const isDm = msg.guildId == null;
      const actionFlags: ActionCategoryFlags = {
        channels: params.discordActionsChannels,
        messaging: params.discordActionsMessaging,
        guild: params.discordActionsGuild,
        moderation: params.discordActionsModeration,
        polls: params.discordActionsPolls,
        tasks: params.discordActionsTasks ?? false,
        crons: params.discordActionsCrons ?? false,
        botProfile: params.discordActionsBotProfile ?? false,
        forge: params.discordActionsForge ?? false,
        plan: params.discordActionsPlan ?? false,
        memory: params.discordActionsMemory ?? false,
        config: params.discordActionsConfig ?? false,
        defer: !isDm && (params.discordActionsDefer ?? false),
      };

      if (!isDm && params.allowChannelIds) {
        const ch: any = msg.channel as any;
        const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false;
        const parentId = isThread ? String(ch.parentId ?? '') : '';
        const allowed =
          params.allowChannelIds.has(msg.channelId) ||
          (parentId && params.allowChannelIds.has(parentId));
        if (!allowed) return;
      }

      // Heuristic: detect missing Message Content Intent and return actionable guidance.
      // This runs after channel gating so restricted channels remain silent.
      if (
        msg.guildId != null &&
        !msg.content &&
        (!msg.attachments || msg.attachments.size === 0) &&
        (!msg.stickers || msg.stickers.size === 0) &&
        (!msg.embeds || msg.embeds.length === 0) &&
        msg.mentions?.has(msg.client.user)
      ) {
        params.log?.warn(
          { channelId: msg.channelId, authorId: msg.author.id },
          'Received empty message content in guild — is Message Content Intent enabled in the Developer Portal?',
        );
        await msg.reply({ content: messageContentIntentHint(), allowedMentions: NO_MENTIONS });
        return;
      }

      if (parseHelpCommand(String(msg.content ?? ''))) {
        await msg.reply({ content: handleHelpCommand(), allowedMentions: NO_MENTIONS });
        return;
      }

      // Handle !stop — abort all active AI streams and cancel any running forge.
      if (String(msg.content ?? '').trim().toLowerCase() === '!stop') {
        const aborted = tryAbortAll();
        const orch = getActiveOrchestrator();
        const forgeRunning = orch?.isRunning ?? false;
        if (forgeRunning) orch!.requestCancel();
        const parts: string[] = [];
        if (aborted > 0) parts.push(`Aborted ${aborted} active stream${aborted === 1 ? '' : 's'}.`);
        if (forgeRunning) parts.push('Forge cancel requested.');
        if (parts.length === 0) parts.push('Nothing active to stop.');
        await msg.reply({ content: parts.join(' '), allowedMentions: NO_MENTIONS });
        return;
      }

      // Handle !status command — at-a-glance runtime dashboard (live connectivity probes).
      if (parseStatusCommand(String(msg.content ?? '')) && params.statusCommandContext) {
        const ctx = params.statusCommandContext;
        const snapshot = await collectStatusSnapshot({
          startedAt: ctx.startedAt,
          lastMessageAt: lastProcessedMessage,
          scheduler: params.cronCtx?.scheduler ?? null,
          taskStore: params.taskCtx?.store ?? null,
          durableDataDir: params.durableDataDir,
          summaryDataDir: params.summaryDataDir,
          discordToken: ctx.discordToken,
          openaiApiKey: ctx.openaiApiKey,
          openaiBaseUrl: ctx.openaiBaseUrl,
          openrouterApiKey: ctx.openrouterApiKey,
          openrouterBaseUrl: ctx.openrouterBaseUrl,
          paFilePaths: ctx.paFilePaths,
          apiCheckTimeoutMs: ctx.apiCheckTimeoutMs,
          activeProviders: ctx.activeProviders,
        });
        const report = renderStatusReport(snapshot, params.botDisplayName);
        await msg.reply({ content: report, allowedMentions: NO_MENTIONS });
        return;
      }

      const healthMode = (params.healthCommandsEnabled ?? true)
        ? parseHealthCommand(String(msg.content ?? ''))
        : null;
      if (healthMode) {
        if (healthMode === 'tools') {
          const liveTools = await resolveEffectiveTools({
            workspaceCwd: params.workspaceCwd,
            runtimeTools: params.runtimeTools,
            runtimeCapabilities: params.runtime.capabilities,
            runtimeId: params.runtime.id,
            log: params.log,
          });
          const toolsReport = renderHealthToolsReport({
            permissionTier: liveTools.permissionTier,
            effectiveTools: liveTools.effectiveTools,
            configuredRuntimeTools: params.runtimeTools,
            botDisplayName: params.botDisplayName,
          });
          await msg.reply({ content: toolsReport, allowedMentions: NO_MENTIONS });
          return;
        }

        const verboseAllowed = !params.healthVerboseAllowlist
          || params.healthVerboseAllowlist.size === 0
          || params.healthVerboseAllowlist.has(msg.author.id);
        const mode = healthMode === 'verbose' && verboseAllowed ? 'verbose' : 'basic';
        // Fallback: dead code — healthConfigSnapshot is always provided by index.ts.
        // Kept for type safety; task state fields may disagree with actual state.
        const healthConfig: HealthConfigSnapshot = params.healthConfigSnapshot ?? {
          runtimeModel: params.runtimeModel,
          runtimeTimeoutMs: params.runtimeTimeoutMs,
          runtimeTools: params.runtimeTools,
          useRuntimeSessions: params.useRuntimeSessions,
          toolAwareStreaming: Boolean(params.toolAwareStreaming),
          maxConcurrentInvocations: 0,
          discordActionsEnabled: params.discordActionsEnabled,
          summaryEnabled: params.summaryEnabled,
          durableMemoryEnabled: params.durableMemoryEnabled,
          messageHistoryBudget: params.messageHistoryBudget,
          reactionHandlerEnabled: params.reactionHandlerEnabled,
          reactionRemoveHandlerEnabled: params.reactionRemoveHandlerEnabled,
          cronEnabled: Boolean(params.cronCtx),
          tasksEnabled: Boolean(params.taskCtx),
          tasksActive: Boolean(params.taskCtx),
          tasksSyncFailureRetryEnabled: true,
          tasksSyncFailureRetryDelayMs: 30_000,
          tasksSyncDeferredRetryDelayMs: 30_000,
          requireChannelContext: params.requireChannelContext,
          autoIndexChannelContext: params.autoIndexChannelContext,
        };
        const report = renderHealthReport({
          metrics,
          queueDepth: queue.size?.() ?? 0,
          config: healthConfig,
          mode,
          botDisplayName: params.botDisplayName,
        });
        await msg.reply({ content: report, allowedMentions: NO_MENTIONS });
        return;
      }

      // Handle !models commands — fast, synchronous, no queue needed.
      const modelsCmd = parseModelsCommand(String(msg.content ?? ''));
      if (modelsCmd) {
        const response = handleModelsCommand(modelsCmd, {
          configCtx: params.configCtx,
          configEnabled: params.discordActionsEnabled && (params.discordActionsConfig ?? false),
        });
        await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
        return;
      }

      // Handle !restart commands before queue/session — this is a system command.
      const restartCmd = parseRestartCommand(String(msg.content ?? ''));
      if (restartCmd) {
        const result = await handleRestartCommand(restartCmd, {
          log: params.log,
          dataDir: params.dataDir,
          userId: msg.author.id,
          activeForge: getActiveOrchestrator()?.activePlanId,
        });
        await msg.reply({ content: result.reply, allowedMentions: NO_MENTIONS });
        // Deferred action (e.g., restart) runs after the reply is sent.
        // The process will likely die during this call.
        result.deferred?.();
        return;
      }

      // Handle !update commands before queue/session — this is a system command.
      const updateCmd = parseUpdateCommand(String(msg.content ?? ''));
      if (updateCmd) {
        const result = await handleUpdateCommand(updateCmd, {
          log: params.log,
          projectCwd: params.projectCwd,
          dataDir: params.dataDir,
          restartCmd: process.env.DC_RESTART_CMD,
        });
        await msg.reply({ content: result.reply, allowedMentions: NO_MENTIONS });
        // Deferred action (e.g., restart after apply) runs after the reply is sent.
        result.deferred?.();
        return;
      }

      // --- Onboarding intercept ---
      // When onboarding is incomplete, intercept messages before normal bot operation.
      {
        const messageText = String(msg.content ?? '').trim();
        const userId = String(msg.author.id);

        // 1. !cancel during active session → destroy session
        if (messageText === '!cancel' && onboardingSession && activeOnboardingUserId === userId) {
          destroyOnboardingSession();
          await msg.reply({ content: 'Onboarding cancelled. Send me a message whenever you\'re ready to try again.', allowedMentions: NO_MENTIONS });
          return;
        }

        // 2. Active session → check timeout, then forward to flow
        if (onboardingSession && activeOnboardingUserId === userId) {
          // Check timeout
          if (Date.now() - onboardingSession.lastActivityTimestamp > ONBOARDING_TIMEOUT_MS) {
            const session = onboardingSession;
            const displayName = onboardingDisplayName ?? 'there';
            const ctxRef = onboardingCtxRef;
            const channelMode = onboardingSession.channelMode;
            destroyOnboardingSession();
            if (session && ctxRef) {
              const values = session.getValuesWithDefaults(displayName, getDefaultTimezone());
              const sendTarget: SendTarget = channelMode === 'dm' ? msg.author : msg.channel;
              const cronDispatch = (params.cronCtx && ctxRef.guild) ? {
                cronCtx: params.cronCtx,
                actionCtx: {
                  guild: ctxRef.guild,
                  client: ctxRef.client,
                  channelId: ctxRef.channelId,
                  messageId: ctxRef.messageId,
                } as ActionContext,
                log: params.log,
              } : undefined;
              try {
                await completeOnboarding(values, params.workspaceCwd, sendTarget, cronDispatch);
                params.log?.info({ workspaceCwd: params.workspaceCwd }, 'onboarding:restart-timeout-defaults:complete');
              } catch (err) {
                params.log?.warn({ err }, 'onboarding:restart-timeout-defaults:write failed');
              }
            }
            return;
          }

          // Route: only accept input from the correct channel.
          // If the message is in the wrong channel, send a one-time redirect notice
          // and fall through to normal bot operation (non-blocking passthrough).
          let passThroughToNormal = false;
          if (onboardingSession.channelMode === 'dm' && !isDm) {
            // Message is in a guild channel but onboarding is in DMs
            if (!onboardingSession.hasRedirected) {
              onboardingSession.hasRedirected = true;
              await msg.reply({ content: 'I\'m setting things up with you in DMs — check your messages!', allowedMentions: NO_MENTIONS });
            }
            passThroughToNormal = true;
          } else if (onboardingSession.channelMode === 'guild' && msg.channelId !== onboardingSession.channelId) {
            // Message is in a different guild channel than where onboarding is happening
            if (!onboardingSession.hasRedirected) {
              onboardingSession.hasRedirected = true;
              await msg.reply({ content: `I'm setting things up with you in <#${onboardingSession.channelId}> — head over there to continue!`, allowedMentions: NO_MENTIONS });
            }
            passThroughToNormal = true;
          }

          if (!passThroughToNormal) {
            // Forward to flow
            resetOnboardingTimeout();
            const result = onboardingSession.handleInput(messageText);

            if (result.writeResult === 'pending') {
              // Send the "writing..." message first
              await msg.reply({ content: result.reply, allowedMentions: NO_MENTIONS });

              // Call the writer
              try {
                const values = onboardingSession.getValues();
                const sendTarget: SendTarget = onboardingSession.channelMode === 'dm' ? msg.author : msg.channel;
                const cronDispatch = (params.cronCtx && onboardingCtxRef?.guild) ? {
                  cronCtx: params.cronCtx,
                  actionCtx: {
                    guild: onboardingCtxRef.guild,
                    client: onboardingCtxRef.client,
                    channelId: onboardingCtxRef.channelId,
                    messageId: onboardingCtxRef.messageId,
                  } as ActionContext,
                  log: params.log,
                } : undefined;
                const { writeResult } = await completeOnboarding(values, params.workspaceCwd, sendTarget, cronDispatch);
                if (writeResult.errors.length > 0) {
                  onboardingSession.markWriteFailed(writeResult.errors.join('; '));
                } else {
                  onboardingSession.markWriteComplete();
                  destroyOnboardingSession();
                  params.log?.info({ workspaceCwd: params.workspaceCwd }, 'onboarding:complete');
                }
              } catch (err) {
                params.log?.error({ err }, 'onboarding:write failed');
                onboardingSession.markWriteFailed(String(err));
                const sendTarget: SendTarget = onboardingSession.channelMode === 'dm' ? msg.author : msg.channel;
                try {
                  await sendTarget.send({
                    content: `Something went wrong writing your files: ${String(err)}\nType **retry** to try again or \`!cancel\` to give up.`,
                    allowedMentions: NO_MENTIONS,
                  });
                } catch {
                  // If we can't even send the error, destroy the session
                  destroyOnboardingSession();
                }
              }
            } else if (result.reply) {
              // Normal flow step — send the reply (guard against empty content from DONE state)
              await msg.channel.send({ content: result.reply, allowedMentions: NO_MENTIONS });
            }
            return;
          }
        }

        // 3. Active session for a different user → tell them to wait, then fall through to normal operation
        if (onboardingSession && activeOnboardingUserId && activeOnboardingUserId !== userId) {
          const onboarded = await isOnboardingComplete(params.workspaceCwd);
          if (!onboarded) {
            await msg.reply({ content: 'Someone else is already setting me up — hang tight and try again in a minute.', allowedMentions: NO_MENTIONS });
            // Fall through to normal bot operation (non-blocking passthrough)
          } else {
            // If somehow onboarding completed externally, clear the stale session
            destroyOnboardingSession();
          }
        }

        // 4. No active session → check if onboarding is needed
        if (!onboardingSession) {
          const onboarded = await isOnboardingComplete(params.workspaceCwd);
          // Only start onboarding if the workspace was bootstrapped (IDENTITY.md exists).
          // If IDENTITY.md doesn't exist at all, the workspace wasn't set up — skip.
          const identityExists = await fs.access(path.join(params.workspaceCwd, 'IDENTITY.md')).then(() => true, () => false);
          if (!onboarded && identityExists) {
            // Ignore !cancel when no session exists
            if (messageText === '!cancel') {
              await msg.reply({ content: 'Nothing to cancel.', allowedMentions: NO_MENTIONS });
              return;
            }

            // Race guard: prevent duplicate session creation from rapid messages
            const existingGuard = sessionCreationGuards.get(userId);
            if (existingGuard) {
              await existingGuard;
              // Re-check after guard resolves — session may now exist
              if (onboardingSession) return;
            }

            const guard = (async () => {
              // Re-check after acquiring guard
              if (onboardingSession) return;

              activeOnboardingUserId = userId;
              onboardingSession = new OnboardingFlow();
              const displayName = msg.author.displayName || msg.author.username || 'there';
              onboardingDisplayName = displayName;
              onboardingCtxRef = {
                guild: msg.guild,
                client: msg.client,
                channelId: msg.channelId,
                messageId: msg.id,
                channelName: (msg.channel as any)?.name ?? msg.channelId,
              };
              resetOnboardingTimeout();

              const startResult = onboardingSession.start(displayName);

              if (isDm) {
                // Already in DMs — just send the greeting
                onboardingSession.channelMode = 'dm';
                await msg.reply({ content: startResult.reply, allowedMentions: NO_MENTIONS });
              } else {
                // Try to DM the user
                try {
                  await msg.author.send({ content: startResult.reply, allowedMentions: NO_MENTIONS });
                  onboardingSession.channelMode = 'dm';
                  await msg.reply({ content: 'Let\'s set up in DMs — check your messages!', allowedMentions: NO_MENTIONS });
                } catch (dmErr: any) {
                  // DM failed — fall back to guild channel
                  params.log?.info(
                    { userId, channelId: msg.channelId, error: dmErr?.message },
                    'onboarding:dm-failed, falling back to guild channel',
                  );
                  onboardingSession.channelMode = 'guild';
                  onboardingSession.channelId = msg.channelId;
                  try {
                    await msg.reply({
                      content: 'I can\'t DM you — looks like your DMs are disabled for this server. No worries, we can set up right here!\n\n' + startResult.reply,
                      allowedMentions: NO_MENTIONS,
                    });
                  } catch {
                    // Both DM and guild reply failed — destroy session
                    destroyOnboardingSession();
                  }
                }
              }
            })().finally(() => sessionCreationGuards.delete(userId));
            sessionCreationGuards.set(userId, guard);
            await guard;
            return;
          }
        }
      }

      const isThread = typeof (msg.channel as any)?.isThread === 'function' ? (msg.channel as any).isThread() : false;
      const threadId = isThread ? String((msg.channel as any).id ?? '') : null;
      const threadParentId = isThread ? String((msg.channel as any).parentId ?? '') : null;
      const shouldSendManualPlanCta = (result: ForgeResult) =>
        !result.error && !!result.planId && !result.reachedMaxRounds && result.finalVerdict !== 'CANCELLED';

      type AutoImplementAttemptResult = {
        autoStarted: boolean;
        skipReason?: string;
      };

      async function sendForgeImplementationFollowup(result: ForgeResult) {
        const planId = result.planId;
        const manualEligible = shouldSendManualPlanCta(result);
        let attemptResult: AutoImplementAttemptResult | undefined;

        if (params.forgeAutoImplement && manualEligible && planId) {
          attemptResult = await sendAutoImplementOutcome(result);
          if (attemptResult.autoStarted) {
            return;
          }
        }

        if (!manualEligible || !planId) return;

        const skipReason = attemptResult?.skipReason;
        if (skipReason) {
          params.log?.info({ planId, skipReason }, 'forge:auto-implement:skipped');
        }

        const manualMessage = buildPlanImplementationMessage(skipReason, planId);

        try {
          await msg.channel.send({ content: manualMessage, allowedMentions: NO_MENTIONS });
        } catch (err) {
          params.log?.warn({ err, planId }, 'forge:auto-implement: manual CTA send failed');
        }
      }

      async function sendAutoImplementOutcome(result: ForgeResult): Promise<AutoImplementAttemptResult> {
        const planId = result.planId;
        const plansDir = path.join(params.workspaceCwd, 'plans');

        // Deferred promise: onRunComplete waits for the outcome message to exist before editing it,
        // eliminating the race where "Plan run complete" could appear before "Plan run started".
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let resolveOutcomeMsg!: (m: any) => void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outcomeMsgPromise = new Promise<any>((resolve) => { resolveOutcomeMsg = resolve; });

        const planCtx: PlanContext = {
          plansDir,
          workspaceCwd: params.workspaceCwd,
          taskStore: params.planCtx?.taskStore ?? (params.taskCtx)?.store ?? new TaskStore(),
          log: params.log,
          depth: 0,
          runtime: params.runtime,
          model: resolveModel(params.runtimeModel, params.runtime.id),
          phaseTimeoutMs: params.planPhaseTimeoutMs ?? 5 * 60_000,
          maxAuditFixAttempts: params.planPhaseMaxAuditFixAttempts,
          maxPlanRunPhases: MAX_PLAN_RUN_PHASES,
          skipCompletionNotify: true,
          onProgress: async (progressMsg: string) => {
            params.log?.info(
              { planId: result.planId, progress: progressMsg },
              'plan:auto-implement:progress',
            );
          },
          onRunComplete: async (finalContent: string) => {
            const sentMsg = await outcomeMsgPromise;
            if (sentMsg) {
              try {
                await sentMsg.edit({ content: finalContent, allowedMentions: NO_MENTIONS });
              } catch {
                // best-effort
              }
            } else {
              try {
                await msg.channel.send({ content: finalContent, allowedMentions: NO_MENTIONS });
              } catch {
                // best-effort
              }
            }
          },
        };

        const actionCtx: ActionContext = {
          guild: msg.guild ?? ({} as Guild),
          client: msg.client,
          channelId: msg.channelId,
          messageId: msg.id,
          threadParentId,
          deferScheduler: params.deferScheduler,
        };

        const deps: ForgeAutoImplementDeps = {
          planApprove: async (planId: string) => {
            const approveResult = await executePlanAction(
              { type: 'planApprove', planId },
              actionCtx,
              planCtx,
            );
            if (!approveResult.ok) {
              throw new Error(approveResult.error ?? 'plan approval failed');
            }
          },
          planRun: async (planId: string) => {
            const runResult = await executePlanAction(
              { type: 'planRun', planId },
              actionCtx,
              planCtx,
            );
            if (!runResult.ok) {
              throw new Error(runResult.error ?? 'plan run failed');
            }
            return { summary: runResult.summary ?? '' };
          },
          isPlanRunning,
          log: params.log,
        };

        let content: string;
        let autoStarted = false;
        let skipReason: string | undefined;

        try {
          const outcome = await autoImplementForgePlan({ planId, result }, deps);
          if (outcome.status === 'auto') {
            content = outcome.summary;
            autoStarted = true;
          } else {
            content = outcome.message;
            skipReason = outcome.message;
          }
        } catch (err) {
          params.log?.error({ err, planId }, 'forge:auto-implement: handler failed');
          const fallbackMessage = planId
            ? buildPlanImplementationMessage(undefined, planId)
            : 'Review the plan manually, then use `!plan approve <id>` and `!plan run <id>` to continue.';
          content = fallbackMessage;
          skipReason = content;
        }

        try {
          const sentMsg = await msg.channel.send({ content, allowedMentions: NO_MENTIONS });
          resolveOutcomeMsg(sentMsg);
        } catch (err) {
          params.log?.warn({ err, planId }, 'forge:auto-implement: follow-up send failed');
          resolveOutcomeMsg(null);
        }

        return { autoStarted, skipReason };
      }
      const sessionKey = discordSessionKey({
        channelId: msg.channelId,
        authorId: msg.author.id,
        isDm,
        threadId: threadId || null,
      });

      type SummaryWork = { existingSummary: string | null; exchange: string; summarySeq: number; taskStatusContext?: string };
      let pendingSummaryWork: SummaryWork | null = null as SummaryWork | null;
      type ShortTermAppend = { userContent: string; botResponse: string; channelName: string; channelId: string };
      let pendingShortTermAppend: ShortTermAppend | null = null as ShortTermAppend | null;

      await queue.run(sessionKey, async () => {
        let reply: any = null;
        let abortSignal: AbortSignal | undefined;
        try {
          // Handle !memory commands before session creation or the "..." placeholder.
          if (params.memoryCommandsEnabled) {
            const cmd = parseMemoryCommand(String(msg.content ?? ''));
            if (cmd) {
              const ch: any = msg.channel as any;
              const channelName = String(ch?.name ?? '');
              const response = await handleMemoryCommand(cmd, {
                userId: msg.author.id,
                sessionKey,
                durableDataDir: params.durableDataDir,
                durableMaxItems: params.durableMaxItems,
                durableInjectMaxChars: params.durableInjectMaxChars,
                summaryDataDir: params.summaryDataDir,
                channelId: msg.channelId,
                messageId: msg.id,
                guildId: msg.guildId ?? undefined,
                channelName: channelName || undefined,
              });
              if (cmd.action === 'reset-rolling') {
                turnCounters.delete(sessionKey);
              }
              await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
              return;
            }
          }

          // Handle !plan commands before session creation.
          if (params.planCommandsEnabled) {
            const planCmd = parsePlanCommand(String(msg.content ?? ''));
            if (planCmd) {
              const planOpts = {
                workspaceCwd: params.workspaceCwd,
                taskStore: params.planCtx?.taskStore ?? (params.taskCtx)?.store ?? new TaskStore(),
                maxContextFiles: params.planPhaseMaxContextFiles,
              };

              // Phase-related commands require PLAN_PHASES_ENABLED
              if (planCmd.action === 'run' || planCmd.action === 'run-one' || planCmd.action === 'skip' || planCmd.action === 'phases') {
                if (!(params.planPhasesEnabled ?? true)) {
                  await msg.reply({
                    content: 'Phase decomposition is disabled. Set PLAN_PHASES_ENABLED=true to enable.',
                    allowedMentions: NO_MENTIONS,
                  });
                  return;
                }
              }

              // --- !plan run / !plan run-one --- (shared handler, async, fire-and-forget)
              if (planCmd.action === 'run' || planCmd.action === 'run-one') {
                const isRunOne = planCmd.action === 'run-one';
                const maxPhases = isRunOne ? 1 : MAX_PLAN_RUN_PHASES;
                const usageCmd = isRunOne ? 'run-one' : 'run';

                if (!planCmd.args) {
                  await msg.reply({ content: `Usage: \`!plan ${usageCmd} <plan-id>\``, allowedMentions: NO_MENTIONS });
                  return;
                }

                const planId = planCmd.args;

                // Concurrency guard: reject if a multi-phase run is already active for this plan
                if (isPlanRunning(planId)) {
                  await msg.reply({ content: `A multi-phase run is already in progress for ${planId}.`, allowedMentions: NO_MENTIONS });
                  return;
                }

                addRunningPlan(planId);
                try { // outer try: guarantees addRunningPlan cleanup

                  // Acquire lock for initial validation only
                  let phasesFilePath: string;
                  let planFilePath: string;
                  let projectCwd: string;
                  let progressReply: typeof msg;

                  const validationLock = await acquireWriterLock();
                  try {
                    const prepResult = await preparePlanRun(planId, planOpts);
                    if ('error' in prepResult) {
                      // Distinguish "all done" from actual errors via NO_PHASES_SENTINEL
                      const isAllDone = prepResult.error.startsWith(NO_PHASES_SENTINEL);
                      const content = isAllDone
                        ? `All phases already complete for ${planId}.`
                        : prepResult.error;
                      await msg.reply({ content, allowedMentions: NO_MENTIONS });
                      validationLock();
                      removeRunningPlan(planId);
                      return;
                    }

                    phasesFilePath = prepResult.phasesFilePath;
                    planFilePath = prepResult.planFilePath;

                    try {
                      projectCwd = resolveProjectCwd(prepResult.planContent, params.workspaceCwd);
                    } catch (err) {
                      await msg.reply({
                        content: `Failed to resolve project directory: ${String(err instanceof Error ? err.message : err)}`,
                        allowedMentions: NO_MENTIONS,
                      });
                      validationLock();
                      removeRunningPlan(planId);
                      return;
                    }

                    const startMsg = isRunOne
                      ? `Running ${prepResult.nextPhase.id}: ${prepResult.nextPhase.title}...`
                      : `Running all phases for **${planId}** — starting ${prepResult.nextPhase.id}: ${prepResult.nextPhase.title}...`;
                    progressReply = await msg.reply({ content: startMsg, allowedMentions: NO_MENTIONS });
                  } catch (err) {
                    validationLock();
                    throw err; // outer catch cleans up running plan tracking
                  }
                  validationLock(); // release validation lock before phase execution

                  const planRunStreaming = createStreamingProgress(
                    progressReply,
                    params.forgeProgressThrottleMs ?? 3000,
                  );
                  const postedPhaseStarts = new Set<string>();
                  const phaseStartMessages = new Map<string, { edit: (opts: any) => Promise<any> }>();

                  const postPhaseStart = async (event: PlanRunEvent) => {
                    if (event.type === 'phase_start') {
                      if (postedPhaseStarts.has(event.phase.id)) return;
                      postedPhaseStarts.add(event.phase.id);
                      try {
                        const phaseMsg = await msg.channel.send({
                          content: `**${event.phase.title}**...`,
                          allowedMentions: NO_MENTIONS,
                        });
                        phaseStartMessages.set(event.phase.id, phaseMsg as any);
                      } catch (err) {
                        params.log?.warn({ err, planId, phaseId: event.phase.id }, 'plan-run: phase-start post failed');
                      }
                    } else if (event.type === 'phase_complete') {
                      const phaseMsg = phaseStartMessages.get(event.phase.id);
                      if (!phaseMsg) return;
                      const indicator = event.status === 'done' ? '[x]' : event.status === 'failed' ? '[!]' : '[-]';
                      try {
                        await phaseMsg.edit({
                          content: `${indicator} **${event.phase.title}**`,
                          allowedMentions: NO_MENTIONS,
                        });
                      } catch (err) {
                        params.log?.warn({ err, planId, phaseId: event.phase.id }, 'plan-run: phase-complete edit failed');
                      }
                    }
                  };

                  const onProgress = async (progressMsg: string, opts?: { force?: boolean }) => {
                    // Always force so phase-start/boundary messages are never throttled away
                    await planRunStreaming.onProgress(progressMsg, { force: opts?.force ?? true });
                  };

                  const onPlanRunEvent = params.toolAwareStreaming
                    ? planRunStreaming.onEvent
                    : undefined;

                  const timeoutMs = params.planPhaseTimeoutMs ?? 5 * 60_000;
                  // Register plan run with abort registry so !stop can kill it.
                  const planAbort = registerAbort(msg.id);

                  const phaseOpts = {
                    runtime: params.runtime,
                    model: resolveModel(params.runtimeModel, params.runtime.id),
                    projectCwd,
                    addDirs: [] as string[],
                    timeoutMs,
                    workspaceCwd: params.workspaceCwd,
                    log: params.log,
                    maxAuditFixAttempts: params.planPhaseMaxAuditFixAttempts,
                    onEvent: onPlanRunEvent,
                    onPlanEvent: postPhaseStart,
                    signal: planAbort.signal,
                  };

                  const editSummary = async (content: string) => {
                    try {
                      await progressReply.edit({ content, allowedMentions: NO_MENTIONS });
                    } catch (editErr: any) {
                      if (editErr?.code === 10008) {
                        try { await msg.channel.send({ content, allowedMentions: NO_MENTIONS }); } catch { /* best-effort */ }
                      }
                    }
                  };

                  // Fire-and-forget: phase execution loop
                  // eslint-disable-next-line @typescript-eslint/no-floating-promises
                  (async () => {
                    const phaseResults: Array<{ id: string; title: string; elapsedMs: number }> = [];
                    let phasesRun = 0;
                    let stopReason: 'error' | 'limit' | 'shutdown' | null = null;
                    let stopMessage = '';

                    let i = 0;
                    try {
                      for (; i < maxPhases; i++) {
                        if (isShuttingDown()) {
                          stopReason = 'shutdown';
                          break;
                        }

                        const releaseLock = await acquireWriterLock();
                        let phaseResult;
                        const phaseStart = Date.now();
                        try {
                          phaseResult = await runNextPhase(phasesFilePath, planFilePath, phaseOpts, onProgress);
                        } finally {
                          releaseLock();
                        }

                        if (phaseResult.result === 'done') {
                          phasesRun++;
                          phaseResults.push({ id: phaseResult.phase.id, title: phaseResult.phase.title, elapsedMs: Date.now() - phaseStart });
                          // Between-phase progress update (bypass throttle)
                          try {
                            const nextNote = phaseResult.nextPhase
                              ? ` Next: ${phaseResult.nextPhase.id}: ${phaseResult.nextPhase.title}...`
                              : '';
                            await onProgress(`Phase **${phaseResult.phase.id}** done.${nextNote}`);
                          } catch { /* edit failure doesn't break the loop */ }
                        } else if (phaseResult.result === 'nothing_to_run') {
                          break;
                        } else if (phaseResult.result === 'failed') {
                          stopReason = 'error';
                          stopMessage = sanitizePhaseError(phaseResult.phase.id, phaseResult.error, timeoutMs);
                          break;
                        } else if (phaseResult.result === 'audit_failed') {
                          stopReason = 'error';
                          const fixNote = phaseResult.fixAttemptsUsed != null
                            ? ` after ${phaseResult.fixAttemptsUsed} automatic fix attempt(s)`
                            : '';
                          stopMessage = `Audit phase **${phaseResult.phase.id}** found **${phaseResult.verdict.maxSeverity}** severity deviations${fixNote}. Use \`!plan run ${planId}\` to re-run the audit, \`!plan skip ${planId}\` to skip it, or \`!plan phases --regenerate ${planId}\` to regenerate phases.`;
                          break;
                        } else if (phaseResult.result === 'stale') {
                          stopReason = 'error';
                          stopMessage = phaseResult.message;
                          break;
                        } else if (phaseResult.result === 'corrupt') {
                          stopReason = 'error';
                          stopMessage = phaseResult.message;
                          break;
                        } else if (phaseResult.result === 'retry_blocked') {
                          stopReason = 'error';
                          stopMessage = `Phase **${phaseResult.phase.id}** retry blocked. Use \`!plan skip ${planId}\` or \`!plan phases --regenerate ${planId}\`.`;
                          break;
                        } else {
                          break;
                        }

                        // Yield between phases to prevent writer lock starvation
                        await new Promise(resolve => setImmediate(resolve));
                      }
                      if (i >= maxPhases && !stopReason) stopReason = 'limit';
                    } catch (loopErr) {
                      stopReason = 'error';
                      stopMessage = `Unexpected error: ${sanitizeErrorMessage(String(loopErr))}`;
                      params.log?.error({ err: loopErr, phasesRun, planId }, 'plan-run: crash in phase loop');
                    }

                    planRunStreaming.dispose();

                    // Build summary — always runs regardless of how the loop terminated
                    const fmtElapsed = (ms: number) => ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
                    const phaseList = phaseResults.map(p => `[x] ${p.id}: ${p.title} (${fmtElapsed(p.elapsedMs)})`).join('\n');

                    let summaryMsg: string;

                    if (isRunOne) {
                      // Single-phase format (matches old !plan run UX)
                      if (stopReason === 'error') {
                        summaryMsg = `${stopMessage}\nUse \`!plan run-one ${planId}\` to retry or \`!plan skip ${planId}\` to skip.`;
                      } else if (phasesRun > 0) {
                        const p = phaseResults[0];
                        summaryMsg = `Phase **${p.id}** done: ${p.title}`;
                      } else {
                        summaryMsg = 'All phases are done (or dependencies unmet).';
                      }
                    } else if (stopReason === null && phasesRun > 0) {
                      const totalMs = phaseResults.reduce((s, p) => s + p.elapsedMs, 0);
                      summaryMsg = `Plan run complete for **${planId}**: ${phasesRun} phase${phasesRun !== 1 ? 's' : ''} executed (${fmtElapsed(totalMs)})\n${phaseList}`;
                    } else if (stopReason === null && phasesRun === 0) {
                      summaryMsg = `All phases already complete for ${planId}.`;
                    } else if (stopReason === 'error') {
                      summaryMsg = `Plan run stopped: ${stopMessage}. ${phasesRun}/${phasesRun + 1} phases completed.\nUse \`!plan run ${planId}\` to retry or \`!plan skip ${planId}\` to skip.`;
                      if (phaseList) summaryMsg += `\n${phaseList}`;
                    } else if (stopReason === 'limit') {
                      summaryMsg = `Plan run stopped after ${MAX_PLAN_RUN_PHASES} phases (safety limit). Use \`!plan run ${planId}\` to continue.\n${phaseList}`;
                    } else {
                      // shutdown
                      summaryMsg = `Plan run interrupted (bot shutting down). ${phasesRun} phase${phasesRun !== 1 ? 's' : ''} completed.`;
                      if (phaseList) summaryMsg += `\n${phaseList}`;
                    }

                    if (!isRunOne && (phasesRun > 0 || stopReason === null)) {
                      try {
                        const phases = readPhasesFile(phasesFilePath, { log: params.log });
                        const budget = 2000 - summaryMsg.length - 50;
                        const postRunSummary = buildPostRunSummary(phases, budget);
                        if (postRunSummary) {
                          summaryMsg += `\n${postRunSummary}`;
                        }
                      } catch (summaryErr) {
                        params.log?.error({ err: summaryErr }, 'plan-run: failed to build post-run summary');
                      }
                    }

                    await editSummary(summaryMsg);

                    // Post a separate final summary message in the channel flow (full runs only)
                    if (!isRunOne) {
                      try {
                        await msg.channel.send({ content: summaryMsg, allowedMentions: NO_MENTIONS });
                      } catch (err) {
                        params.log?.warn({ err, planId }, 'plan-run: final summary channel post failed');
                      }
                    }

                    // Auto-close plan if all phases are terminal
                    const closeResult = await closePlanIfComplete(
                      phasesFilePath,
                      planFilePath,
                      planOpts.taskStore,
                      acquireWriterLock,
                      params.log,
                    );
                    if (closeResult.closed) {
                      await editSummary(summaryMsg + '\n\nPlan and backing task auto-closed.');
                    }
                  })().then(
                    () => { /* success — cleanup handled by outer finally */ },
                    (err) => {
                      params.log?.error({ err }, 'plan-run:unhandled error');
                      (async () => {
                        try {
                          const errMsg = `Plan run crashed: ${sanitizeErrorMessage(String(err))}`;
                          await progressReply.edit({ content: errMsg, allowedMentions: NO_MENTIONS });
                        } catch (editErr: any) {
                          if (editErr?.code === 10008) {
                            try { await msg.channel.send({ content: `Plan run crashed: ${sanitizeErrorMessage(String(err))}`, allowedMentions: NO_MENTIONS }); } catch { /* best-effort */ }
                          }
                        }
                      })().catch(() => {});
                    },
                  ).catch((err) => {
                    params.log?.error({ err }, 'plan-run: unhandled rejection in callback');
                  }).finally(() => {
                    planAbort.dispose();
                    removeRunningPlan(planId);
                  });

                } catch (err) {
                  removeRunningPlan(planId);
                  throw err;
                }

                return;
              }

              // --- !plan skip ---
              if (planCmd.action === 'skip') {
                if (!planCmd.args) {
                  await msg.reply({ content: 'Usage: `!plan skip <plan-id>`', allowedMentions: NO_MENTIONS });
                  return;
                }

                const releaseLock = await acquireWriterLock();
                try {
                  const response = await handlePlanSkip(planCmd.args, planOpts);
                  await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
                } finally {
                  releaseLock();
                }
                return;
              }

              // --- !plan audit --- (async, fire-and-forget — AI audit can take 30-60s)
              if (planCmd.action === 'audit') {
                if (!planCmd.args) {
                  await msg.reply({ content: 'Usage: `!plan audit <plan-id>`', allowedMentions: NO_MENTIONS });
                  return;
                }

                const auditPlanId = planCmd.args;
                const progressReply = await msg.reply({
                  content: `Auditing **${auditPlanId}**...`,
                  allowedMentions: NO_MENTIONS,
                });

                const plansDir = path.join(params.workspaceCwd, 'plans');
                const rawAuditorModel = params.forgeAuditorModel ?? params.runtimeModel;
                const timeoutMs = params.forgeTimeoutMs ?? 5 * 60_000;
                const auditRt = params.auditorRuntime ?? params.runtime;
                const hasExplicitAuditorModel = Boolean(params.forgeAuditorModel);
                const effectiveAuditModel = auditRt.id === 'claude_code'
                  ? resolveModel(rawAuditorModel, auditRt.id)
                  : (hasExplicitAuditorModel ? resolveModel(rawAuditorModel, auditRt.id) : '');

                // Resolve project root so the auditor can read source code
                let auditProjectCwd: string;
                try {
                  const auditFound = await findPlanFile(plansDir, auditPlanId);
                  if (!auditFound) {
                    await progressReply.edit({ content: `Audit failed: plan not found: ${auditPlanId}`, allowedMentions: NO_MENTIONS });
                    return;
                  }
                  const auditPlanContent = await fs.readFile(auditFound.filePath, 'utf-8');
                  auditProjectCwd = resolveProjectCwd(auditPlanContent, params.workspaceCwd);
                } catch (err) {
                  await progressReply.edit({ content: `Audit failed: ${String(err instanceof Error ? err.message : err)}`, allowedMentions: NO_MENTIONS });
                  return;
                }

                handlePlanAudit({
                  planId: auditPlanId,
                  plansDir,
                  cwd: auditProjectCwd,
                  workspaceCwd: params.workspaceCwd,
                  runtime: params.runtime,
                  auditorRuntime: params.auditorRuntime,
                  auditorModel: effectiveAuditModel,
                  timeoutMs,
                  acquireWriterLock,
                }).then(
                  async (result: PlanAuditResult) => {
                    try {
                      if (result.ok) {
                        const verdictText = result.verdict.shouldLoop ? 'needs revision' : 'ready to approve';
                        await progressReply.edit({
                          content: `Audit complete for **${result.planId}** — review ${result.round}, verdict: **${result.verdict.maxSeverity}** (${verdictText}). See \`!plan show ${result.planId}\` for details.`,
                          allowedMentions: NO_MENTIONS,
                        });
                      } else {
                        await progressReply.edit({
                          content: `Audit failed for **${auditPlanId}**: ${result.error}`,
                          allowedMentions: NO_MENTIONS,
                        });
                      }
                    } catch {
                      // edit failure (message deleted, etc.) — best-effort
                    }
                  },
                  async (err) => {
                    try {
                      await progressReply.edit({
                        content: `Audit failed for **${auditPlanId}**: ${String(err)}`,
                        allowedMentions: NO_MENTIONS,
                      });
                    } catch {
                      // best-effort
                    }
                  },
                );
                return;
              }

              // --- !plan phases --- (acquires lock for write, releases early for read)
              if (planCmd.action === 'phases') {
                const releaseLock = await acquireWriterLock();
                try {
                  const response = await handlePlanCommand(planCmd, planOpts);
                  await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
                } finally {
                  releaseLock();
                }
                return;
              }

              // All other plan actions pass through.
              // For create, include reply context so "!plan fix this" knows what "this" is.
                // Context travels separately so slug/task/title stay clean.
                let effectivePlanCmd = planCmd;
                if (planCmd.action === 'create' && planCmd.args) {
                const ctxResult = await gatherConversationContext({
                  msg,
                  params,
                  isThread,
                  threadId,
                  threadParentId,
                });

                let planContext = ctxResult.context;
                if (ctxResult.pinnedSummary) {
                  planContext = planContext
                    ? `${planContext}\n\n${ctxResult.pinnedSummary}`
                    : ctxResult.pinnedSummary;
                }

                if (planContext) {
                  effectivePlanCmd = {
                    ...planCmd,
                    context: planContext,
                    existingTaskId: ctxResult.existingTaskId,
                  };
                } else if (ctxResult.existingTaskId) {
                  effectivePlanCmd = { ...planCmd, existingTaskId: ctxResult.existingTaskId };
                }
              }
              const response = await handlePlanCommand(effectivePlanCmd, planOpts);
              await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
              return;
            }
          }

          // Handle !forge commands — long-running, async plan creation.
          if (params.forgeCommandsEnabled) {
            const forgeCmd = parseForgeCommand(String(msg.content ?? ''));
            if (forgeCmd) {
              if (forgeCmd.action === 'help') {
                await msg.reply({
                  content: [
                    '**!forge commands:**',
                    '- `!forge <description>` — auto-draft and audit a plan',
                    '- `!forge status` — check if a forge is running',
                    '- `!forge cancel` — cancel the running forge',
                  ].join('\n'),
                  allowedMentions: NO_MENTIONS,
                });
                return;
              }

              if (forgeCmd.action === 'status') {
                const running = getActiveOrchestrator()?.isRunning ?? false;
                await msg.reply({
                  content: running ? 'A forge is currently running.' : 'No forge running.',
                  allowedMentions: NO_MENTIONS,
                });
                return;
              }

              if (forgeCmd.action === 'cancel') {
                const orch = getActiveOrchestrator();
                if (orch?.isRunning) {
                  orch.requestCancel();
                  await msg.reply({ content: 'Forge cancel requested.', allowedMentions: NO_MENTIONS });
                } else {
                  await msg.reply({ content: 'No forge running to cancel.', allowedMentions: NO_MENTIONS });
                }
                return;
              }

              // action === 'create'
              if (getActiveOrchestrator()?.isRunning) {
                await msg.reply({
                  content: 'A forge is already running. Use `!forge cancel` to stop it first.',
                  allowedMentions: NO_MENTIONS,
                });
                return;
              }

              // --- Detect plan-ID references (resume existing plan) ---
              if (looksLikePlanId(forgeCmd.args)) {
                const plansDir = path.join(params.workspaceCwd, 'plans');
                const found = await findPlanFile(plansDir, forgeCmd.args);
                if (!found) {
                  await msg.reply({
                    content: `No plan found matching "${forgeCmd.args}". Use \`!forge <description>\` to create a new plan.`,
                    allowedMentions: NO_MENTIONS,
                  });
                  return;
                }

                // Resume path — resolve project root from existing plan content
                let resumeProjectCwd: string;
                try {
                  const resumePlanContent = await fs.readFile(found.filePath, 'utf-8');
                  resumeProjectCwd = resolveProjectCwd(resumePlanContent, params.workspaceCwd);
                } catch (err) {
                  await msg.reply({
                    content: `Failed to resolve project directory: ${String(err instanceof Error ? err.message : err)}`,
                    allowedMentions: NO_MENTIONS,
                  });
                  return;
                }
                const forgeReleaseLock = await acquireWriterLock();

                const resumeOrchestrator = new ForgeOrchestrator({
                  runtime: params.runtime,
                  drafterRuntime: params.drafterRuntime,
                  auditorRuntime: params.auditorRuntime,
                  model: resolveModel(params.runtimeModel, params.runtime.id),
                  cwd: resumeProjectCwd,
                  workspaceCwd: params.workspaceCwd,
                  taskStore: params.forgeCtx?.taskStore ?? (params.taskCtx)?.store ?? new TaskStore(),
                  plansDir,
                  maxAuditRounds: params.forgeMaxAuditRounds ?? 5,
                  progressThrottleMs: params.forgeProgressThrottleMs ?? 3000,
                  timeoutMs: params.forgeTimeoutMs ?? 5 * 60_000,
                  drafterModel: params.forgeDrafterModel,
                  auditorModel: params.forgeAuditorModel,
                  log: params.log,
                });
                setActiveOrchestrator(resumeOrchestrator);

                const progressReply = await msg.reply({
                  content: `Re-auditing **${found.header.planId}**...`,
                  allowedMentions: NO_MENTIONS,
                });

                const forgeResumeStreaming = createStreamingProgress(
                  progressReply,
                  params.forgeProgressThrottleMs ?? 3000,
                );

                const onProgress = async (progressMsg: string, opts?: { force?: boolean }) => {
                  await forgeResumeStreaming.onProgress(progressMsg, opts);
                };

                const forgeResumeOnEvent = params.toolAwareStreaming
                  ? forgeResumeStreaming.onEvent
                  : undefined;

                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                resumeOrchestrator.resume(found.header.planId, found.filePath, found.header.title, onProgress, forgeResumeOnEvent).then(
                  async (result) => {
                    forgeResumeStreaming.dispose();
                    setActiveOrchestrator(null);
                    forgeReleaseLock();
                    // On message-gone (10008), onProgress already handled the channel.send fallback;
                    // if result has an error, the orchestrator's error path already called onProgress.
                    if (result.planSummary && !result.error) {
                      try {
                        await msg.channel.send({ content: result.planSummary, allowedMentions: NO_MENTIONS });
                      } catch {
                        // best-effort
                      }
                    }
                    await sendForgeImplementationFollowup(result);
                  },
                  async (err) => {
                    forgeResumeStreaming.dispose();
                    setActiveOrchestrator(null);
                    forgeReleaseLock();
                    params.log?.error({ err }, 'forge:resume:unhandled error');
                    try {
                      const errMsg = `Forge resume crashed: ${sanitizeErrorMessage(String(err))}`;
                      await progressReply.edit({ content: errMsg, allowedMentions: NO_MENTIONS });
                    } catch (editErr: any) {
                      if (editErr?.code === 10008) {
                        try { await msg.channel.send({ content: `Forge resume crashed: ${sanitizeErrorMessage(String(err))}`, allowedMentions: NO_MENTIONS }); } catch { /* best-effort */ }
                      }
                    }
                  },
                ).catch((err) => {
                  params.log?.error({ err }, 'forge:resume: unhandled rejection in callback');
                });

                return;
              }

              const ctxResult = await gatherConversationContext({
                msg,
                params,
                isThread,
                threadId,
                threadParentId,
              });

              const taskSummary = buildTaskContextSummary(
                ctxResult.existingTaskId,
                (params.taskCtx)?.store,
              );

              const forgeContextParts: string[] = [];
              if (ctxResult.context) forgeContextParts.push(ctxResult.context);
              if (taskSummary?.summary) forgeContextParts.push(taskSummary.summary);
              if (ctxResult.pinnedSummary) forgeContextParts.push(ctxResult.pinnedSummary);

              const forgeContext = forgeContextParts.length > 0
                ? forgeContextParts.join('\n\n')
                : undefined;

              const forgeReleaseLock = await acquireWriterLock();

              const plansDir = path.join(params.workspaceCwd, 'plans');
              const createOrchestrator = new ForgeOrchestrator({
                runtime: params.runtime,
                drafterRuntime: params.drafterRuntime,
                auditorRuntime: params.auditorRuntime,
                model: resolveModel(params.runtimeModel, params.runtime.id),
                cwd: params.projectCwd,
                workspaceCwd: params.workspaceCwd,
                taskStore: params.forgeCtx?.taskStore ?? (params.taskCtx)?.store ?? new TaskStore(),
                plansDir,
                maxAuditRounds: params.forgeMaxAuditRounds ?? 5,
                progressThrottleMs: params.forgeProgressThrottleMs ?? 3000,
                timeoutMs: params.forgeTimeoutMs ?? 5 * 60_000,
                drafterModel: params.forgeDrafterModel,
                auditorModel: params.forgeAuditorModel,
                log: params.log,
                existingTaskId: ctxResult.existingTaskId,
                taskDescription: taskSummary?.description,
                pinnedThreadSummary: ctxResult.pinnedSummary,
              });
              setActiveOrchestrator(createOrchestrator);

              // Send initial progress message
              const progressReply = await msg.reply({
                content: `Starting forge: ${forgeCmd.args}`,
                allowedMentions: NO_MENTIONS,
              });

              const forgeCreateStreaming = createStreamingProgress(
                progressReply,
                params.forgeProgressThrottleMs ?? 3000,
              );

              const onProgress = async (progressMsg: string, opts?: { force?: boolean }) => {
                await forgeCreateStreaming.onProgress(progressMsg, opts);
              };

              const forgeCreateOnEvent = params.toolAwareStreaming
                ? forgeCreateStreaming.onEvent
                : undefined;

              // Run forge in the background — don't block the queue
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              createOrchestrator.run(forgeCmd.args, onProgress, forgeContext, forgeCreateOnEvent).then(
                async (result) => {
                  forgeCreateStreaming.dispose();
                  setActiveOrchestrator(null);
                  forgeReleaseLock();
                  // Send plan summary as a follow-up message
                  if (result.planSummary && !result.error) {
                    try {
                      await msg.channel.send({ content: result.planSummary, allowedMentions: NO_MENTIONS });
                    } catch {
                      // best-effort
                    }
                  }
                  await sendForgeImplementationFollowup(result);
                },
                async (err) => {
                  forgeCreateStreaming.dispose();
                  setActiveOrchestrator(null);
                  forgeReleaseLock();
                  params.log?.error({ err }, 'forge:unhandled error');
                  try {
                    const errMsg = `Forge crashed: ${sanitizeErrorMessage(String(err))}`;
                    await progressReply.edit({ content: errMsg, allowedMentions: NO_MENTIONS });
                  } catch (editErr: any) {
                    if (editErr?.code === 10008) {
                      try { await msg.channel.send({ content: `Forge crashed: ${sanitizeErrorMessage(String(err))}`, allowedMentions: NO_MENTIONS }); } catch { /* best-effort */ }
                    }
                  }
                },
              ).catch((err) => {
                params.log?.error({ err }, 'forge: unhandled rejection in callback');
              });

              return;
            }
          }

          const confirmToken = parseConfirmToken(String(msg.content ?? ''));
          if (confirmToken) {
            const pending = consumeDestructiveConfirmation(confirmToken, sessionKey, msg.author.id);
            if (!pending) {
              await msg.reply({
                content: `No pending destructive action found for token \`${confirmToken}\` in this session.`,
                allowedMentions: NO_MENTIONS,
              });
              return;
            }

            if (!msg.guild) {
              await msg.reply({
                content: `Confirmed token \`${confirmToken}\`, but destructive Discord actions require a guild context.`,
                allowedMentions: NO_MENTIONS,
              });
              return;
            }

            const confirmAction = pending.action as { type: string };
            const actCtx = {
              guild: msg.guild,
              client: msg.client,
              channelId: msg.channelId,
              messageId: msg.id,
              threadParentId,
              deferScheduler: params.deferScheduler,
              confirmation: {
                mode: 'interactive' as const,
                sessionKey,
                userId: msg.author.id,
                bypassDestructive: true,
              },
            };
            const perMessageMemoryCtx = params.memoryCtx ? {
              ...params.memoryCtx,
              userId: msg.author.id,
              channelId: msg.channelId,
              messageId: msg.id,
              guildId: msg.guildId ?? undefined,
              channelName: (msg.channel as any)?.name ?? undefined,
            } : undefined;
            const actionResults = await executeDiscordActions([confirmAction as any], actCtx, params.log, {
              taskCtx: params.taskCtx,
              cronCtx: params.cronCtx,
              forgeCtx: params.forgeCtx,
              planCtx: params.planCtx,
              memoryCtx: perMessageMemoryCtx,
              configCtx: params.configCtx,
            });
            const displayLines = buildDisplayResultLines([confirmAction], actionResults);
            const content = displayLines.length > 0
              ? `Confirmed \`${confirmAction.type}\`.\n${displayLines.join('\n')}`
              : `Confirmed \`${confirmAction.type}\`.`;
            await msg.reply({ content, allowedMentions: NO_MENTIONS });
            return;
          }

          const sessionId = params.useRuntimeSessions
            ? await params.sessionManager.getOrCreate(sessionKey)
            : null;

          // If the message is in a thread, join it before replying so sends don't fail.
          if (params.autoJoinThreads && isThread) {
            const th: any = msg.channel as any;
            const joinable = typeof th?.joinable === 'boolean' ? th.joinable : true;
            const joined = typeof th?.joined === 'boolean' ? th.joined : false;
            if (joinable && !joined && typeof th?.join === 'function') {
              try {
                await th.join();
                params.log?.info({ threadId: String(th.id ?? ''), parentId: String(th.parentId ?? '') }, 'discord:thread joined');
              } catch (err) {
                params.log?.warn({ err, threadId: String(th?.id ?? '') }, 'discord:thread failed to join');
              }
            }
          }

          reply = await msg.reply({ content: formatBoldLabel(thinkingLabel(0)), allowedMentions: NO_MENTIONS });

          // Track this reply for graceful shutdown cleanup and cleanup on early error.
          let replyFinalized = false;
          let hadTextFinal = false;
          let dispose = registerInFlightReply(reply, msg.channelId, reply.id, `message:${msg.channelId}`);
          const { signal, dispose: abortDispose } = registerAbort(reply.id);
          abortSignal = signal;
          // Best-effort: add 🛑 so the user can tap it to kill the running stream.
          (reply as any).react?.('🛑')?.catch(() => { /* best-effort */ });
          // Declared before try so they remain accessible after the finally block closes.
          let historySection = '';
          let summarySection = '';
          let processedText = '';
          try {

          const cwd = params.useGroupDirCwd
            ? await ensureGroupDir(params.groupsDir, sessionKey, params.botDisplayName)
            : params.workspaceCwd;

          // Ensure every channel has its own context file (bootstrapped on first message).
          if (!isDm && params.discordChannelContext && params.autoIndexChannelContext) {
            const id = (threadParentId && threadParentId.trim()) ? threadParentId : String(msg.channelId ?? '');
            // Best-effort: in most guild channels this will be populated; fallback uses channel-id.
            const chName = String((msg.channel as any)?.name ?? (msg.channel as any)?.parent?.name ?? '').trim();
            try {
              await ensureIndexedDiscordChannelContext({
                ctx: params.discordChannelContext,
                channelId: id,
                channelName: chName || undefined,
                log: params.log,
              });
            } catch (err) {
              params.log?.error({ err, channelId: id }, 'discord:context failed to ensure channel context');
            }
          }

          const channelCtx = resolveDiscordChannelContext({
            ctx: params.discordChannelContext,
            isDm,
            channelId: msg.channelId,
            threadParentId,
          });

          if (params.requireChannelContext && !isDm && !channelCtx.contextPath) {
            await reply.edit({
              content: mapRuntimeErrorToUserMessage('Configuration error: missing required channel context file for this channel ID.'),
              allowedMentions: NO_MENTIONS,
            });
            replyFinalized = true;
            return;
          }

          const paFiles = await loadWorkspacePaFiles(params.workspaceCwd, { skip: !!params.appendSystemPrompt });
          const memoryFiles: string[] = [];
          if (isDm) {
            const memFile = await loadWorkspaceMemoryFile(params.workspaceCwd);
            if (memFile) memoryFiles.push(memFile);
            memoryFiles.push(...await loadDailyLogFiles(params.workspaceCwd));
          }
          const contextFiles = buildContextFiles(
            [...paFiles, ...memoryFiles],
            params.discordChannelContext,
            channelCtx.contextPath,
          );

          if (params.messageHistoryBudget > 0) {
            try {
              historySection = await fetchMessageHistory(
                msg.channel,
                msg.id,
                { budgetChars: params.messageHistoryBudget, botDisplayName: params.botDisplayName },
              );
            } catch (err) {
              params.log?.warn({ err }, 'discord:history fetch failed');
            }
          }

          if (params.summaryEnabled) {
            try {
              const existing = await loadSummary(params.summaryDataDir, sessionKey);
              if (existing) {
                summarySection = existing.summary;
                if (!turnCounters.has(sessionKey)) {
                  const raw = existing.turnsSinceUpdate;
                  turnCounters.set(sessionKey, typeof raw === 'number' && raw >= 0 ? raw : 0);
                }
              }
            } catch (err) {
              params.log?.warn({ err, sessionKey }, 'discord:summary load failed');
            }
          }

          const [durableSection, shortTermSection, taskSection, replyRef] = await Promise.all([
            buildDurableMemorySection({
              enabled: params.durableMemoryEnabled,
              durableDataDir: params.durableDataDir,
              userId: msg.author.id,
              durableInjectMaxChars: params.durableInjectMaxChars,
              log: params.log,
            }),
            buildShortTermMemorySection({
              enabled: params.shortTermMemoryEnabled && !isDm,
              shortTermDataDir: params.shortTermDataDir,
              guildId: String(msg.guildId ?? ''),
              userId: msg.author.id,
              maxChars: params.shortTermInjectMaxChars,
              maxAgeMs: params.shortTermMaxAgeMs,
              log: params.log,
            }),
            buildTaskThreadSection({
              isThread,
              threadId,
              threadParentId,
              taskCtx: params.taskCtx,
              log: params.log,
            }),
            resolveReplyReference(msg, params.botDisplayName, params.log),
          ]);

          const inlinedContext = await inlineContextFiles(
            contextFiles,
            { required: new Set(params.discordChannelContext?.paContextFiles ?? []) },
          );

          // Consume one-shot startup injection (cleared after first use).
          let startupLine = '';
          if (params.startupInjection) {
            startupLine = params.startupInjection;
            params.startupInjection = null;
          }

          let prompt =
            (inlinedContext
              ? inlinedContext + '\n\n'
              : '') +
            (taskSection
              ? `---\n${taskSection}\n\n`
              : '') +
            (durableSection
              ? `---\nDurable memory (user-specific notes):\n${durableSection}\n\n`
              : '') +
            (shortTermSection
              ? `---\nRecent activity (cross-channel):\n${shortTermSection}\n\n`
              : '') +
            (summarySection
              ? `---\nConversation memory:\n${summarySection}\n\n`
              : '') +
            (historySection
              ? `---\nRecent conversation:\n${historySection}\n\n`
              : '') +
            (replyRef
              ? `---\nReplied-to message:\n${replyRef.section}\n\n`
              : '') +
            (startupLine
              ? `---\nStartup context:\n${startupLine}\n\n`
              : '') +
            `---\nThe sections above are internal system context. Never quote, reference, or explain them in your response. Respond only to the user message below.\n\n` +
            `---\nUser message:\n` +
            String(msg.content ?? '');

          if (params.discordActionsEnabled && !isDm) {
            prompt += '\n\n---\n' + discordActionsPromptSection(actionFlags, params.botDisplayName);
          }

          const addDirs: string[] = [];
          if (params.useGroupDirCwd) addDirs.push(params.workspaceCwd);
          if (params.discordChannelContext) addDirs.push(params.discordChannelContext.contentDir);

          const tools = await resolveEffectiveTools({
            workspaceCwd: params.workspaceCwd,
            runtimeTools: params.runtimeTools,
            runtimeCapabilities: params.runtime.capabilities,
            runtimeId: params.runtime.id,
            log: params.log,
          });
          const effectiveTools = tools.effectiveTools;
          if (tools.permissionNote || tools.runtimeCapabilityNote) {
            const noteLines = [
              tools.permissionNote ? `Permission note: ${tools.permissionNote}` : null,
              tools.runtimeCapabilityNote ? `Runtime capability note: ${tools.runtimeCapabilityNote}` : null,
            ].filter((line): line is string => Boolean(line));
            prompt += `\n\n---\n${noteLines.join('\n')}\n`;
          }

          params.log?.info(
            {
              sessionKey,
              sessionId,
              cwd,
              model: params.runtimeModel,
              toolsCount: effectiveTools.length,
              timeoutMs: params.runtimeTimeoutMs,
              channelId: channelCtx.channelId,
              channelName: channelCtx.channelName,
              hasChannelContext: Boolean(channelCtx.contextPath),
              permissionTier: tools.permissionTier,
            },
            'invoke:start',
          );

          // Collect images from reply reference (downloaded first, takes priority).
          let inputImages: ImageData[] | undefined;
          const replyRefImageCount = replyRef?.images.length ?? 0;
          if (replyRefImageCount > 0) {
            inputImages = [...replyRef!.images];
            params.log?.info({ imageCount: replyRefImageCount }, 'discord:reply-ref images downloaded');
          }

          // Download image attachments from the user message (remaining budget).
          if (msg.attachments && msg.attachments.size > 0) {
            try {
              const dlResult = await downloadMessageImages(
                [...msg.attachments.values()],
                MAX_IMAGES_PER_INVOCATION - replyRefImageCount,
              );
              if (dlResult.images.length > 0) {
                inputImages = [...(inputImages ?? []), ...dlResult.images];
                params.log?.info({ imageCount: dlResult.images.length }, 'discord:images downloaded');
              }
              if (dlResult.errors.length > 0) {
                params.log?.warn({ errors: dlResult.errors }, 'discord:image download errors');
                metrics.increment('discord.image_download.errors', dlResult.errors.length);
                prompt += `\n(Note: ${dlResult.errors.length} image(s) could not be loaded: ${dlResult.errors.join('; ')})`;
              }
            } catch (err) {
              params.log?.warn({ err }, 'discord:image download failed');
            }

            // Download non-image text attachments.
            try {
              const nonImageAtts = [...msg.attachments.values()].filter(a => !resolveMediaType(a));
              if (nonImageAtts.length > 0) {
                const textResult = await downloadTextAttachments(nonImageAtts);
                if (textResult.texts.length > 0) {
                  const sections = textResult.texts.map(t => `[Attached file: ${t.name}]\n\`\`\`\n${t.content}\n\`\`\``);
                  prompt += '\n\n' + sections.join('\n\n');
                  params.log?.info({ fileCount: textResult.texts.length }, 'discord:text attachments downloaded');
                }
                if (textResult.errors.length > 0) {
                  prompt += '\n(' + textResult.errors.join('; ') + ')';
                  params.log?.info({ errors: textResult.errors }, 'discord:text attachment notes');
                }
              }
            } catch (err) {
              params.log?.warn({ err }, 'discord:text attachment download failed');
            }
          }

          let currentPrompt = prompt;
          let followUpDepth = 0;

          // -- auto-follow-up loop --
          // When query actions (channelList, readMessages, etc.) succeed, re-invoke
          // Claude with the results so it can continue reasoning without user intervention.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            let finalText = '';
            let deltaText = '';
            const collectedImages: ImageData[] = [];
            let activityLabel = '';
            let statusTick = 1;
            const t0 = Date.now();
            metrics.recordInvokeStart('message');
            params.log?.info({ flow: 'message', sessionKey, followUpDepth }, 'obs.invoke.start');
            let invokeHadError = false;
            let invokeErrorMessage = '';
            let lastEditAt = 0;
            const minEditIntervalMs = 1250;
            hadTextFinal = false;

            // On follow-up iterations, send a new placeholder message.
            if (followUpDepth > 0) {
              dispose();
              reply = await msg.channel.send({ content: formatBoldLabel('(following up...)'), allowedMentions: NO_MENTIONS });
              dispose = registerInFlightReply(reply, msg.channelId, reply.id, `message:${msg.channelId}:followup-${followUpDepth}`);
              replyFinalized = false;
              params.log?.info({ sessionKey, followUpDepth }, 'followup:start');
            }

            let streamEditQueue: Promise<void> = Promise.resolve();
            const maybeEdit = async (force = false) => {
              if (!reply) return;
              if (isShuttingDown()) return;
              const now = Date.now();
              if (!force && now - lastEditAt < minEditIntervalMs) return;
              lastEditAt = now;
              const out = selectStreamingOutput({ deltaText, activityLabel, finalText, statusTick: statusTick++, showPreview: Date.now() - t0 >= 7000, elapsedMs: Date.now() - t0 });
              streamEditQueue = streamEditQueue
                .catch(() => undefined)
                .then(async () => {
                  try {
                    await reply.edit({ content: out, allowedMentions: NO_MENTIONS });
                  } catch {
                    // Ignore Discord edit errors during streaming.
                  }
                });
              await streamEditQueue;
            };

            // Stream stall warning state.
            let lastEventAt = Date.now();
            let activeToolCount = 0;
            let stallWarned = false;

            // If the runtime produces no stdout/stderr (auth/network hangs), avoid leaving the
            // placeholder `...` indefinitely by periodically updating the message.
            const keepalive = setInterval(() => {
              // Stall warning: append to deltaText when events stop arriving.
              if (params.streamStallWarningMs > 0) {
                const stallElapsed = Date.now() - lastEventAt;
                if (stallElapsed > params.streamStallWarningMs && activeToolCount === 0 && !stallWarned) {
                  stallWarned = true;
                  deltaText += (deltaText ? '\n' : '') + `\n*Stream may be stalled (${Math.round(stallElapsed / 1000)}s no activity)...*`;
                }
              }
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              maybeEdit(true);
            }, 5000);

            // Tool-aware streaming: route events through a state machine that buffers
            // text during tool execution and streams the final answer cleanly.
            const taq = params.toolAwareStreaming
              ? new ToolAwareQueue((action) => {
                  if (action.type === 'stream_text') {
                    deltaText += action.text;
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    maybeEdit(false);
                  } else if (action.type === 'set_final') {
                    hadTextFinal = true;
                    finalText = action.text;
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    maybeEdit(true);
                  } else if (action.type === 'show_activity') {
                    activityLabel = action.label;
                    deltaText = '';
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    maybeEdit(true);
                  }
                }, { flushDelayMs: 2000, postToolDelayMs: 500 })
              : null;

            try {
              for await (const evt of params.runtime.invoke({
                prompt: currentPrompt,
                model: resolveModel(params.runtimeModel, params.runtime.id),
                cwd,
                addDirs: addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined,
                sessionId,
                sessionKey,
                tools: effectiveTools,
                timeoutMs: params.runtimeTimeoutMs,
                // Images only on initial turn — follow-ups are text-only continuations
                // with action results; re-downloading would waste time and bandwidth.
                images: followUpDepth === 0 ? inputImages : undefined,
                signal: abortSignal,
              })) {
                // Track event flow for stall warning.
                lastEventAt = Date.now();
                stallWarned = false;
                if (evt.type === 'tool_start') activeToolCount++;
                else if (evt.type === 'tool_end') activeToolCount = Math.max(0, activeToolCount - 1);

                if (taq) {
                  // Tool-aware mode: route relevant events through the queue.
                  if (evt.type === 'text_delta' || evt.type === 'text_final' ||
                      evt.type === 'tool_start' || evt.type === 'tool_end') {
                    taq.handleEvent(evt);
                  } else if (evt.type === 'error') {
                    invokeHadError = true;
                    invokeErrorMessage = evt.message;
                    taq.handleEvent(evt);
                    finalText = abortSignal.aborted
                      ? '*(Response aborted.)*'
                      : mapRuntimeErrorToUserMessage(evt.message);
                    await maybeEdit(true);
                    if (!abortSignal.aborted) {
                      // eslint-disable-next-line @typescript-eslint/no-floating-promises
                      statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
                      params.log?.warn({ flow: 'message', sessionKey, error: evt.message }, 'obs.invoke.error');
                    }
                  } else if (evt.type === 'log_line') {
                    // Bypass queue for log lines.
                    const prefix = evt.stream === 'stderr' ? '[stderr] ' : '[stdout] ';
                    deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + prefix + evt.line + '\n';
                    await maybeEdit(false);
                  } else if (evt.type === 'image_data') {
                    collectedImages.push(evt.image);
                  }
                } else {
                  // Flat mode: existing behavior unchanged.
                  if (evt.type === 'text_final') {
                    hadTextFinal = true;
                    finalText = evt.text;
                    await maybeEdit(true);
                  } else if (evt.type === 'error') {
                    invokeHadError = true;
                    invokeErrorMessage = evt.message;
                    finalText = abortSignal.aborted
                      ? '*(Response aborted.)*'
                      : mapRuntimeErrorToUserMessage(evt.message);
                    await maybeEdit(true);
                    if (!abortSignal.aborted) {
                      // eslint-disable-next-line @typescript-eslint/no-floating-promises
                      statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
                      params.log?.warn({ flow: 'message', sessionKey, error: evt.message }, 'obs.invoke.error');
                    }
                  } else if (evt.type === 'text_delta') {
                    deltaText += evt.text;
                    await maybeEdit(false);
                  } else if (evt.type === 'log_line') {
                    const prefix = evt.stream === 'stderr' ? '[stderr] ' : '[stdout] ';
                    deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + prefix + evt.line + '\n';
                    await maybeEdit(false);
                  } else if (evt.type === 'image_data') {
                    collectedImages.push(evt.image);
                  }
                }
              }
            } finally {
              clearInterval(keepalive);
              taq?.dispose();
              // Drain all queued streaming edits so they settle before final output.
              try { await streamEditQueue; } catch { /* ignore */ }
              streamEditQueue = Promise.resolve();
            }
            metrics.recordInvokeResult('message', Date.now() - t0, !invokeHadError, invokeErrorMessage);
            params.log?.info(
              { flow: 'message', sessionKey, followUpDepth, ms: Date.now() - t0, ok: !invokeHadError },
              'obs.invoke.end',
            );
            if (followUpDepth > 0) {
              params.log?.info({ sessionKey, followUpDepth, ms: Date.now() - t0 }, 'followup:end');
            } else {
              params.log?.info({ sessionKey, sessionId, ms: Date.now() - t0 }, 'invoke:end');
            }
            processedText = finalText || deltaText || (collectedImages.length > 0 ? '' : '(no output)');
            let actions: { type: string }[] = [];
            let actionResults: DiscordActionResult[] = [];
            let strippedUnrecognizedTypes: string[] = [];
            // Gate action execution on successful stream completion — do not execute
            // actions against partial or error output, which could cause side effects
            // based on incomplete model responses.  Relax the hadTextFinal requirement
            // when the stream completed without error — some runtime modes (long-running
            // process, tool-aware queue timing) may deliver complete text via deltaText
            // without a discrete text_final event.
            const streamCompletedForActions = !invokeHadError && !abortSignal.aborted;
            if (!hadTextFinal && streamCompletedForActions && processedText.includes('<discord-action>')) {
              params.log?.warn(
                { flow: 'message', sessionKey, textLen: processedText.length },
                'discord:action fallback — hadTextFinal=false but text contains action markers',
              );
            }
            const canParseActions = streamCompletedForActions
              && (hadTextFinal || processedText.includes('<discord-action>'));
            if (params.discordActionsEnabled && msg.guild && canParseActions) {
              const parsed = parseDiscordActions(processedText, actionFlags);
              if (parsed.actions.length > 0) {
                actions = parsed.actions;
                strippedUnrecognizedTypes = parsed.strippedUnrecognizedTypes;
                const actCtx = {
                  guild: msg.guild,
                  client: msg.client,
                  channelId: msg.channelId,
                  messageId: msg.id,
                  threadParentId,
                  deferScheduler: params.deferScheduler,
                  confirmation: {
                    mode: 'interactive' as const,
                    sessionKey,
                    userId: msg.author.id,
                  },
                };
                // Construct per-message memoryCtx with real user ID and Discord metadata.
                const perMessageMemoryCtx = params.memoryCtx ? {
                  ...params.memoryCtx,
                  userId: msg.author.id,
                  channelId: msg.channelId,
                  messageId: msg.id,
                  guildId: msg.guildId ?? undefined,
                  channelName: (msg.channel as any)?.name ?? undefined,
                } : undefined;
                actionResults = await executeDiscordActions(parsed.actions, actCtx, params.log, {
                  taskCtx: params.taskCtx,
                  cronCtx: params.cronCtx,
                  forgeCtx: params.forgeCtx,
                  planCtx: params.planCtx,
                  memoryCtx: perMessageMemoryCtx,
                  configCtx: params.configCtx,
                });
                for (const result of actionResults) {
                  metrics.recordActionResult(result.ok);
                  params.log?.info(
                    { flow: 'message', sessionKey, ok: result.ok },
                    'obs.action.result',
                  );
                }
                const displayLines = buildDisplayResultLines(actions, actionResults);
                const anyActionSucceeded = actionResults.some((r) => r.ok);
                processedText = displayLines.length > 0
                  ? parsed.cleanText.trimEnd() + '\n\n' + displayLines.join('\n')
                  : parsed.cleanText.trimEnd();
                // When all display lines were suppressed (e.g. sendMessage-only) and there's
                // no prose, delete the placeholder instead of posting "(no output)".
                if (
                  !processedText.trim()
                  && anyActionSucceeded
                  && collectedImages.length === 0
                  && strippedUnrecognizedTypes.length === 0
                ) {
                  try { await reply.delete(); } catch { /* ignore */ }
                  replyFinalized = true;
                  params.log?.info({ sessionKey }, 'discord:reply suppressed (actions-only, no display text)');
                  break;
                }
                if (statusRef?.current) {
                  for (let i = 0; i < actionResults.length; i++) {
                    const r = actionResults[i];
                    if (!r.ok) {
                      // eslint-disable-next-line @typescript-eslint/no-floating-promises
                      statusRef.current.actionFailed(actions[i].type, r.error);
                    }
                  }
                }
              } else {
                processedText = parsed.cleanText;
                strippedUnrecognizedTypes = parsed.strippedUnrecognizedTypes;
              }
            }
            processedText = appendUnavailableActionTypesNotice(processedText, strippedUnrecognizedTypes);

            // Suppression: if a follow-up response is trivially short and has no further
            // actions, suppress it to avoid posting empty messages like "Got it."
            // Skip suppression when images are present, or when unrecognized action blocks
            // were stripped (the AI tried to act — the user must see "(no output)").
            if (followUpDepth > 0) {
              if (shouldSuppressFollowUp(processedText, actions.length, collectedImages.length, strippedUnrecognizedTypes.length)) {
                const stripped = processedText.replace(/\s+/g, ' ').trim();
                try { await reply.delete(); } catch { /* ignore */ }
                replyFinalized = true;
                params.log?.info({ sessionKey, followUpDepth, chars: stripped.length }, 'followup:suppressed');
                break;
              } else if (strippedUnrecognizedTypes.length > 0 && actions.length === 0 && collectedImages.length === 0) {
                params.log?.info({ sessionKey, followUpDepth, types: strippedUnrecognizedTypes }, 'followup:suppression-bypassed');
              }
            } else if (strippedUnrecognizedTypes.length > 0 && actions.length === 0) {
              params.log?.info({ sessionKey, types: strippedUnrecognizedTypes }, 'discord:unrecognized-action-types-stripped');
            }

            if (!isShuttingDown()) {
              try {
                await editThenSendChunks(reply, msg.channel, processedText, collectedImages);
                replyFinalized = true;
              } catch (editErr: any) {
                // Thread archived by a taskClose action — the close summary was already
                // posted inside closeTaskThread, so the only thing lost is Claude's
                // conversational wrapper ("Done. Closing it out now.").  Swallow gracefully.
                if (editErr?.code === 50083) {
                  params.log?.info({ sessionKey }, 'discord:reply skipped (thread archived by action)');
                  try { await reply.delete(); } catch { /* best-effort cleanup */ }
                  replyFinalized = true;
                } else {
                  throw editErr;
                }
              }
            } else {
              replyFinalized = true;
            }

            // -- auto-follow-up check --
            if (followUpDepth >= params.actionFollowupDepth) break;
            if (actions.length === 0) break;
            const actionTypes = actions.map((a) => a.type);
            if (!hasQueryAction(actionTypes)) break;
            // At least one query action must have succeeded.
            const anyQuerySucceeded = actions.some(
              (a, i) => QUERY_ACTION_TYPES.has(a.type) && actionResults[i]?.ok,
            );
            if (!anyQuerySucceeded) break;

            // Build follow-up prompt with action results.
            const followUpLines = buildAllResultLines(actionResults);
            currentPrompt =
              `[Auto-follow-up] Your previous response included Discord actions. Here are the results:\n\n` +
              followUpLines.join('\n') +
              `\n\nContinue your analysis based on these results. If you need additional information, you may emit further query actions.`;
            followUpDepth++;
          }

          } catch (innerErr) {
            // Inner catch: attempt to show the error in the reply before the finally
            // block runs dispose(). Setting replyFinalized = true on success prevents
            // the finally's safety-net delete from removing the error message.
            try {
              if (reply && !isShuttingDown()) {
                await reply.edit({
                  content: abortSignal.aborted
                    ? '*(Response aborted.)*'
                    : mapRuntimeErrorToUserMessage(String(innerErr)),
                  allowedMentions: NO_MENTIONS,
                });
                replyFinalized = true;
              }
            } catch {
              // Ignore secondary errors; outer catch will handle logging.
            }
            throw innerErr;
          } finally {
            // Safety net runs before dispose() so cold-start recovery can still see
            // the in-flight entry if the delete fails.
            if (!replyFinalized && reply && !isShuttingDown()) {
              try { await reply.delete(); } catch { /* best-effort */ }
            }
            abortDispose();
            // Best-effort: remove the 🛑 reaction added at stream start.
            try { await (reply as any)?.reactions?.resolve?.('🛑')?.remove?.(); } catch { /* best-effort */ }
            dispose();
          }

          if (params.summaryEnabled) {
            const count = (turnCounters.get(sessionKey) ?? 0) + 1;
            turnCounters.set(sessionKey, count);

            if (count >= params.summaryEveryNTurns) {
              turnCounters.set(sessionKey, 0);
              const summarySeq = (latestSummarySequence.get(sessionKey) ?? 0) + 1;
              latestSummarySequence.set(sessionKey, summarySeq);
              let taskStatusContext: string | undefined;
              if (params.taskCtx?.store) {
                const activeTasks = params.taskCtx.store.list();
                const RECENT_CLOSED_WINDOW_MS = 6 * 60 * 60 * 1000;
                const nowMs = Date.now();
                const recentlyClosed = params.taskCtx.store
                  .list({ status: 'closed' })
                  .filter((t) => {
                    const closedAt = t.closed_at ? new Date(t.closed_at).getTime() : 0;
                    return nowMs - closedAt < RECENT_CLOSED_WINDOW_MS;
                  });
                const TASK_SNAPSHOT_LIMIT = 500;
                const CLOSED_SNAPSHOT_LIMIT = 200;
                const TRUNCATION_TRAILER = '(list truncated — only reconcile tasks explicitly listed above)';
                const activeLines: string[] = [];
                let activeTotalLen = 0;
                let activeTruncated = false;
                for (const t of activeTasks) {
                  const line = `${t.id}: ${t.status}, "${t.title}"`;
                  if (activeTotalLen + line.length + 1 > TASK_SNAPSHOT_LIMIT) {
                    activeTruncated = true;
                    break;
                  }
                  activeLines.push(line);
                  activeTotalLen += line.length + 1;
                }
                const parts: string[] = [];
                if (activeLines.length > 0) {
                  parts.push(activeLines.join('\n') + (activeTruncated ? '\n' + TRUNCATION_TRAILER : ''));
                } else {
                  parts.push('No active tasks.');
                }
                if (recentlyClosed.length > 0) {
                  const closedLines: string[] = [];
                  let closedLen = 0;
                  let closedTruncated = false;
                  for (const t of recentlyClosed) {
                    const line = `${t.id}: closed, "${t.title}"`;
                    if (closedLen + line.length + 1 > CLOSED_SNAPSHOT_LIMIT) {
                      closedTruncated = true;
                      break;
                    }
                    closedLines.push(line);
                    closedLen += line.length + 1;
                  }
                  parts.push(
                    'Recently closed:\n' +
                      closedLines.join('\n') +
                      (closedTruncated ? '\n(more closed tasks not shown)' : ''),
                  );
                }
                taskStatusContext = parts.join('\n');
              }
              pendingSummaryWork = {
                summarySeq,
                existingSummary: summarySection || null,
                exchange:
                  (historySection ? historySection + '\n' : '') +
                  `[${msg.author.displayName || msg.author.username}]: ${msg.content}\n` +
                  `[${params.botDisplayName}]: ${(processedText || '').slice(0, 500)}`,
                ...(taskStatusContext !== undefined ? { taskStatusContext } : {}),
              };
            } else if (summarySection) {
              // Persist counter progress so restarts resume from last known count.
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              saveSummary(params.summaryDataDir, sessionKey, {
                summary: summarySection,
                updatedAt: Date.now(),
                turnsSinceUpdate: count,
              });
            }
          }

          // Stage short-term memory append for fire-and-forget after queue.
          if (params.shortTermMemoryEnabled && !isDm && msg.guildId && msg.guild) {
            const ch: any = msg.channel as any;
            if (isChannelPublic(ch, msg.guild)) {
              pendingShortTermAppend = {
                userContent: String(msg.content ?? ''),
                botResponse: (processedText || '').slice(0, 300),
                channelName: String(ch?.name ?? ch?.parent?.name ?? msg.channelId),
                channelId: msg.channelId,
              };
            }
          }
        } catch (err) {
          metrics.increment('discord.handler.error');
          params.log?.error({ err, sessionKey }, 'discord:handler failed');
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          statusRef?.current?.handlerError({ sessionKey }, err);
          try {
            if (!abortSignal?.aborted && reply && !isShuttingDown()) {
              await reply.edit({
                content: mapRuntimeErrorToUserMessage(String(err)),
                allowedMentions: NO_MENTIONS,
              });
            }
          } catch {
            // Ignore secondary errors writing to Discord.
          }
        }
      });

      // Fire-and-forget: run summary generation outside the queue so it doesn't
      // block the next message for this session key (fast-tier can take several seconds).
      if (pendingSummaryWork) {
        const work = pendingSummaryWork;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        summaryWorkQueue.run(sessionKey, async () => {
          if (latestSummarySequence.get(sessionKey) !== work.summarySeq) return;

          const newSummary = await generateSummary(params.runtime, {
            previousSummary: work.existingSummary,
            recentExchange: work.exchange,
            model: resolveModel(params.summaryModel, params.runtime.id),
            cwd: params.workspaceCwd,
            maxChars: params.summaryMaxChars,
            timeoutMs: 30_000,
            ...(work.taskStatusContext !== undefined ? { taskStatusContext: work.taskStatusContext } : {}),
          });

          if (latestSummarySequence.get(sessionKey) !== work.summarySeq) return;

          await saveSummary(params.summaryDataDir, sessionKey, {
            summary: newSummary,
            updatedAt: Date.now(),
            turnsSinceUpdate: 0,
          });

          if (params.summaryToDurableEnabled) {
            const ch: any = msg.channel as any;
            await applyUserTurnToDurable({
              runtime: params.runtime,
              userMessageText: String(msg.content ?? ''),
              userId: msg.author.id,
              durableDataDir: params.durableDataDir,
              durableMaxItems: params.durableMaxItems,
              model: resolveModel(params.summaryModel, params.runtime.id),
              cwd: params.workspaceCwd,
              channelId: msg.channelId,
              messageId: msg.id,
              guildId: msg.guildId ?? undefined,
              channelName: String(ch?.name ?? '') || undefined,
            });
          }
        })
          .catch((err) => {
            params.log?.warn({ err, sessionKey }, 'discord:summary/durable-extraction failed');
          });
      }

      // Fire-and-forget: record short-term memory entry (cross-channel awareness).
      if (pendingShortTermAppend) {
        const stWork = pendingShortTermAppend;
        const guildUserId = `${msg.guildId}-${msg.author.id}`;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        appendEntry(
          params.shortTermDataDir,
          guildUserId,
          {
            timestamp: Date.now(),
            sessionKey,
            channelId: stWork.channelId,
            channelName: stWork.channelName,
            summary: buildExcerptSummary(stWork.userContent, stWork.botResponse),
          },
          {
            maxEntries: params.shortTermMaxEntries,
            maxAgeMs: params.shortTermMaxAgeMs,
          },
        ).catch((err) => {
          params.log?.warn({ err, sessionKey }, 'discord:short-term memory append failed');
        });
      }
    } catch (err) {
      const metrics = params.metrics ?? globalMetrics;
      metrics.increment('discord.message.handler_wrapper_error');
      params.log?.error({ err }, 'discord:messageCreate failed');
    }
  };
}
