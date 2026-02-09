import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { RuntimeAdapter } from '../engine/types.js';
import type { SessionManager } from '../sessionManager.js';
import { isAllowlisted } from './allowlist.js';

export type BotParams = {
  token: string;
  allowUserIds: Set<string>;
  runtime: RuntimeAdapter;
  sessionManager: SessionManager;
  workspaceCwd: string;
};

function discordSessionKey(msg: { channelId: string; authorId: string; isDm: boolean }): string {
  if (msg.isDm) return `discord:dm:${msg.authorId}`;
  return `discord:channel:${msg.channelId}`;
}

function splitDiscord(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + limit));
    i += limit;
  }
  return chunks;
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

  client.on('messageCreate', async (msg) => {
    if (!msg.author || msg.author.bot) return;

    if (!isAllowlisted(params.allowUserIds, msg.author.id)) return;

    const isDm = msg.guildId == null;
    const sessionKey = discordSessionKey({
      channelId: msg.channelId,
      authorId: msg.author.id,
      isDm,
    });
    const sessionId = await params.sessionManager.getOrCreate(sessionKey);

    const reply = await msg.reply('...');

    let finalText = '';
    for await (const evt of params.runtime.invoke({
      prompt: msg.content,
      model: 'opus',
      cwd: params.workspaceCwd,
      sessionId,
      tools: ['Bash', 'Read', 'Edit', 'WebSearch', 'WebFetch'],
      timeoutMs: 10 * 60_000,
    })) {
      if (evt.type === 'text_delta') {
        // Keep Phase-1 simple: don\'t stream edits aggressively.
        finalText += evt.text;
      } else if (evt.type === 'text_final') {
        finalText = evt.text;
      } else if (evt.type === 'error') {
        finalText = `Error: ${evt.message}`;
      }
    }

    const chunks = splitDiscord(finalText || '(no output)');
    await reply.edit(chunks[0] ?? '(no output)');
    for (const extra of chunks.slice(1)) {
      await msg.channel.send(extra);
    }
  });

  await client.login(params.token);
  return client;
}
