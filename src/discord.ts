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

type LoggerLike = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

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
  runtime: RuntimeAdapter;
  sessionManager: SessionManager;
  workspaceCwd: string;
  groupsDir: string;
  useGroupDirCwd: boolean;
  runtimeModel: string;
  runtimeTools: string[];
  runtimeTimeoutMs: number;
};

type QueueLike = Pick<KeyedQueue, 'run'>;

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

function renderDiscordTail(text: string, limit = 1900): string {
  // Render a "tail" view for streaming updates without exceeding Discord limits.
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const tail = normalized.length > limit ? normalized.slice(normalized.length - limit) : normalized;
  // Avoid breaking the fence if the content contains ``` sequences.
  const safe = tail.replace(/```/g, '``\\`');
  return `\`\`\`text\n${safe}\n\`\`\``;
}

export function createMessageCreateHandler(params: Omit<BotParams, 'token'>, queue: QueueLike) {
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

      await queue.run(sessionKey, async () => {
        let reply: any = null;
        try {
          const sessionId = await params.sessionManager.getOrCreate(sessionKey);

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
            contextFiles.push(params.discordChannelContext.baseCorePath);
            contextFiles.push(params.discordChannelContext.baseSafetyPath);
          }
          if (channelCtx.contextPath) contextFiles.push(channelCtx.contextPath);

          const prompt =
            `Context files (read with Read tool before responding, in order):\n` +
            contextFiles.map((p) => `- ${p}`).join('\n') +
            `\n\n---\nUser message:\n` +
            String(msg.content ?? '');

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
            } else if (evt.type === 'text_delta') {
              // Some runtimes never emit a final payload; keep deltas as a fallback.
              deltaText += evt.text;
              await maybeEdit(false);
            } else if (evt.type === 'log_line') {
              // Echo stderr into the streamed output when enabled by the runtime.
              const prefix = evt.stream === 'stderr' ? '[stderr] ' : '';
              deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + prefix + evt.line + '\n';
              await maybeEdit(false);
            }
          }
          params.log?.info({ sessionKey, sessionId, ms: Date.now() - t0 }, 'invoke:end');
          clearInterval(keepalive);

          const outText = finalText || deltaText || '(no output)';
          const chunks = splitDiscord(outText);
          await reply.edit(chunks[0] ?? '(no output)');
          for (const extra of chunks.slice(1)) {
            await msg.channel.send(extra);
          }
        } catch (err) {
          params.log?.error({ err, sessionKey }, 'discord:handler failed');
          try {
            if (reply) await reply.edit(`Error: ${String(err)}`);
          } catch {
            // Ignore secondary errors writing to Discord.
          }
        }
      });
    } catch (err) {
      params.log?.error({ err }, 'discord:messageCreate failed');
    }
  };
}

export async function startDiscordBot(params: BotParams) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const queue = new KeyedQueue();
  client.on('messageCreate', createMessageCreateHandler(params, queue));

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
  return client;
}
