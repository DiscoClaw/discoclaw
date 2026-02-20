import { ChannelType } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import { resolveChannel, fmtTime, findChannelRaw, describeChannelType } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessagingActionRequest =
  | { type: 'sendMessage'; channel: string; content: string; replyTo?: string }
  | { type: 'react'; channelId: string; messageId: string; emoji: string }
  | { type: 'unreact'; channelId: string; messageId: string; emoji: string }
  | { type: 'readMessages'; channel: string; limit?: number; before?: string }
  | { type: 'fetchMessage'; channelId: string; messageId: string }
  | { type: 'editMessage'; channelId: string; messageId: string; content: string }
  | { type: 'deleteMessage'; channelId: string; messageId: string }
  | { type: 'bulkDelete'; channelId: string; count: number }
  | { type: 'crosspost'; channelId: string; messageId: string }
  | { type: 'threadCreate'; channelId: string; name: string; messageId?: string; autoArchiveMinutes?: number }
  | { type: 'pinMessage'; channelId: string; messageId: string }
  | { type: 'unpinMessage'; channelId: string; messageId: string }
  | { type: 'listPins'; channel: string };

const MESSAGING_TYPE_MAP: Record<MessagingActionRequest['type'], true> = {
  sendMessage: true, react: true, unreact: true, readMessages: true, fetchMessage: true,
  editMessage: true, deleteMessage: true, bulkDelete: true, crosspost: true, threadCreate: true,
  pinMessage: true, unpinMessage: true, listPins: true,
};
export const MESSAGING_ACTION_TYPES = new Set<string>(Object.keys(MESSAGING_TYPE_MAP));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_MAX_CONTENT = 2000;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeMessagingAction(
  action: MessagingActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;

  switch (action.type) {
    case 'sendMessage': {
      if (typeof action.channel !== 'string' || !action.channel.trim()) {
        return { ok: false, error: 'sendMessage requires a non-empty channel name or ID' };
      }
      // Silent suppression: if the AI targets the same channel the user
      // message came from, the response is already being posted as a reply —
      // swallow the spurious action to avoid duplicating the response.
      // Only applies to message-handler contexts (messageId is set); cron
      // executions intentionally send to their target channel.
      if (ctx.messageId) {
        const raw = findChannelRaw(guild, action.channel);
        if (raw && raw.id === ctx.channelId) {
          return { ok: true, summary: 'Suppressed: response is already posted as a reply to this channel' };
        }
        // Also suppress when targeting the parent forum from within a task thread.
        if (ctx.threadParentId && raw && raw.id === ctx.threadParentId && raw.type === ChannelType.GuildForum) {
          return { ok: true, summary: 'Suppressed: response is already posted to this thread' };
        }
      }
      if (typeof action.content !== 'string' || !action.content.trim()) {
        return { ok: false, error: 'sendMessage requires non-empty string content' };
      }
      if (action.content.length > DISCORD_MAX_CONTENT) {
        return { ok: false, error: `Content exceeds Discord's ${DISCORD_MAX_CONTENT} character limit (got ${action.content.length})` };
      }
      const channel = resolveChannel(guild, action.channel);
      if (!channel) {
        const raw = findChannelRaw(guild, action.channel);
        if (raw) {
          const kind = describeChannelType(raw);
          const hint = kind === 'forum' ? ' Use threadCreate to post in forum channels.' : '';
          return { ok: false, error: `Channel "${action.channel}" is a ${kind} channel and cannot receive messages directly.${hint}` };
        }
        return { ok: false, error: `Channel "${action.channel}" not found — it may have been deleted or archived. If this was a task thread, use taskShow with the task ID instead.` };
      }

      const opts: any = { content: action.content, allowedMentions: NO_MENTIONS };
      if (action.replyTo) {
        opts.reply = { messageReference: action.replyTo };
      }
      await channel.send(opts);
      return { ok: true, summary: `Sent message to #${channel.name}` };
    }

    case 'react': {
      if (!action.channelId?.trim()) return { ok: false, error: 'react requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'react requires a non-empty messageId' };
      if (!action.emoji?.trim()) return { ok: false, error: 'react requires a non-empty emoji' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.react(action.emoji);
      return { ok: true, summary: `Reacted with ${action.emoji}` };
    }

    case 'unreact': {
      if (!action.channelId?.trim()) return { ok: false, error: 'unreact requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'unreact requires a non-empty messageId' };
      if (!action.emoji?.trim()) return { ok: false, error: 'unreact requires a non-empty emoji' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      const reaction = message.reactions.resolve(action.emoji);
      if (!reaction) return { ok: false, error: `Reaction "${action.emoji}" not found on message` };
      await reaction.users.remove(ctx.client.user!.id);
      return { ok: true, summary: `Removed reaction ${action.emoji}` };
    }

    case 'readMessages': {
      const channel = resolveChannel(guild, action.channel);
      if (!channel) {
        const raw = findChannelRaw(guild, action.channel);
        if (raw) {
          const kind = describeChannelType(raw);
          return { ok: false, error: `Channel "${action.channel}" is a ${kind} channel and cannot be read directly. Use readMessages with a thread ID instead.` };
        }
        return { ok: false, error: `Channel "${action.channel}" not found — it may have been deleted or archived. If this was a task thread, use taskShow with the task ID instead.` };
      }

      const limit = Math.min(Math.max(1, action.limit ?? 10), 20);
      const opts: any = { limit };
      if (action.before) opts.before = action.before;

      const messages = await channel.messages.fetch(opts) as any;
      const sorted = [...messages.values()].sort(
        (a: any, b: any) => a.createdTimestamp - b.createdTimestamp,
      );

      if (sorted.length === 0) {
        return { ok: true, summary: `No messages found in #${channel.name}` };
      }

      const lines = sorted.map((m: any) => {
        const author = m.author?.username ?? 'Unknown';
        const time = fmtTime(m.createdAt);
        const text = (m.content || '(no text)').slice(0, 200);
        return `[${author}] ${text} (${time}, id:${m.id})`;
      });
      return { ok: true, summary: `Messages in #${channel.name}:\n${lines.join('\n')}` };
    }

    case 'fetchMessage': {
      if (!action.channelId?.trim()) return { ok: false, error: 'fetchMessage requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'fetchMessage requires a non-empty messageId' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      const author = message.author?.username ?? 'Unknown';
      const time = fmtTime(message.createdAt);
      const text = (message.content || '(no text)').slice(0, 500);
      return { ok: true, summary: `[${author}]: ${text} (${time}, #${(channel as any).name}, id:${message.id})` };
    }

    case 'editMessage': {
      if (!action.channelId?.trim()) return { ok: false, error: 'editMessage requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'editMessage requires a non-empty messageId' };
      if (typeof action.content !== 'string' || !action.content.trim()) {
        return { ok: false, error: 'editMessage requires non-empty string content' };
      }
      if (action.content.length > DISCORD_MAX_CONTENT) {
        return { ok: false, error: `Content exceeds Discord's ${DISCORD_MAX_CONTENT} character limit (got ${action.content.length})` };
      }
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.edit({ content: action.content, allowedMentions: NO_MENTIONS });
      return { ok: true, summary: `Edited message in #${(channel as any).name}` };
    }

    case 'deleteMessage': {
      if (!action.channelId?.trim()) return { ok: false, error: 'deleteMessage requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'deleteMessage requires a non-empty messageId' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.delete();
      return { ok: true, summary: `Deleted message in #${(channel as any).name}` };
    }

    case 'bulkDelete': {
      const count = action.count;
      if (!Number.isInteger(count) || count < 2 || count > 100) {
        return { ok: false, error: 'bulkDelete count must be an integer between 2 and 100' };
      }
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('bulkDelete' in channel)) {
        return { ok: false, error: `Channel "${action.channelId}" not found or does not support bulk delete` };
      }
      const deleted = await (channel as any).bulkDelete(count, true);
      return { ok: true, summary: `Bulk deleted ${deleted.size} messages in #${(channel as any).name}` };
    }

    case 'crosspost': {
      if (!action.channelId?.trim()) return { ok: false, error: 'crosspost requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'crosspost requires a non-empty messageId' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      if ((channel as any).type !== ChannelType.GuildAnnouncement) {
        return { ok: false, error: `Channel #${(channel as any).name} is not an announcement channel` };
      }
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.crosspost();
      return { ok: true, summary: `Published message to followers of #${(channel as any).name}` };
    }

    case 'threadCreate': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      if (action.messageId && 'messages' in channel) {
        const message = await (channel as any).messages.fetch(action.messageId);
        const thread = await message.startThread({
          name: action.name,
          autoArchiveDuration: action.autoArchiveMinutes ?? 1440,
        });
        return { ok: true, summary: `Created thread "${thread.name}" from message in #${(channel as any).name}` };
      }

      if ('threads' in channel) {
        const thread = await (channel as any).threads.create({
          name: action.name,
          autoArchiveDuration: action.autoArchiveMinutes ?? 1440,
        });
        return { ok: true, summary: `Created thread "${thread.name}" in #${(channel as any).name}` };
      }

      return { ok: false, error: `Channel "${action.channelId}" does not support threads` };
    }

    case 'pinMessage': {
      if (!action.channelId?.trim()) return { ok: false, error: 'pinMessage requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'pinMessage requires a non-empty messageId' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.pin();
      return { ok: true, summary: `Pinned message in #${(channel as any).name}` };
    }

    case 'unpinMessage': {
      if (!action.channelId?.trim()) return { ok: false, error: 'unpinMessage requires a non-empty channelId' };
      if (!action.messageId?.trim()) return { ok: false, error: 'unpinMessage requires a non-empty messageId' };
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel || !('messages' in channel)) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const message = await (channel as any).messages.fetch(action.messageId);
      await message.unpin();
      return { ok: true, summary: `Unpinned message in #${(channel as any).name}` };
    }

    case 'listPins': {
      const channel = resolveChannel(guild, action.channel);
      if (!channel) {
        const raw = findChannelRaw(guild, action.channel);
        if (raw) {
          const kind = describeChannelType(raw);
          return { ok: false, error: `Channel "${action.channel}" is a ${kind} channel. Use individual thread IDs to list pins.` };
        }
        return { ok: false, error: `Channel "${action.channel}" not found — it may have been deleted or archived. If this was a task thread, use taskShow with the task ID instead.` };
      }
      const pinned = await channel.messages.fetchPinned();

      if (pinned.size === 0) {
        return { ok: true, summary: `No pinned messages in #${channel.name}` };
      }

      const lines = [...pinned.values()].map((m) => {
        const author = m.author?.username ?? 'Unknown';
        const text = (m.content || '(no text)').slice(0, 200);
        return `[${author}] ${text} (id:${m.id})`;
      });
      return { ok: true, summary: `Pinned messages in #${channel.name}:\n${lines.join('\n')}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function messagingActionsPromptSection(): string {
  return `### Messaging

**sendMessage** — Send a message to a channel:
\`\`\`
<discord-action>{"type":"sendMessage","channel":"#general","content":"Hello world!","replyTo":"message-id"}</discord-action>
\`\`\`
- \`channel\` (required): Channel name (with or without #) or channel ID.
- \`content\` (required): Message text.
- \`replyTo\` (optional): Message ID to reply to.
- **Important:** Do NOT use sendMessage to reply to the current conversation — your response text is automatically posted as a reply. Only use sendMessage to post in a *different* channel.
- Forum channels do NOT support sendMessage. To post in a forum, use \`threadCreate\` instead.

**react** — Add a reaction to a message:
\`\`\`
<discord-action>{"type":"react","channelId":"123","messageId":"456","emoji":"👍"}</discord-action>
\`\`\`

**unreact** — Remove the bot's reaction from a message:
\`\`\`
<discord-action>{"type":"unreact","channelId":"123","messageId":"456","emoji":"👍"}</discord-action>
\`\`\`

**readMessages** — Read recent messages from a channel:
\`\`\`
<discord-action>{"type":"readMessages","channel":"#general","limit":10,"before":"message-id"}</discord-action>
\`\`\`
- \`channel\` (required): Channel name or ID.
- \`limit\` (optional): 1–20, default 10.
- \`before\` (optional): Message ID to fetch messages before.

**fetchMessage** — Fetch a single message by ID:
\`\`\`
<discord-action>{"type":"fetchMessage","channelId":"123","messageId":"456"}</discord-action>
\`\`\`

**editMessage** — Edit a bot message:
\`\`\`
<discord-action>{"type":"editMessage","channelId":"123","messageId":"456","content":"Updated text"}</discord-action>
\`\`\`

**deleteMessage** — Delete a message (destructive — confirm with user first):
\`\`\`
<discord-action>{"type":"deleteMessage","channelId":"123","messageId":"456"}</discord-action>
\`\`\`

**bulkDelete** — Delete multiple recent messages at once (destructive — confirm with user first):
\`\`\`
<discord-action>{"type":"bulkDelete","channelId":"123","count":10}</discord-action>
\`\`\`
- \`channelId\` (required): Channel ID.
- \`count\` (required): Number of messages to delete (2–100). Messages older than 14 days are skipped.

**crosspost** — Publish a message in an announcement channel to all following servers:
\`\`\`
<discord-action>{"type":"crosspost","channelId":"123","messageId":"456"}</discord-action>
\`\`\`
- Only works in announcement channels. The message will be pushed to all servers following the channel.

**threadCreate** — Create a thread:
\`\`\`
<discord-action>{"type":"threadCreate","channelId":"123","name":"Discussion","messageId":"456"}</discord-action>
\`\`\`
- \`channelId\` (required): Parent channel ID.
- \`name\` (required): Thread name.
- \`messageId\` (optional): Start thread from this message. If omitted, creates a standalone thread.
- \`autoArchiveMinutes\` (optional): Auto-archive after N minutes (60, 1440, 4320, 10080). Default: 1440.

**pinMessage** / **unpinMessage** — Pin or unpin a message:
\`\`\`
<discord-action>{"type":"pinMessage","channelId":"123","messageId":"456"}</discord-action>
<discord-action>{"type":"unpinMessage","channelId":"123","messageId":"456"}</discord-action>
\`\`\`

**listPins** — List pinned messages in a channel:
\`\`\`
<discord-action>{"type":"listPins","channel":"#general"}</discord-action>
\`\`\``;
}
