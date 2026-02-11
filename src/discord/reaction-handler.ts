import type { MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js';
import type { BotParams, StatusRef } from '../discord.js';
import { ensureGroupDir } from '../discord.js';
import type { KeyedQueue } from '../group-queue.js';
import { isAllowlisted } from './allowlist.js';
import { discordSessionKey } from './session-key.js';
import { ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './channel-context.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection } from './actions.js';
import type { ActionCategoryFlags } from './actions.js';
import { buildContextFiles, buildDurableMemorySection, loadWorkspacePaFiles, resolveEffectiveTools } from './prompt-common.js';
import { replyThenSendChunks } from './output-common.js';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';
import { globalMetrics } from '../observability/metrics.js';

type QueueLike = Pick<KeyedQueue, 'run'> & { size?: () => number };

export function createReactionAddHandler(
  params: Omit<BotParams, 'token'>,
  queue: QueueLike,
  statusRef?: StatusRef,
): (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => Promise<void> {
  return async (reaction, user) => {
    try {
      const metrics = params.metrics ?? globalMetrics;
      metrics.increment('discord.reaction.received');

      // 1. Self-reaction guard — prevent infinite loops from bot's own reactions.
      if (user.id === reaction.message.client.user?.id) return;

      // 2. Fetch partials.
      try {
        if (reaction.partial) await reaction.fetch();
      } catch (err) {
        params.log?.warn({ err }, 'reaction:partial fetch failed (reaction)');
        return;
      }
      try {
        if (reaction.message.partial) await reaction.message.fetch();
      } catch (err) {
        params.log?.warn({ err }, 'reaction:partial fetch failed (message)');
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
        try {
          // Join thread if needed.
          if (params.autoJoinThreads && isThread) {
            const joinable = typeof ch?.joinable === 'boolean' ? ch.joinable : true;
            const joined = typeof ch?.joined === 'boolean' ? ch.joined : false;
            if (joinable && !joined && typeof ch?.join === 'function') {
              try {
                await ch.join();
                params.log?.info({ threadId: String(ch.id ?? ''), parentId: String(ch.parentId ?? '') }, 'reaction:thread joined');
              } catch (err) {
                params.log?.warn({ err, threadId: String(ch?.id ?? '') }, 'reaction:thread failed to join');
              }
            }
          }

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
              params.log?.error({ err, channelId: id }, 'reaction:context failed to ensure channel context');
            }
          }

          const channelCtx = resolveDiscordChannelContext({
            ctx: params.discordChannelContext,
            isDm: false,
            channelId: reaction.message.channelId,
            threadParentId,
          });

          if (params.requireChannelContext && !channelCtx.contextPath) {
            params.log?.warn({ channelId: channelCtx.channelId }, 'reaction:missing required channel context');
            return;
          }

          const paFiles = await loadWorkspacePaFiles(params.workspaceCwd);
          const contextFiles = buildContextFiles(paFiles, params.discordChannelContext, channelCtx.contextPath);
          const durableSection = await buildDurableMemorySection({
            enabled: params.durableMemoryEnabled,
            durableDataDir: params.durableDataDir,
            userId: user.id,
            durableInjectMaxChars: params.durableInjectMaxChars,
            log: params.log,
          });

          // Build prompt.
          const emoji = reaction.emoji.name ?? '(unknown)';
          const msg = reaction.message;
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

          let prompt =
            `Context files (read with Read tool before responding, in order):\n` +
            contextFiles.map((p) => `- ${p}`).join('\n') +
            (durableSection
              ? `\n\n---\nDurable memory (user-specific notes):\n${durableSection}\n`
              : '') +
            `\n\n---\nReaction event:\n` +
            `${reactingUser} (ID: ${user.id}) reacted with ${emoji} to a message in ${channelLabel}.\n\n` +
            `Original message by ${messageAuthor} (ID: ${messageAuthorId}):\n` +
            messageContent;

          // Attachments.
          if (msg.attachments && msg.attachments.size > 0) {
            const urls = [...msg.attachments.values()].map((a) => a.url).join(', ');
            prompt += `\nAttachments: ${urls}`;
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

          prompt += `\n\nRespond based on your identity and context. The reaction signals the user wants you to engage with this message. Your response will be posted as a reply.`;

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
            'reaction:invoke:start',
          );

          // Non-streaming collect pattern (like cron executor).
          let finalText = '';
          let deltaText = '';
          const t0 = Date.now();
          metrics.recordInvokeStart('reaction');
          params.log?.info({ flow: 'reaction', sessionKey }, 'obs.invoke.start');
          let invokeError: string | null = null;
          for await (const evt of params.runtime.invoke({
            prompt,
            model: params.runtimeModel,
            cwd,
            addDirs: addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined,
            sessionId,
            sessionKey,
            tools: effectiveTools,
            timeoutMs: params.runtimeTimeoutMs,
          })) {
            if (evt.type === 'text_final') {
              finalText = evt.text;
            } else if (evt.type === 'text_delta') {
              deltaText += evt.text;
            } else if (evt.type === 'error') {
              invokeError = evt.message;
              metrics.recordInvokeResult('reaction', Date.now() - t0, false, evt.message);
              params.log?.error({ sessionKey, error: evt.message }, 'reaction:runtime error');
              params.log?.warn({ flow: 'reaction', sessionKey, error: evt.message }, 'obs.invoke.error');
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
              await replyThenSendChunks(reaction.message as any, mapRuntimeErrorToUserMessage(evt.message));
              return;
            }
          }
          metrics.recordInvokeResult('reaction', Date.now() - t0, true);
          params.log?.info({ flow: 'reaction', sessionKey, ms: Date.now() - t0, ok: true }, 'obs.invoke.end');

          let processedText = finalText || deltaText || '(no output)';

          params.log?.info({ sessionKey, sessionId, ms: Date.now() - t0, hadError: Boolean(invokeError) }, 'reaction:invoke:end');

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

          await replyThenSendChunks(msg as any, processedText);
        } catch (err) {
          metrics.increment('discord.reaction.handler_error');
          params.log?.error({ err, sessionKey }, 'reaction:handler failed');
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          statusRef?.current?.handlerError({ sessionKey }, err);
        }
      });
    } catch (err) {
      const metrics = params.metrics ?? globalMetrics;
      metrics.increment('discord.reaction.handler_wrapper_error');
      params.log?.error({ err }, 'reaction:messageReactionAdd failed');
    }
  };
}
