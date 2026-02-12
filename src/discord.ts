import fs from 'node:fs/promises';
import path from 'node:path';
import { ActivityType, Client, GatewayIntentBits, Partials } from 'discord.js';
import type { PresenceData } from 'discord.js';
import type { RuntimeAdapter, ImageData } from './runtime/types.js';
import { MAX_IMAGES_PER_INVOCATION } from './runtime/types.js';
import type { SessionManager } from './sessions.js';
import { isAllowlisted } from './discord/allowlist.js';
import { KeyedQueue } from './group-queue.js';
import type { DiscordChannelContext } from './discord/channel-context.js';
import { ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './discord/channel-context.js';
import { discordSessionKey } from './discord/session-key.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection } from './discord/actions.js';
import type { ActionCategoryFlags, DiscordActionResult } from './discord/actions.js';
import { hasQueryAction, QUERY_ACTION_TYPES } from './discord/action-categories.js';
import type { BeadContext } from './discord/actions-beads.js';
import type { CronContext } from './discord/actions-crons.js';
import type { LoggerLike } from './discord/action-types.js';
import { ACTIVITY_TYPE_MAP } from './discord/actions-bot-profile.js';
import { fetchMessageHistory } from './discord/message-history.js';
import { loadSummary, saveSummary, generateSummary } from './discord/summarizer.js';
import { parseMemoryCommand, handleMemoryCommand } from './discord/memory-commands.js';
import { parsePlanCommand, handlePlanCommand } from './discord/plan-commands.js';
import { parseForgeCommand, ForgeOrchestrator } from './discord/forge-commands.js';
import type { ForgeOrchestratorOpts } from './discord/forge-commands.js';
import { applyUserTurnToDurable } from './discord/user-turn-to-durable.js';
import type { StatusPoster } from './discord/status-channel.js';
import { createStatusPoster } from './discord/status-channel.js';
import { ToolAwareQueue } from './discord/tool-aware-queue.js';
import { ensureSystemScaffold, selectBootstrapGuild } from './discord/system-bootstrap.js';
import type { SystemScaffold } from './discord/system-bootstrap.js';
import { NO_MENTIONS } from './discord/allowed-mentions.js';
import { registerInFlightReply, isShuttingDown } from './discord/inflight-replies.js';
import { createReactionAddHandler, createReactionRemoveHandler } from './discord/reaction-handler.js';
import { splitDiscord, truncateCodeBlocks, renderDiscordTail, renderActivityTail, formatBoldLabel, thinkingLabel, selectStreamingOutput } from './discord/output-utils.js';
import { buildContextFiles, inlineContextFiles, buildDurableMemorySection, buildShortTermMemorySection, buildBeadThreadSection, loadWorkspacePaFiles, loadWorkspaceMemoryFile, loadDailyLogFiles, resolveEffectiveTools } from './discord/prompt-common.js';
import { isChannelPublic, appendEntry, buildExcerptSummary } from './discord/shortterm-memory.js';
import { editThenSendChunks } from './discord/output-common.js';
import { downloadMessageImages, resolveMediaType } from './discord/image-download.js';
import { resolveReplyReference } from './discord/reply-reference.js';
import { downloadTextAttachments } from './discord/file-download.js';
import { messageContentIntentHint, mapRuntimeErrorToUserMessage } from './discord/user-errors.js';
import { parseHealthCommand, renderHealthReport, renderHealthToolsReport } from './discord/health-command.js';
import { parseRestartCommand, handleRestartCommand } from './discord/restart-command.js';
import type { HealthConfigSnapshot } from './discord/health-command.js';
import type { MetricsRegistry } from './observability/metrics.js';
import { globalMetrics } from './observability/metrics.js';

export type BotParams = {
  token: string;
  allowUserIds: Set<string>;
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
  discordActionsBeads: boolean;
  discordActionsCrons?: boolean;
  discordActionsBotProfile?: boolean;
  beadCtx?: BeadContext;
  cronCtx?: CronContext;
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
  forgeCommandsEnabled?: boolean;
  forgeMaxAuditRounds?: number;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  forgeTimeoutMs?: number;
  forgeProgressThrottleMs?: number;
  summaryToDurableEnabled: boolean;
  shortTermMemoryEnabled: boolean;
  shortTermDataDir: string;
  shortTermMaxEntries: number;
  shortTermMaxAgeMs: number;
  shortTermInjectMaxChars: number;
  statusChannel?: string;
  bootstrapEnsureBeadsForum?: boolean;
  toolAwareStreaming?: boolean;
  streamStallWarningMs: number;
  actionFollowupDepth: number;
  reactionHandlerEnabled: boolean;
  reactionRemoveHandlerEnabled: boolean;
  reactionMaxAgeMs: number;
  healthCommandsEnabled?: boolean;
  healthVerboseAllowlist?: Set<string>;
  healthConfigSnapshot?: HealthConfigSnapshot;
  metrics?: MetricsRegistry;
  botStatus?: 'online' | 'idle' | 'dnd' | 'invisible';
  botActivity?: string;
  botActivityType?: 'Playing' | 'Listening' | 'Watching' | 'Competing' | 'Custom';
  botAvatar?: string;
  appendSystemPrompt?: string;
  existingCronsId?: string;
  existingBeadsId?: string;
};

type QueueLike = Pick<KeyedQueue, 'run'> & { size?: () => number };

const turnCounters = new Map<string, number>();

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

export { splitDiscord, truncateCodeBlocks, renderDiscordTail, renderActivityTail, formatBoldLabel, thinkingLabel, selectStreamingOutput };

export type StatusRef = { current: StatusPoster | null };

export function createMessageCreateHandler(params: Omit<BotParams, 'token'>, queue: QueueLike, statusRef?: StatusRef) {
  // Global forge orchestrator — one forge at a time across all channels.
  let forgeOrchestrator: ForgeOrchestrator | null = null;

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

      const actionFlags: ActionCategoryFlags = {
        channels: params.discordActionsChannels,
        messaging: params.discordActionsMessaging,
        guild: params.discordActionsGuild,
        moderation: params.discordActionsModeration,
        polls: params.discordActionsPolls,
        beads: params.discordActionsBeads,
        crons: params.discordActionsCrons ?? false,
        botProfile: params.discordActionsBotProfile ?? false,
      };

      const isDm = msg.guildId == null;
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

      const healthMode = (params.healthCommandsEnabled ?? true)
        ? parseHealthCommand(String(msg.content ?? ''))
        : null;
      if (healthMode) {
        if (healthMode === 'tools') {
          const liveTools = await resolveEffectiveTools({
            workspaceCwd: params.workspaceCwd,
            runtimeTools: params.runtimeTools,
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
        // Kept for type safety; beadsEnabled/beadsActive may disagree with actual state.
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
          beadsEnabled: Boolean(params.beadCtx),
          beadsActive: Boolean(params.beadCtx),
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

      // Handle !restart commands before queue/session — this is a system command.
      const restartCmd = parseRestartCommand(String(msg.content ?? ''));
      if (restartCmd) {
        const result = await handleRestartCommand(restartCmd, params.log);
        await msg.reply({ content: result.reply, allowedMentions: NO_MENTIONS });
        // Deferred action (e.g., restart) runs after the reply is sent.
        // The process will likely die during this call.
        result.deferred?.();
        return;
      }

      const isThread = typeof (msg.channel as any)?.isThread === 'function' ? (msg.channel as any).isThread() : false;
      const threadId = isThread ? String((msg.channel as any).id ?? '') : null;
      const threadParentId = isThread ? String((msg.channel as any).parentId ?? '') : null;
      const sessionKey = discordSessionKey({
        channelId: msg.channelId,
        authorId: msg.author.id,
        isDm,
        threadId: threadId || null,
      });

      type SummaryWork = { existingSummary: string | null; exchange: string };
      let pendingSummaryWork: SummaryWork | null = null as SummaryWork | null;
      type ShortTermAppend = { userContent: string; botResponse: string; channelName: string; channelId: string };
      let pendingShortTermAppend: ShortTermAppend | null = null as ShortTermAppend | null;

      await queue.run(sessionKey, async () => {
        let reply: any = null;
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
              await msg.reply({ content: response, allowedMentions: NO_MENTIONS });
              return;
            }
          }

          // Handle !plan commands before session creation.
          if (params.planCommandsEnabled) {
            const planCmd = parsePlanCommand(String(msg.content ?? ''));
            if (planCmd) {
              const response = await handlePlanCommand(planCmd, {
                workspaceCwd: params.workspaceCwd,
                beadsCwd: params.beadCtx?.beadsCwd ?? params.workspaceCwd,
              });
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
                const running = forgeOrchestrator?.isRunning ?? false;
                await msg.reply({
                  content: running ? 'A forge is currently running.' : 'No forge running.',
                  allowedMentions: NO_MENTIONS,
                });
                return;
              }

              if (forgeCmd.action === 'cancel') {
                if (forgeOrchestrator?.isRunning) {
                  forgeOrchestrator.requestCancel();
                  await msg.reply({ content: 'Forge cancel requested.', allowedMentions: NO_MENTIONS });
                } else {
                  await msg.reply({ content: 'No forge running to cancel.', allowedMentions: NO_MENTIONS });
                }
                return;
              }

              // action === 'create'
              if (forgeOrchestrator?.isRunning) {
                await msg.reply({
                  content: 'A forge is already running. Use `!forge cancel` to stop it first.',
                  allowedMentions: NO_MENTIONS,
                });
                return;
              }

              const plansDir = path.join(params.workspaceCwd, 'plans');
              forgeOrchestrator = new ForgeOrchestrator({
                runtime: params.runtime,
                model: params.runtimeModel,
                cwd: params.workspaceCwd,
                workspaceCwd: params.workspaceCwd,
                beadsCwd: params.beadCtx?.beadsCwd ?? params.workspaceCwd,
                plansDir,
                maxAuditRounds: params.forgeMaxAuditRounds ?? 5,
                progressThrottleMs: params.forgeProgressThrottleMs ?? 3000,
                timeoutMs: params.forgeTimeoutMs ?? 5 * 60_000,
                drafterModel: params.forgeDrafterModel,
                auditorModel: params.forgeAuditorModel,
                log: params.log,
              });

              // Send initial progress message
              const progressReply = await msg.reply({
                content: `Starting forge: ${forgeCmd.args}`,
                allowedMentions: NO_MENTIONS,
              });

              // Throttle state for progress edits
              let lastEditAt = 0;
              const throttleMs = params.forgeProgressThrottleMs ?? 3000;
              let progressMessageGone = false;

              const onProgress = async (progressMsg: string, opts?: { force?: boolean }) => {
                if (progressMessageGone) return;
                const now = Date.now();
                if (!opts?.force && now - lastEditAt < throttleMs) return;
                lastEditAt = now;
                try {
                  await progressReply.edit({ content: progressMsg, allowedMentions: NO_MENTIONS });
                } catch (editErr: any) {
                  if (editErr?.code === 10008) {
                    progressMessageGone = true;
                  }
                }
              };

              // Run forge in the background — don't block the queue
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              forgeOrchestrator.run(forgeCmd.args, onProgress).then(
                async (result) => {
                  if (progressMessageGone) {
                    try {
                      const statusMsg = result.error
                        ? `Forge failed: ${result.error}`
                        : `Forge complete. Plan **${result.planId}** ready for review (${result.rounds} round${result.rounds > 1 ? 's' : ''}).`;
                      await msg.channel.send({ content: statusMsg, allowedMentions: NO_MENTIONS });
                    } catch {
                      // best-effort
                    }
                  }
                  // Send plan summary as a follow-up message
                  if (result.planSummary && !result.error) {
                    try {
                      await msg.channel.send({ content: result.planSummary, allowedMentions: NO_MENTIONS });
                    } catch {
                      // best-effort
                    }
                  }
                },
                async (err) => {
                  params.log?.error({ err }, 'forge:unhandled error');
                  try {
                    const errMsg = `Forge crashed: ${String(err)}`;
                    if (progressMessageGone) {
                      await msg.channel.send({ content: errMsg, allowedMentions: NO_MENTIONS });
                    } else {
                      await progressReply.edit({ content: errMsg, allowedMentions: NO_MENTIONS });
                    }
                  } catch {
                    // best-effort
                  }
                },
              );

              return;
            }
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

          let historySection = '';
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

          let summarySection = '';
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

          const [durableSection, shortTermSection, beadSection, replyRef] = await Promise.all([
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
            buildBeadThreadSection({
              isThread,
              threadId,
              threadParentId,
              beadCtx: params.beadCtx,
              log: params.log,
            }),
            resolveReplyReference(msg, params.botDisplayName, params.log),
          ]);

          const inlinedContext = await inlineContextFiles(
            contextFiles,
            { required: new Set(params.discordChannelContext?.paContextFiles ?? []) },
          );

          let prompt =
            (inlinedContext
              ? inlinedContext + '\n\n'
              : '') +
            (beadSection
              ? `---\n${beadSection}\n\n`
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
            log: params.log,
          });
          const effectiveTools = tools.effectiveTools;
          if (tools.permissionNote) {
            prompt += `\n\n---\nPermission note: ${tools.permissionNote}\n`;
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
          let processedText = '';

          // Track this reply for graceful shutdown cleanup.
          let dispose = registerInFlightReply(reply, msg.channelId, reply.id, `message:${msg.channelId}`);
          try {

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

            // On follow-up iterations, send a new placeholder message.
            if (followUpDepth > 0) {
              dispose();
              reply = await msg.channel.send({ content: formatBoldLabel('(following up...)'), allowedMentions: NO_MENTIONS });
              dispose = registerInFlightReply(reply, msg.channelId, reply.id, `message:${msg.channelId}:followup-${followUpDepth}`);
              params.log?.info({ sessionKey, followUpDepth }, 'followup:start');
            }

            const maybeEdit = async (force = false) => {
              if (!reply) return;
              if (isShuttingDown()) return;
              const now = Date.now();
              if (!force && now - lastEditAt < minEditIntervalMs) return;
              lastEditAt = now;
              const out = selectStreamingOutput({ deltaText, activityLabel, finalText, statusTick: statusTick++, showPreview: Date.now() - t0 >= 7000 });
              try {
                await reply.edit({ content: out, allowedMentions: NO_MENTIONS });
              } catch {
                // Ignore Discord edit errors during streaming.
              }
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

            for await (const evt of params.runtime.invoke({
              prompt: currentPrompt,
              model: params.runtimeModel,
              cwd,
              addDirs: addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined,
              sessionId,
              sessionKey,
              tools: effectiveTools,
              timeoutMs: params.runtimeTimeoutMs,
              // Images only on initial turn — follow-ups are text-only continuations
              // with action results; re-downloading would waste time and bandwidth.
              images: followUpDepth === 0 ? inputImages : undefined,
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
                  finalText = mapRuntimeErrorToUserMessage(evt.message);
                  await maybeEdit(true);
                  // eslint-disable-next-line @typescript-eslint/no-floating-promises
                  statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
                  params.log?.warn({ flow: 'message', sessionKey, error: evt.message }, 'obs.invoke.error');
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
                  finalText = evt.text;
                  await maybeEdit(true);
                } else if (evt.type === 'error') {
                  invokeHadError = true;
                  invokeErrorMessage = evt.message;
                  finalText = mapRuntimeErrorToUserMessage(evt.message);
                  await maybeEdit(true);
                  // eslint-disable-next-line @typescript-eslint/no-floating-promises
                  statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
                  params.log?.warn({ flow: 'message', sessionKey, error: evt.message }, 'obs.invoke.error');
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
            taq?.dispose();
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
            clearInterval(keepalive);

            processedText = finalText || deltaText || (collectedImages.length > 0 ? '' : '(no output)');
            let actions: { type: string }[] = [];
            let actionResults: DiscordActionResult[] = [];
            if (params.discordActionsEnabled && msg.guild) {
              const parsed = parseDiscordActions(processedText, actionFlags);
              if (parsed.actions.length > 0) {
                actions = parsed.actions;
                const actCtx = {
                  guild: msg.guild,
                  client: msg.client,
                  channelId: msg.channelId,
                  messageId: msg.id,
                };
                actionResults = await executeDiscordActions(parsed.actions, actCtx, params.log, params.beadCtx, params.cronCtx);
                for (const result of actionResults) {
                  metrics.recordActionResult(result.ok);
                  params.log?.info(
                    { flow: 'message', sessionKey, ok: result.ok },
                    'obs.action.result',
                  );
                }
                const resultLines = actionResults.map((r) => r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`);
                processedText = parsed.cleanText.trimEnd() + '\n\n' + resultLines.join('\n');
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
              }
            }

            // Suppression: if a follow-up response is trivially short and has no further
            // actions, suppress it to avoid posting empty messages like "Got it."
            // Skip suppression when images are present.
            if (followUpDepth > 0 && actions.length === 0 && collectedImages.length === 0) {
              const stripped = processedText.replace(/\s+/g, ' ').trim();
              if (stripped.length < 50) {
                try { await reply.delete(); } catch { /* ignore */ }
                params.log?.info({ sessionKey, followUpDepth, chars: stripped.length }, 'followup:suppressed');
                break;
              }
            }

            if (!isShuttingDown()) {
              try {
                await editThenSendChunks(reply, msg.channel, processedText, collectedImages);
              } catch (editErr: any) {
                // Thread archived by a beadClose action — the close summary was already
                // posted inside closeBeadThread, so the only thing lost is Claude's
                // conversational wrapper ("Done. Closing it out now.").  Swallow gracefully.
                if (editErr?.code === 50083) {
                  params.log?.info({ sessionKey }, 'discord:reply skipped (thread archived by action)');
                  try { await reply.delete(); } catch { /* best-effort cleanup */ }
                } else {
                  throw editErr;
                }
              }
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
            const followUpLines = actionResults.map((r) =>
              r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`,
            );
            currentPrompt =
              `[Auto-follow-up] Your previous response included Discord actions. Here are the results:\n\n` +
              followUpLines.join('\n') +
              `\n\nContinue your analysis based on these results. If you need additional information, you may emit further query actions.`;
            followUpDepth++;
          }

          } finally {
            dispose();
          }

          if (params.summaryEnabled) {
            const count = (turnCounters.get(sessionKey) ?? 0) + 1;
            turnCounters.set(sessionKey, count);

            if (count >= params.summaryEveryNTurns) {
              turnCounters.set(sessionKey, 0);
              pendingSummaryWork = {
                existingSummary: summarySection || null,
                exchange:
                  (historySection ? historySection + '\n' : '') +
                  `[${msg.author.displayName || msg.author.username}]: ${msg.content}\n` +
                  `[${params.botDisplayName}]: ${(processedText || '').slice(0, 500)}`,
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
            if (reply && !isShuttingDown()) {
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
      // block the next message for this session key (Haiku can take several seconds).
      if (pendingSummaryWork) {
        const work = pendingSummaryWork;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        generateSummary(params.runtime, {
          previousSummary: work.existingSummary,
          recentExchange: work.exchange,
          model: params.summaryModel,
          cwd: params.workspaceCwd,
          maxChars: params.summaryMaxChars,
          timeoutMs: 30_000,
        })
          .then((newSummary) =>
            saveSummary(params.summaryDataDir, sessionKey, {
              summary: newSummary,
              updatedAt: Date.now(),
              turnsSinceUpdate: 0,
            }).then(() => {
              if (params.summaryToDurableEnabled) {
                const ch: any = msg.channel as any;
                return applyUserTurnToDurable({
                  runtime: params.runtime,
                  userMessageText: String(msg.content ?? ''),
                  userId: msg.author.id,
                  durableDataDir: params.durableDataDir,
                  durableMaxItems: params.durableMaxItems,
                  model: params.summaryModel,
                  cwd: params.workspaceCwd,
                  channelId: msg.channelId,
                  messageId: msg.id,
                  guildId: msg.guildId ?? undefined,
                  channelName: String(ch?.name ?? '') || undefined,
                });
              }
            }),
          )
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

function resolveStatusChannel(client: Client, nameOrId: string, statusOpts: { botDisplayName?: string; log?: LoggerLike }): StatusPoster | null {
  // Try by ID first, then by name across all guilds.
  const byId = client.channels.cache.get(nameOrId);
  if (byId?.isTextBased() && !byId.isDMBased()) return createStatusPoster(byId, statusOpts);

  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name === nameOrId,
    );
    if (ch && ch.isTextBased()) return createStatusPoster(ch, statusOpts);
  }
  return null;
}

async function resolveStatusChannelById(client: Client, channelId: string, statusOpts: { botDisplayName?: string; log?: LoggerLike }): Promise<StatusPoster | null> {
  const cached = client.channels.cache.get(channelId);
  const ch = cached ?? await client.channels.fetch(channelId).catch(() => null);
  if (ch?.isTextBased() && !ch.isDMBased()) return createStatusPoster(ch as any, statusOpts);
  return null;
}

type GuildForNickname = {
  id: string;
  members: {
    me: { nickname: string | null; user?: { username: string }; setNickname(nick: string, reason?: string): Promise<unknown> } | null;
    fetchMe(): Promise<{ nickname: string | null; user?: { username: string }; setNickname(nick: string, reason?: string): Promise<unknown> }>;
  };
};

export async function setBotNickname(guild: GuildForNickname, nickname: string, log?: LoggerLike): Promise<void> {
  try {
    let me = guild.members?.me;
    if (!me) {
      try {
        me = await guild.members.fetchMe();
      } catch {
        log?.warn({ guildId: guild.id }, 'discord:nickname could not fetch bot member');
        return;
      }
    }
    // Skip if nickname already matches.
    if (me.nickname === nickname) return;
    // Skip if no nickname is set and the username already matches.
    if (me.nickname == null && me.user?.username === nickname) return;

    await me.setNickname(nickname, 'Automatic nickname from bot identity');
    log?.info({ guildId: guild.id, nickname }, 'discord:nickname set');
  } catch (err: any) {
    if (err?.code === 50013) {
      log?.warn({ guildId: guild.id }, 'discord:nickname Missing Permissions — cannot set nickname');
    } else {
      log?.warn({ err, guildId: guild.id }, 'discord:nickname failed to set');
    }
  }
}

export async function startDiscordBot(params: BotParams): Promise<{ client: Client; status: StatusPoster | null; system: SystemScaffold | null }> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      ...((params.reactionHandlerEnabled || params.reactionRemoveHandlerEnabled) ? [GatewayIntentBits.GuildMessageReactions] : []),
    ],
    partials: [
      Partials.Channel,
      ...((params.reactionHandlerEnabled || params.reactionRemoveHandlerEnabled) ? [Partials.Message, Partials.Reaction, Partials.User] : []),
    ],
  });

  // Mutable ref: handler captures this at registration time, but dereferences
  // .current at call time so we can set it after the ready event.
  const statusRef: StatusRef = { current: null };

  const queue = new KeyedQueue();
  client.on('messageCreate', createMessageCreateHandler(params, queue, statusRef));

  if (params.reactionHandlerEnabled) {
    client.on('messageReactionAdd', createReactionAddHandler(params, queue, statusRef));
  }

  if (params.reactionRemoveHandlerEnabled) {
    client.on('messageReactionRemove', createReactionRemoveHandler(params, queue, statusRef));
  }

  if (params.autoJoinThreads) {
    client.on('threadCreate', async (thread: any) => {
      const joinable = typeof thread?.joinable === 'boolean' ? thread.joinable : true;
      const joined = typeof thread?.joined === 'boolean' ? thread.joined : false;
      if (!joinable || joined || typeof thread?.join !== 'function') return;
      try {
        await thread.join();
        params.log?.info(
          { threadId: String(thread.id ?? ''), parentId: String(thread.parentId ?? '') },
          'discord:thread joined (threadCreate)',
        );
      } catch (err) {
        params.log?.warn({ err, threadId: String(thread?.id ?? '') }, 'discord:thread failed to join (threadCreate)');
      }
    });
  }

  client.on('guildCreate', async (guild: any) => {
    await setBotNickname(guild, params.botDisplayName, params.log);
  });

  await client.login(params.token);

  // Wait for cache to be ready before resolving the status channel.
  await new Promise<void>((resolve) => {
    if (client.isReady()) {
      resolve();
    } else {
      client.once('ready', () => resolve());
    }
  });

  // Ensure "System" category scaffold (status/crons/beads) in a single target guild.
  let system: SystemScaffold | null = null;
  try {
    const guild = selectBootstrapGuild(client, params.guildId, params.log);
    if (guild) {
      system = await ensureSystemScaffold(
        { guild, ensureBeads: Boolean(params.bootstrapEnsureBeadsForum), botDisplayName: params.botDisplayName, existingCronsId: params.existingCronsId, existingBeadsId: params.existingBeadsId },
        params.log,
      );
    }
  } catch (err) {
    params.log?.warn({ err }, 'system-bootstrap: failed; continuing without scaffold');
    system = null;
  }

  // Set bot nickname in all guilds.
  for (const guild of client.guilds.cache.values()) {
    await setBotNickname(guild, params.botDisplayName, params.log);
  }

  // Set bot presence (status + activity) on startup.
  if (params.botStatus || params.botActivity) {
    try {
      const presenceData: PresenceData = {};
      if (params.botStatus) {
        presenceData.status = params.botStatus;
      }
      if (params.botActivity) {
        const typeName = params.botActivityType ?? 'Playing';
        const typeNum = ACTIVITY_TYPE_MAP[typeName] ?? ActivityType.Playing;
        if (typeName === 'Custom') {
          presenceData.activities = [{ name: 'Custom Status', type: ActivityType.Custom, state: params.botActivity }];
        } else {
          presenceData.activities = [{ name: params.botActivity, type: typeNum }];
        }
      }
      client.user!.setPresence(presenceData);
      params.log?.info({ status: params.botStatus, activity: params.botActivity, activityType: params.botActivityType }, 'discord:presence set');
    } catch (err) {
      params.log?.warn({ err }, 'discord:presence failed to set');
    }
  }

  // Set bot avatar on startup (rate-limited — applied once).
  if (params.botAvatar) {
    try {
      if (params.botAvatar.startsWith('http://') || params.botAvatar.startsWith('https://')) {
        await client.user!.setAvatar(params.botAvatar);
      } else {
        const buf = await fs.readFile(params.botAvatar);
        await client.user!.setAvatar(buf);
      }
      params.log?.info({ avatar: params.botAvatar }, 'discord:avatar set');
    } catch (err) {
      params.log?.warn({ err, avatar: params.botAvatar }, 'discord:avatar failed to set');
    }
  }

  if (params.statusChannel) {
    statusRef.current = resolveStatusChannel(client, params.statusChannel, { botDisplayName: params.botDisplayName, log: params.log });
    if (statusRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      statusRef.current.online();
    } else {
      params.log?.warn({ statusChannel: params.statusChannel }, 'status-channel: channel not found, status posting disabled');
    }
  } else if (system?.statusChannelId) {
    statusRef.current = await resolveStatusChannelById(client, system.statusChannelId, { botDisplayName: params.botDisplayName, log: params.log });
    if (statusRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      statusRef.current.online();
    } else {
      params.log?.warn({ statusChannelId: system.statusChannelId }, 'status-channel: bootstrapped channel not found, status posting disabled');
    }
  }

  return { client, status: statusRef.current, system };
}
