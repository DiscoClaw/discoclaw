import type { Message } from 'discord.js';
import type { AttachmentLike } from './image-download.js';

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
  /** ID of the user/account that sent the message. */
  authorId: string;
  /** Username (login handle) of the sender. */
  authorName: string;
  /** Display name of the sender (may differ from authorName). */
  authorDisplayName: string;
  /** True when the sender is an automated bot account. */
  isBot: boolean;
  /** Channel the message was sent in. */
  channelId: string;
  /** Guild (server) ID. Absent for direct messages. */
  guildId?: string;
  /** Whether the message was sent in a DM (no guild). */
  isDm: boolean;
  /**
   * If the message was sent inside a thread, the thread's channel ID.
   * Absent otherwise.
   */
  threadId?: string;
  /**
   * If the message was sent inside a thread, the parent channel ID.
   * Absent otherwise.
   */
  threadParentId?: string;
  /** discord.js numeric message type (0 = Default, 19 = Reply). */
  type: number;
  /** File/media attachments on the message. Empty array when none. */
  attachments: AttachmentLike[];
  /** Rich embeds on the message. Empty array when none. */
  embeds: { title?: string; url?: string; description?: string }[];
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

  const threadId = isThread ? String((msg.channel as any).id ?? '') : undefined;
  const rawParentId = isThread ? ((msg.channel as any).parentId ?? null) : null;
  const threadParentId = rawParentId != null ? String(rawParentId) : undefined;

  const attachments: AttachmentLike[] = msg.attachments
    ? [...msg.attachments.values()].map((a: any) => ({
        url: a.url,
        name: a.name ?? null,
        contentType: a.contentType ?? null,
        size: a.size ?? null,
      }))
    : [];

  const embeds: { title?: string; url?: string; description?: string }[] = msg.embeds
    ? msg.embeds.map((e: any) => ({
        title: e.title ?? undefined,
        url: e.url ?? undefined,
        description: e.description ?? undefined,
      }))
    : [];

  return {
    id: msg.id,
    content: String(msg.content ?? ''),
    authorId: msg.author.id,
    authorName: msg.author.username,
    authorDisplayName: msg.author.displayName ?? msg.author.username,
    isBot: msg.author.bot,
    channelId: msg.channelId,
    guildId: msg.guildId ?? undefined,
    isDm: msg.guildId == null,
    threadId,
    threadParentId,
    type: msg.type as number,
    attachments,
    embeds,
  };
}
