export type { AttachmentLike } from '../discord/image-download.js';

/**
 * Normalized representation of an incoming chat message, transport-agnostic.
 * Mapped from platform-specific message objects (e.g. discord.js Message) at
 * the transport boundary. Downstream code should consume this type rather than
 * reaching into platform-specific objects directly.
 *
 * The canonical definition lives in `src/discord/platform-message.ts`.
 */
export type { PlatformMessage } from '../discord/platform-message.js';
