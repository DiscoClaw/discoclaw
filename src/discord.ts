import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { RuntimeAdapter } from './runtime/types.js';
import type { SessionManager } from './sessions.js';
import { isAllowlisted } from './discord/allowlist.js';
import { KeyedQueue } from './group-queue.js';
import type { DiscordChannelContext } from './discord/channel-context.js';
import { ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './discord/channel-context.js';
import { discordSessionKey } from './discord/session-key.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection } from './discord/actions.js';
import type { ActionCategoryFlags } from './discord/actions.js';
import type { LoggerLike } from './discord/action-types.js';
import { fetchMessageHistory } from './discord/message-history.js';
import { loadSummary, saveSummary, generateSummary } from './discord/summarizer.js';
import { loadDurableMemory, selectItemsForInjection, formatDurableSection } from './discord/durable-memory.js';
import { parseMemoryCommand, handleMemoryCommand } from './discord/memory-commands.js';
import type { StatusPoster } from './discord/status-channel.js';
import { createStatusPoster } from './discord/status-channel.js';

export type BotParams = {
  token: string;
  allowUserIds: Set<string>;
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
  statusChannel?: string;
};

type QueueLike = Pick<KeyedQueue, 'run'>;

const turnCounters = new Map<string, number>();

function groupDirNameFromSessionKey(sessionKey: string): string {
  // Keep it filesystem-safe and easy to inspect.
  return sessionKey.replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

async function ensureGroupDir(groupsDir: string, sessionKey: string): Promise<string> {
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
      `# Discoclaw Group\n\n` +
      `Session key: \`${sessionKey}\`\n\n` +
      `This directory scopes conversation instructions for this Discord context.\n\n` +
      `Notes:\n` +
      `- The main workspace is mounted separately (see Discoclaw service env).\n` +
      `- Keep instructions short and specific; prefer referencing files in the workspace.\n`;
    await fs.writeFile(claudeMd, body, 'utf8');
  }
  return dir;
}

function splitDiscord(text: string, limit = 2000): string[] {
  // Minimal fence-safe markdown chunking.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.length <= limit) return [normalized];

  const rawLines = normalized.split('\n');
  const chunks: string[] = [];

  let cur = '';
  let inFence = false;
  let fenceHeader = '```';

  const ensureFenceOpen = () => {
    if (cur) return;
    if (inFence) cur = `${fenceHeader}\n`;
  };

  const flush = () => {
    if (!cur) return;
    if (inFence && !cur.trimEnd().endsWith('```')) {
      const close = '\n```';
      if (cur.length + close.length <= limit) {
        cur += close;
      }
    }
    chunks.push(cur);
    cur = '';
  };

  const appendLine = (line: string) => {
    ensureFenceOpen();
    const sep = cur.length > 0 ? '\n' : '';
    cur += sep + line;
  };

  for (const line of rawLines) {
    const nextLen = (cur.length ? cur.length + 1 : 0) + line.length;
    if (nextLen > limit) {
      flush();
      // Reopen fence if we flushed mid-fence.
      ensureFenceOpen();
    }

    // If the line itself is too long, hard split.
    if (line.length > limit) {
      let rest = line;
      while (rest.length > 0) {
        const room = Math.max(1, limit - (cur.length ? cur.length + 1 : 0));
        const take = rest.slice(0, room);
        appendLine(take);
        rest = rest.slice(room);
        if (rest.length > 0) {
          flush();
          ensureFenceOpen();
        }
      }
    } else {
      appendLine(line);
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceHeader = trimmed.trimEnd();
      } else {
        inFence = false;
        fenceHeader = '```';
      }
    }

    // If we are in a fence and we're close to the limit, proactively flush
    // to reduce the chance of an un-closable fence close.
    if (inFence && cur.length >= limit - 8) {
      flush();
      // Next line will reopen.
    }
  }

  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

function truncateCodeBlocks(text: string, maxLines = 20): string {
  // Truncate fenced code blocks that exceed maxLines, keeping first/last lines.
  return text.replace(/^([ \t]*```[^\n]*\n)([\s\S]*?)(^[ \t]*```[ \t]*$)/gm, (_match, open: string, body: string, close: string) => {
    const lines = body.split('\n');
    // The last element after split is usually '' before the closing fence.
    // Count only non-trivial lines (drop trailing empty from split).
    const trimmedLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    if (trimmedLines.length <= maxLines) return open + body + close;

    const keepTop = Math.ceil(maxLines / 2);
    const keepBottom = Math.floor(maxLines / 2);
    const omitted = trimmedLines.length - keepTop - keepBottom;
    const top = trimmedLines.slice(0, keepTop);
    const bottom = trimmedLines.slice(trimmedLines.length - keepBottom);
    return (
      open +
      top.join('\n') + '\n' +
      `... (${omitted} lines omitted)\n` +
      bottom.join('\n') + '\n' +
      close
    );
  });
}

function renderDiscordTail(text: string, maxLines = 8): string {
  // Render a fixed-height "tail" view for streaming updates.
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  // Avoid breaking the fence if the content contains ``` sequences.
  const safe = tail.join('\n').replace(/```/g, '``\\`');
  return `\`\`\`text\n${safe}\n\`\`\``;
}

export type StatusRef = { current: StatusPoster | null };

export function createMessageCreateHandler(params: Omit<BotParams, 'token'>, queue: QueueLike, statusRef?: StatusRef) {
  const actionFlags: ActionCategoryFlags = {
    channels: params.discordActionsChannels,
    messaging: params.discordActionsMessaging,
    guild: params.discordActionsGuild,
    moderation: params.discordActionsModeration,
    polls: params.discordActionsPolls,
  };

  return async (msg: any) => {
    try {
      if (!msg?.author || msg.author.bot) return;

      if (!isAllowlisted(params.allowUserIds, msg.author.id)) return;

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

      await queue.run(sessionKey, async () => {
        let reply: any = null;
        try {
          // Handle !memory commands before session creation or the "..." placeholder.
          if (params.memoryCommandsEnabled) {
            const cmd = parseMemoryCommand(String(msg.content ?? ''));
            if (cmd) {
              const response = await handleMemoryCommand(cmd, {
                userId: msg.author.id,
                sessionKey,
                durableDataDir: params.durableDataDir,
                durableMaxItems: params.durableMaxItems,
                durableInjectMaxChars: params.durableInjectMaxChars,
                summaryDataDir: params.summaryDataDir,
                channelId: msg.channelId,
                messageId: msg.id,
              });
              await msg.reply(response);
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

          reply = await msg.reply('...');

          const cwd = params.useGroupDirCwd
            ? await ensureGroupDir(params.groupsDir, sessionKey)
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
            await reply.edit('Configuration error: missing required channel context file for this channel ID.');
            return;
          }

          // Keep prompt small: link to the channel context file and instruct the runtime to read it.
          const contextFiles: string[] = [];
          if (params.discordChannelContext) {
            contextFiles.push(...params.discordChannelContext.baseFiles);
          }
          if (channelCtx.contextPath) contextFiles.push(channelCtx.contextPath);

          let historySection = '';
          if (params.messageHistoryBudget > 0) {
            try {
              historySection = await fetchMessageHistory(
                msg.channel,
                msg.id,
                { budgetChars: params.messageHistoryBudget },
              );
            } catch (err) {
              params.log?.warn({ err }, 'discord:history fetch failed');
            }
          }

          let summarySection = '';
          if (params.summaryEnabled) {
            try {
              const existing = await loadSummary(params.summaryDataDir, sessionKey);
              if (existing) summarySection = existing.summary;
            } catch (err) {
              params.log?.warn({ err, sessionKey }, 'discord:summary load failed');
            }
          }

          let durableSection = '';
          if (params.durableMemoryEnabled) {
            try {
              const store = await loadDurableMemory(params.durableDataDir, msg.author.id);
              if (store) {
                const items = selectItemsForInjection(store, params.durableInjectMaxChars);
                if (items.length > 0) durableSection = formatDurableSection(items);
              }
            } catch (err) {
              params.log?.warn({ err, userId: msg.author.id }, 'discord:durable memory load failed');
            }
          }

          let prompt =
            `Context files (read with Read tool before responding, in order):\n` +
            contextFiles.map((p) => `- ${p}`).join('\n') +
            (durableSection
              ? `\n\n---\nDurable memory (user-specific notes):\n${durableSection}\n`
              : '') +
            (summarySection
              ? `\n\n---\nConversation memory:\n${summarySection}\n`
              : '') +
            (historySection
              ? `\n\n---\nRecent conversation:\n${historySection}\n`
              : '\n') +
            `\n---\nUser message:\n` +
            String(msg.content ?? '');

          if (params.discordActionsEnabled && !isDm) {
            prompt += '\n\n---\n' + discordActionsPromptSection(actionFlags);
          }

          const addDirs: string[] = [];
          if (params.useGroupDirCwd) addDirs.push(params.workspaceCwd);
          if (params.discordChannelContext) addDirs.push(params.discordChannelContext.contentDir);

          let finalText = '';
          let deltaText = '';
          const t0 = Date.now();
          let lastEditAt = 0;
          const minEditIntervalMs = 1250;

          const maybeEdit = async (force = false) => {
            if (!reply) return;
            const now = Date.now();
            if (!force && now - lastEditAt < minEditIntervalMs) return;
            lastEditAt = now;
            const out = renderDiscordTail(deltaText || finalText || '(working...)');
            try {
              await reply.edit(out);
            } catch {
              // Ignore Discord edit errors during streaming.
            }
          };

          // If the runtime produces no stdout/stderr (auth/network hangs), avoid leaving the
          // placeholder `...` indefinitely by periodically updating the message.
          const keepalive = setInterval(() => {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            maybeEdit(true);
          }, 5000);

          params.log?.info(
            {
              sessionKey,
              sessionId,
              cwd,
              model: params.runtimeModel,
              toolsCount: params.runtimeTools.length,
              timeoutMs: params.runtimeTimeoutMs,
              channelId: channelCtx.channelId,
              channelName: channelCtx.channelName,
              hasChannelContext: Boolean(channelCtx.contextPath),
            },
            'invoke:start',
          );
          for await (const evt of params.runtime.invoke({
            prompt,
            model: params.runtimeModel,
            cwd,
            addDirs: addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined,
            sessionId,
            tools: params.runtimeTools,
            timeoutMs: params.runtimeTimeoutMs,
          })) {
            if (evt.type === 'text_final') {
              finalText = evt.text;
              await maybeEdit(true);
            } else if (evt.type === 'error') {
              finalText = `Error: ${evt.message}`;
              await maybeEdit(true);
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              statusRef?.current?.runtimeError({ sessionKey, channelName: channelCtx.channelName }, evt.message);
            } else if (evt.type === 'text_delta') {
              // Some runtimes never emit a final payload; keep deltas as a fallback.
              deltaText += evt.text;
              await maybeEdit(false);
            } else if (evt.type === 'log_line') {
              // Echo stderr into the streamed output when enabled by the runtime.
              const prefix = evt.stream === 'stderr' ? '[stderr] ' : '[stdout] ';
              deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + prefix + evt.line + '\n';
              await maybeEdit(false);
            }
          }
          params.log?.info({ sessionKey, sessionId, ms: Date.now() - t0 }, 'invoke:end');
          clearInterval(keepalive);

          let processedText = finalText || deltaText || '(no output)';
          if (params.discordActionsEnabled && msg.guild) {
            const { cleanText, actions } = parseDiscordActions(processedText, actionFlags);
            if (actions.length > 0) {
              const actCtx = {
                guild: msg.guild,
                client: msg.client,
                channelId: msg.channelId,
                messageId: msg.id,
              };
              const results = await executeDiscordActions(actions, actCtx, params.log);
              const resultLines = results.map((r) => r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`);
              processedText = cleanText.trimEnd() + '\n\n' + resultLines.join('\n');
              if (statusRef?.current) {
                for (let i = 0; i < results.length; i++) {
                  const r = results[i];
                  if (!r.ok) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    statusRef.current.actionFailed(actions[i].type, r.error);
                  }
                }
              }
            } else {
              processedText = cleanText;
            }
          }
          const outText = truncateCodeBlocks(processedText);
          const chunks = splitDiscord(outText);
          await reply.edit(chunks[0] ?? '(no output)');
          for (const extra of chunks.slice(1)) {
            await msg.channel.send(extra);
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
                  `[Discoclaw]: ${(processedText || '').slice(0, 500)}`,
              };
            }
          }
        } catch (err) {
          params.log?.error({ err, sessionKey }, 'discord:handler failed');
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          statusRef?.current?.handlerError({ sessionKey }, err);
          try {
            if (reply) await reply.edit(`Error: ${String(err)}`);
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
            }),
          )
          .catch((err) => {
            params.log?.warn({ err, sessionKey }, 'discord:summary generation failed');
          });
      }
    } catch (err) {
      params.log?.error({ err }, 'discord:messageCreate failed');
    }
  };
}

function resolveStatusChannel(client: Client, nameOrId: string, log?: LoggerLike): StatusPoster | null {
  // Try by ID first, then by name across all guilds.
  const byId = client.channels.cache.get(nameOrId);
  if (byId?.isTextBased() && !byId.isDMBased()) return createStatusPoster(byId, log);

  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name === nameOrId,
    );
    if (ch && ch.isTextBased()) return createStatusPoster(ch, log);
  }
  return null;
}

export async function startDiscordBot(params: BotParams): Promise<{ client: Client; status: StatusPoster | null }> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  // Mutable ref: handler captures this at registration time, but dereferences
  // .current at call time so we can set it after the ready event.
  const statusRef: StatusRef = { current: null };

  const queue = new KeyedQueue();
  client.on('messageCreate', createMessageCreateHandler(params, queue, statusRef));

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

  await client.login(params.token);

  // Wait for cache to be ready before resolving the status channel.
  await new Promise<void>((resolve) => {
    if (client.isReady()) {
      resolve();
    } else {
      client.once('ready', () => resolve());
    }
  });

  if (params.statusChannel) {
    statusRef.current = resolveStatusChannel(client, params.statusChannel, params.log);
    if (statusRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      statusRef.current.online();
    } else {
      params.log?.warn({ statusChannel: params.statusChannel }, 'status-channel: channel not found, status posting disabled');
    }
  }

  return { client, status: statusRef.current };
}
