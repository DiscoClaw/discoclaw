export type { AttachmentLike } from '../discord/image-download.js';

/**
 * Normalized representation of an incoming chat message, transport-agnostic.
 * Mapped from platform-specific message objects (e.g. discord.js Message) at
 * the transport boundary. Downstream code should consume this type rather than
 * reaching into platform-specific objects directly.
 */
export type PlatformMessage = {
  /** Unique message ID (platform-assigned). */
  id: string;

  /** Platform user ID of the message author. */
  authorId: string;

  /** Channel ID where the message was sent. */
  channelId: string;

  /** Guild/server ID, or null for DMs. */
  guildId: string | null;

  /** Resolved display name of the author (nickname > username). */
  authorName: string;

  /** Raw text content of the message. */
  content: string;

  /** Attachments (images, files) included with the message. */
  attachments: import('../discord/image-download.js').AttachmentLike[];

  /** ID of the message being replied to, or null. */
  referenceMessageId: string | null;

  /** Unix timestamp (ms) when the message was created. */
  createdTimestamp: number;
};
