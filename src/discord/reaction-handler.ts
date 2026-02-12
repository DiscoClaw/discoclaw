import type { MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js';
import type { ImageData } from '../runtime/types.js';
import type { BotParams, StatusRef } from '../discord.js';
import { ensureGroupDir } from '../discord.js';
import type { KeyedQueue } from '../group-queue.js';
import { isAllowlisted } from './allowlist.js';
import { discordSessionKey } from './session-key.js';
import { ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './channel-context.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection } from './actions.js';
import type { ActionCategoryFlags } from './actions.js';
import { buildContextFiles, inlineContextFiles, buildDurableMemorySection, buildBeadThreadSection, loadWorkspacePaFiles, resolveEffectiveTools } from './prompt-common.js';
import { editThenSendChunks } from './output-common.js';
import { formatBoldLabel, thinkingLabel, selectStreamingOutput } from './output-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { registerInFlightReply, isShuttingDown } from './inflight-replies.js';
import { downloadMessageImages, resolveMediaType } from './image-download.js';
import { downloadTextAttachments } from './file-download.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { globalMetrics } from '../observability/metrics.js';

type QueueLike = Pick<KeyedQueue, 'run'> & { size?: () => number };

export type ReactionMode = 'add' | 'remove';

export function reactionPromptText(mode: ReactionMode): {
  eventLine: (reactingUser: string, userId: string, emoji: string, channelLabel: string) => string;
  guidanceLine: string;
} {
  if (mode === 'add') {
    return {
      eventLine: (reactingUser, userId, emoji, channelLabel) =>
        `${reactingUser} (ID: ${userId}) reacted with ${emoji} to a message in ${channelLabel}.`,
      guidanceLine: 'Respond based on your identity and context. The reaction signals the user wants you to engage with this message. Your response will be posted as a reply.',
    };
  }
  return {
    eventLine: (reactingUser, userId, emoji, channelLabel) =>
      `${reactingUser} (ID: ${userId}) removed their ${emoji} reaction from a message in ${channelLabel}.`,
    guidanceLine: 'Respond based on your identity and context. The user removed a reaction, which may signal a change of intent or retraction. Your response will be posted as a reply.',
  };
}

function createReactionHandler(
  mode: ReactionMode,
  params: Omit<BotParams, 'token'>,
  queue: QueueLike,
  statusRef?: StatusRef,
): (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => Promise<void> {
  const promptText = reactionPromptText(mode);
  const logPrefix = mode === 'add' ? 'reaction' : 'reaction-remove';
  const receivedMetric = mode === 'add' ? 'discord.reaction.received' : 'discord.reaction_remove.received';
  const handlerErrorMetric = mode === 'add' ? 'discord.reaction.handler_error' : 'discord.reaction_remove.handler_error';
  const wrapperErrorMetric = mode === 'add' ? 'discord.reaction.handler_wrapper_error' : 'discord.reaction_remove.handler_wrapper_error';
  const eventLabel = mode === 'add' ? 'messageReactionAdd' : 'messageReactionRemove';

  return async (reaction, user) => {
    try {
      const metrics = params.metrics ?? globalMetrics;
      metrics.increment(receivedMetric);

      // 1. Self-reaction guard — prevent infinite loops from bot's own reactions.
      if (user.id === reaction.message.client.user?.id) return;

      // 2. Fetch partials.
      try {
        if (reaction.partial) await reaction.fetch();
      } catch (err) {
        params.log?.warn({ err }, `${logPrefix}:partial fetch failed (reaction)`);
        return;
      }
      try {
        if (reaction.message.partial) await reaction.message.fetch();
      } catch (err) {
        params.log?.warn({ err }, `${logPrefix}:partial fetch failed (message)`);
        return;
      }

      // 3. Guild-only — skip DM reactions.
      if (reaction.message.guildId == null) return;

      // 4. Staleness guard.
      const msgTimestamp = reaction.message.createdTimestamp;
      if (msgTimestamp && params.reactionMaxAgeMs > 0) {
        const age = Date.now() - msgTimestamp;
        if (age > params.reactionMaxAgeMs) return;
      }

      // 5. Allowlist check.
      if (!isAllowlisted(params.allowUserIds, user.id)) return;

      // Resolve channel/thread info once, used by guards and the queue callback.
      const ch: any = reaction.message.channel as any;
      const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false;
      const threadId = isThread ? String(ch.id ?? '') : null;
      const threadParentId = isThread ? String(ch.parentId ?? '') : null;

      // 6. Channel restriction.
      if (params.allowChannelIds) {
        const parentId = isThread ? String(ch.parentId ?? '') : '';
        const allowed =
          params.allowChannelIds.has(reaction.message.channelId) ||
          (parentId && params.allowChannelIds.has(parentId));
        if (!allowed) return;
      }

      // 7. Session key.
      const sessionKey = discordSessionKey({
        channelId: reaction.message.channelId,
        authorId: user.id,
        isDm: false,
        threadId: threadId || null,
      });

      // 8. Queue.
      await queue.run(sessionKey, async () => {
        const msg = reaction.message;
        let reply: { edit: (opts: any) => Promise<unknown> } | null = null;
        try {
          // Join thread if needed.
          if (params.autoJoinThreads && isThread) {
            const joinable = typeof ch?.joinable === 'boolean' ? ch.joinable : true;
            const joined = typeof ch?.joined === 'boolean' ? ch.joined : false;
            if (joinable && !joined && typeof ch?.join === 'function') {
              try {
                await ch.join();
                params.log?.info({ threadId: String(ch.id ?? ''), parentId: String(ch.parentId ?? '') }, `${logPrefix}:thread joined`);
              } catch (err) {
                params.log?.warn({ err, threadId: String(ch?.id ?? '') }, `${logPrefix}:thread failed to join`);
              }
            }
          }

          reply = await (msg as any).reply({
            content: formatBoldLabel(thinkingLabel(0)),
            allowedMentions: NO_MENTIONS,
          });

          const cwd = params.useGroupDirCwd
            ? await ensureGroupDir(params.groupsDir, sessionKey, params.botDisplayName)
            : params.workspaceCwd;

          // Auto-index channel context.
          if (params.discordChannelContext && params.autoIndexChannelContext) {
            const id = (threadParentId && threadParentId.trim()) ? threadParentId : reaction.message.channelId;
            const chName = String(ch?.name ?? ch?.parent?.name ?? '').trim();
            try {
              await ensureIndexedDiscordChannelContext({
                ctx: params.discordChannelContext,
                channelId: id,
                channelName: chName || undefined,
                log: params.log,
              });
            } catch (err) {
              params.log?.error({ err, channelId: id }, `${logPrefix}:context failed to ensure channel context`);
            }
          }

          const channelCtx = resolveDiscordChannelContext({
            ctx: params.discordChannelContext,
            isDm: false,
            channelId: reaction.message.channelId,
            threadParentId,
          });

          if (params.requireChannelContext && !channelCtx.contextPath) {
            params.log?.warn({ channelId: channelCtx.channelId }, `${logPrefix}:missing required channel context`);
            return;
          }

          const paFiles = await loadWorkspacePaFiles(params.workspaceCwd, { skip: !!params.appendSystemPrompt });
          const contextFiles = buildContextFiles(paFiles, params.discordChannelContext, channelCtx.contextPath);
          const [durableSection, beadSection] = await Promise.all([
            buildDurableMemorySection({
              enabled: params.durableMemoryEnabled,
              durableDataDir: params.durableDataDir,
              userId: user.id,
              durableInjectMaxChars: params.durableInjectMaxChars,
              log: params.log,
            }),
            buildBeadThreadSection({
              isThread,
              threadId,
              threadParentId,
              beadCtx: params.beadCtx,
              log: params.log,
            }),
          ]);

          // Build prompt.
          const emoji = reaction.emoji.name ?? '(unknown)';
          const messageContent = String(msg.content ?? '').slice(0, 1500);
          const messageAuthor = msg.author?.displayName || msg.author?.username || 'Unknown';
          const messageAuthorId = msg.author?.id ?? 'unknown';
          const reactingUser = user.displayName || user.username || 'Unknown';

          // Channel label.
          let channelLabel: string;
          if (isThread) {
            const threadName = String(ch?.name ?? 'unknown');
            const parentName = String(ch?.parent?.name ?? 'unknown');
            channelLabel = `thread ${threadName} in #${parentName}`;
          } else {
            channelLabel = `#${channelCtx.channelName ?? 'unknown'}`;
          }

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
            `---\nReaction event:\n` +
            promptText.eventLine(reactingUser, user.id, emoji, channelLabel) + `\n\n` +
            `Original message by ${messageAuthor} (ID: ${messageAuthorId}):\n` +
            messageContent;

          // Download image attachments and non-image text attachments.
          let inputImages: ImageData[] | undefined;
          if (msg.attachments && msg.attachments.size > 0) {
            try {
              const dlResult = await downloadMessageImages([...msg.attachments.values()]);
              if (dlResult.images.length > 0) {
                inputImages = dlResult.images;
                params.log?.info({ imageCount: dlResult.images.length }, `${logPrefix}:images downloaded`);
              }
              if (dlResult.errors.length > 0) {
                params.log?.warn({ errors: dlResult.errors }, `${logPrefix}:image download errors`);
                metrics.increment('discord.image_download.errors', dlResult.errors.length);
                prompt += `\n(Note: ${dlResult.errors.length} image(s) could not be loaded: ${dlResult.errors.join('; ')})`;
              }
            } catch (err) {
              params.log?.warn({ err }, `${logPrefix}:image download failed`);
            }

            // Download non-image text attachments.
            try {
              const nonImageAtts = [...msg.attachments.values()].filter(a => !resolveMediaType(a));
              if (nonImageAtts.length > 0) {
                const textResult = await downloadTextAttachments(nonImageAtts);
                if (textResult.texts.length > 0) {
                  const sections = textResult.texts.map(t => `[Attached file: ${t.name}]\n\`\`\`\n${t.content}\n\`\`\``);
                  prompt += '\n\n' + sections.join('\n\n');
                  params.log?.info({ fileCount: textResult.texts.length }, `${logPrefix}:text attachments downloaded`);
                }
                if (textResult.errors.length > 0) {
                  prompt += '\n(' + textResult.errors.join('; ') + ')';
                  params.log?.info({ errors: textResult.errors }, `${logPrefix}:text attachment notes`);
                }
              }
            } catch (err) {
              params.log?.warn({ err }, `${logPrefix}:text attachment download failed`);
            }
          }

          // Embeds.
          if (msg.embeds && msg.embeds.length > 0) {
            const embedInfos = msg.embeds.map((e) => {
              const parts: string[] = [];
              if (e.title) parts.push(e.title);
              if (e.url) parts.push(e.url);
              return parts.join(' ') || '(embed)';
            });
            prompt += `\nEmbeds: ${embedInfos.join(', ')}`;
          }

          prompt += `\n\n${promptText.guidanceLine}`;

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

          if (params.discordActionsEnabled) {
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

          // Session continuity.
          const sessionId = params.useRuntimeSessions
            ? await params.sessionManager.getOrCreate(sessionKey)
            : null;

          params.log?.info(
            {
              sessionKey,
              sessionId,
              cwd,
              emoji,
              userId: user.id,
              messageId: msg.id,
              model: params.runtimeModel,
              toolsCount: effectiveTools.length,
              channelId: channelCtx.channelId,
              channelName: channelCtx.channelName,
              hasChannelContext: Boolean(channelCtx.contextPath),
              permissionTier: tools.permissionTier,
            },
            `${logPrefix}:invoke:start`,
          );

          // Track this reply for graceful shutdown cleanup.
          const dispose = registerInFlightReply(reply!, reaction.message.channelId, (reply as any).id, `${logPrefix}:${reaction.message.channelId}`);
          try {

          // Streaming pattern (matches discord.ts flat mode).
          // Both add and remove handlers record under the 'reaction' invoke flow so
          // latency lands in MetricsRegistry.latencies.reaction (avoids InvokeFlow
          // type change). Volume is split by the separate received/error counters.
          let finalText = '';
          let deltaText = '';
          const collectedImages: ImageData[] = [];
          let statusTick = 1;
          const t0 = Date.now();
          metrics.recordInvokeStart('reaction');
          params.log?.info({ flow: 'reaction', sessionKey }, 'obs.invoke.start');
          let invokeError: string | null = null;
          let lastEditAt = 0;
          const minEditIntervalMs = 1250;

          const maybeEdit = async (force = false) => {
            if (!reply) return;
            if (isShuttingDown()) return;
            const now = Date.now();
            if (!force && now - lastEditAt < minEditIntervalMs) return;
            lastEditAt = now;
            const out = selectStreamingOutput({
              deltaText, activityLabel: '', finalText,
              statusTick: statusTick++,
              showPreview: Date.now() - t0 >= 7000,
            });
            try {
              await reply.edit({ content: out, allowedMentions: NO_MENTIONS });
            } catch { /* ignore Discord edit errors during streaming */ }
          };

          // Stream stall warning state.
          let lastEventAt = Date.now();
          let activeToolCount = 0;
          let stallWarned = false;

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

          try {
            for await (const evt of params.runtime.invoke({
              prompt,
              model: params.runtimeModel,
              cwd,
              addDirs: addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined,
              sessionId,
              sessionKey,
              tools: effectiveTools,
              timeoutMs: params.runtimeTimeoutMs,
              images: inputImages,
            })) {
              // Track event flow for stall warning.
              lastEventAt = Date.now();
              stallWarned = false;
              if (evt.type === 'tool_start') activeToolCount++;
              else if (evt.type === 'tool_end') activeToolCount = Math.max(0, activeToolCount - 1);

              if (evt.type === 'text_final') {
                finalText = evt.text;
                await maybeEdit(true);
              } else if (evt.type === 'text_delta') {
                deltaText += evt.text;
                await maybeEdit(false);
              } else if (evt.type === 'log_line') {
                const prefix = evt.stream === 'stderr' ? '[stderr] ' : '[stdout] ';
                deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + prefix + evt.line + '\n';
                await maybeEdit(false);
              } else if (evt.type === 'image_data') {
                collectedImages.push(evt.image);
              } else if (evt.type === 'error') {
                invokeError = evt.message;
                metrics.recordInvokeResult('reaction', Date.now() - t0, false, evt.message);
                params.log?.error({ sessionKey, error: evt.message }, `${logPrefix}:runtime error`);
                params.log?.warn({ flow: 'reaction', sessionKey, error: evt.message }, 'obs.invoke.error');
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
                finalText = mapRuntimeErrorToUserMessage(evt.message);
                await maybeEdit(true);
                return;
              }
            }
          } finally {
            clearInterval(keepalive);
          }
          metrics.recordInvokeResult('reaction', Date.now() - t0, true);
          params.log?.info({ flow: 'reaction', sessionKey, ms: Date.now() - t0, ok: true }, 'obs.invoke.end');

          let processedText = finalText || deltaText || (collectedImages.length > 0 ? '' : '(no output)');

          params.log?.info({ sessionKey, sessionId, ms: Date.now() - t0, hadError: Boolean(invokeError) }, `${logPrefix}:invoke:end`);

          // Parse and execute Discord actions.
          if (params.discordActionsEnabled && msg.guild) {
            const parsed = parseDiscordActions(processedText, actionFlags);
            if (parsed.actions.length > 0) {
              const actCtx = {
                guild: msg.guild,
                client: msg.client,
                channelId: msg.channelId,
                messageId: msg.id,
              };
              const results = await executeDiscordActions(parsed.actions, actCtx, params.log, params.beadCtx, params.cronCtx);
              for (const result of results) {
                metrics.recordActionResult(result.ok);
                params.log?.info({ flow: 'reaction', sessionKey, ok: result.ok }, 'obs.action.result');
              }
              const resultLines = results.map((r) => r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`);
              processedText = parsed.cleanText.trimEnd() + '\n\n' + resultLines.join('\n');

              if (statusRef?.current) {
                for (let i = 0; i < results.length; i++) {
                  if (!results[i].ok) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    statusRef.current.actionFailed(parsed.actions[i].type, (results[i] as { ok: false; error: string }).error);
                  }
                }
              }
            } else {
              processedText = parsed.cleanText;
            }
          }

          if (!isShuttingDown()) {
            try {
              await editThenSendChunks(reply!, (msg as any).channel, processedText, collectedImages);
            } catch (editErr: any) {
              if (editErr?.code === 50083) {
                params.log?.info({ sessionKey }, `${logPrefix}:reply skipped (thread archived by action)`);
              } else {
                throw editErr;
              }
            }
          }

          } finally {
            dispose();
          }
        } catch (err) {
          metrics.increment(handlerErrorMetric);
          params.log?.error({ err, sessionKey }, `${logPrefix}:handler failed`);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          statusRef?.current?.handlerError({ sessionKey }, err);
          try {
            if (reply && !isShuttingDown()) {
              await reply.edit({
                content: mapRuntimeErrorToUserMessage(String(err)),
                allowedMentions: NO_MENTIONS,
              });
            }
          } catch { /* ignore secondary Discord errors */ }
        }
      });
    } catch (err) {
      const metrics = params.metrics ?? globalMetrics;
      metrics.increment(wrapperErrorMetric);
      params.log?.error({ err }, `${logPrefix}:${eventLabel} failed`);
    }
  };
}

export function createReactionAddHandler(
  params: Omit<BotParams, 'token'>,
  queue: QueueLike,
  statusRef?: StatusRef,
): (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => Promise<void> {
  return createReactionHandler('add', params, queue, statusRef);
}

export function createReactionRemoveHandler(
  params: Omit<BotParams, 'token'>,
  queue: QueueLike,
  statusRef?: StatusRef,
): (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => Promise<void> {
  return createReactionHandler('remove', params, queue, statusRef);
}
