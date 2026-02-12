import type { ImageData } from '../runtime/types.js';
import { MAX_IMAGES_PER_INVOCATION } from '../runtime/types.js';
import { downloadMessageImages, resolveMediaType } from './image-download.js';
import type { AttachmentLike } from './image-download.js';
import type { LoggerLike } from './action-types.js';

export type ReplyReferenceResult = {
  section: string;
  images: ImageData[];
};

/** Minimal shape for a Discord message with optional reference. */
export type MessageWithReference = {
  reference?: { messageId?: string } | null;
  channel: {
    messages: {
      fetch(id: string): Promise<ReferencedMessage>;
    };
  };
};

/** Shape of the fetched referenced message. */
export type ReferencedMessage = {
  author: { id?: string; bot?: boolean; displayName?: string; username: string };
  content?: string | null;
  attachments?: Map<string, AttachmentLike> | { values(): Iterable<AttachmentLike>; size: number };
  embeds?: Array<{ title?: string | null; url?: string | null }>;
};

/** Max chars of referenced message content to include in the prompt. */
const CONTENT_BUDGET = 1500;

/**
 * Resolve a Discord reply reference into a prompt section and any image attachments.
 *
 * Returns null if the message has no reference or if the fetch fails.
 * Images from the referenced message share the global MAX_IMAGES_PER_INVOCATION budget;
 * pass `usedImages` to account for images already claimed.
 */
export async function resolveReplyReference(
  msg: MessageWithReference,
  botDisplayName: string | undefined,
  log?: LoggerLike,
  usedImages: number = 0,
): Promise<ReplyReferenceResult | null> {
  const refId = msg.reference?.messageId;
  if (!refId) return null;

  try {
    const refMsg = await msg.channel.messages.fetch(refId);

    // Author info
    const author = refMsg.author.bot
      ? (botDisplayName ?? 'Discoclaw')
      : (refMsg.author.displayName || refMsg.author.username);
    const authorId = String(refMsg.author.id ?? 'unknown');

    let content = String(refMsg.content ?? '');
    if (content.length > CONTENT_BUDGET) {
      content = content.slice(0, CONTENT_BUDGET) + '…';
    }

    // Note non-image attachments inline
    const attachmentNotes: string[] = [];
    const imageAttachments: AttachmentLike[] = [];

    if (refMsg.attachments) {
      const atts = refMsg.attachments instanceof Map
        ? [...refMsg.attachments.values()]
        : [...refMsg.attachments.values()];

      for (const att of atts) {
        if (resolveMediaType(att)) {
          imageAttachments.push(att);
        } else {
          const name = att.name ?? 'unknown';
          attachmentNotes.push(`[attachment: ${name}]`);
        }
      }
    }

    // Download images from the referenced message (shared budget)
    let images: ImageData[] = [];
    if (imageAttachments.length > 0) {
      const remaining = Math.max(0, MAX_IMAGES_PER_INVOCATION - usedImages);
      if (remaining > 0) {
        try {
          const dlResult = await downloadMessageImages(imageAttachments, remaining);
          images = dlResult.images;
          if (dlResult.errors.length > 0) {
            log?.warn({ errors: dlResult.errors }, 'discord:reply-ref image download errors');
          }
        } catch (err) {
          log?.warn({ err }, 'discord:reply-ref image download failed');
        }
      }
    }

    // Embeds (title + URL)
    const embedInfos: string[] = [];
    if (refMsg.embeds && refMsg.embeds.length > 0) {
      for (const e of refMsg.embeds) {
        const parts: string[] = [];
        if (e.title) parts.push(e.title);
        if (e.url) parts.push(e.url);
        if (parts.length > 0) embedInfos.push(parts.join(' '));
      }
    }

    // Build section
    let section = `[${author} (ID: ${authorId})]: ${content}`;
    if (attachmentNotes.length > 0) {
      section += '\n' + attachmentNotes.join('\n');
    }
    if (images.length > 0) {
      section += `\n(${images.length} image(s) from replied-to message included below)`;
    }
    if (embedInfos.length > 0) {
      section += `\nEmbeds: ${embedInfos.join(', ')}`;
    }

    return { section, images };
  } catch (err) {
    log?.warn({ err, refId }, 'discord:reply-ref fetch failed');
    return null;
  }
}
