import type { Message } from 'discord.js';

/**
 * Transport-agnostic representation of an incoming chat message.
 * Downstream code should consume this type rather than discord.js `Message`
 * objects directly so that the Discord transport can be swapped out later.
 */
export type PlatformMessage = {
  /** Unique message ID (platform-scoped). */
  id: string;
  /** Text body of the message. Empty string when not present. */
  content: string;
  /** The user/account that sent the message. */
  author: {
    id: string;
    username: string;
    displayName: string;
    /** True when the sender is an automated bot account. */
    bot: boolean;
  };
  /** Channel the message was sent in. */
  channelId: string;
  /** Guild (server) ID, or null for direct messages. */
  guildId: string | null;
  /** Whether the message was sent in a DM (no guild). */
  isDm: boolean;
  /**
   * If the message was sent inside a thread, the thread's channel ID.
   * Null otherwise.
   */
  threadId: string | null;
  /**
   * If the message was sent inside a thread, the parent channel ID.
   * Null otherwise.
   */
  threadParentId: string | null;
  /** discord.js numeric message type (0 = Default, 19 = Reply). */
  type: number;
};

/**
 * Map a discord.js `Message` to the platform-agnostic `PlatformMessage` type.
 *
 * This is the only place in the codebase that imports discord.js types for
 * message normalization — keep it that way.
 */
export function toPlatformMessage(msg: Message): PlatformMessage {
  const isThread =
    typeof (msg.channel as any)?.isThread === 'function'
      ? (msg.channel as any).isThread()
      : false;

  const threadId = isThread ? String((msg.channel as any).id ?? '') : null;
  const threadParentId = isThread
    ? String((msg.channel as any).parentId ?? '')
    : null;

  return {
    id: msg.id,
    content: String(msg.content ?? ''),
    author: {
      id: msg.author.id,
      username: msg.author.username,
      displayName: msg.author.displayName ?? msg.author.username,
      bot: msg.author.bot,
    },
    channelId: msg.channelId,
    guildId: msg.guildId ?? null,
    isDm: msg.guildId == null,
    threadId,
    threadParentId,
    type: msg.type as number,
  };
}
