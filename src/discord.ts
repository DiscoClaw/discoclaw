import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { RuntimeAdapter } from './runtime/types.js';
import type { SessionManager } from './sessions.js';
import { isAllowlisted } from './discord/allowlist.js';
import { KeyedQueue } from './group-queue.js';

export type BotParams = {
  token: string;
  allowUserIds: Set<string>;
  runtime: RuntimeAdapter;
  sessionManager: SessionManager;
  workspaceCwd: string;
  groupsDir: string;
  useGroupDirCwd: boolean;
};

function discordSessionKey(msg: {
  channelId: string;
  authorId: string;
  isDm: boolean;
  threadId?: string | null;
}): string {
  if (msg.isDm) return `discord:dm:${msg.authorId}`;
  if (msg.threadId) return `discord:thread:${msg.threadId}`;
  return `discord:channel:${msg.channelId}`;
}

function groupDirNameFromSessionKey(sessionKey: string): string {
  // Keep it filesystem-safe and easy to inspect.
  return sessionKey.replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

async function ensureGroupDir(groupsDir: string, sessionKey: string): Promise<string> {
  const dir = path.join(groupsDir, groupDirNameFromSessionKey(sessionKey));
  await fs.mkdir(dir, { recursive: true });
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

  client.on('messageCreate', async (msg) => {
    if (!msg.author || msg.author.bot) return;

    if (!isAllowlisted(params.allowUserIds, msg.author.id)) return;

    const isDm = msg.guildId == null;
    const isThread = typeof (msg.channel as any)?.isThread === 'function' ? (msg.channel as any).isThread() : false;
    const threadId = isThread ? String((msg.channel as any).id ?? '') : null;
    const sessionKey = discordSessionKey({
      channelId: msg.channelId,
      authorId: msg.author.id,
      isDm,
      threadId: threadId || null,
    });

    await queue.run(sessionKey, async () => {
      const sessionId = await params.sessionManager.getOrCreate(sessionKey);
      const reply = await msg.reply('...');

      const cwd = params.useGroupDirCwd
        ? await ensureGroupDir(params.groupsDir, sessionKey)
        : params.workspaceCwd;

      let finalText = '';
      for await (const evt of params.runtime.invoke({
        prompt: msg.content,
        model: 'opus',
        cwd,
        addDirs: params.useGroupDirCwd ? [params.workspaceCwd] : undefined,
        sessionId,
        tools: ['Bash', 'Read', 'Edit', 'WebSearch', 'WebFetch'],
        timeoutMs: 10 * 60_000,
      })) {
        if (evt.type === 'text_final') {
          finalText = evt.text;
        } else if (evt.type === 'error') {
          finalText = `Error: ${evt.message}`;
        } else if (evt.type === 'text_delta' && !finalText) {
          // Only use deltas when we don't get a final text payload.
          finalText += evt.text;
        }
      }

      const chunks = splitDiscord(finalText || '(no output)');
      await reply.edit(chunks[0] ?? '(no output)');
      for (const extra of chunks.slice(1)) {
        await msg.channel.send(extra);
      }
    });
  });

  await client.login(params.token);
  return client;
}
