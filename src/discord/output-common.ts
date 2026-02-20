import { AttachmentBuilder } from 'discord.js';
import { splitDiscord, truncateCodeBlocks } from './output-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import type { ImageData } from '../runtime/types.js';

export function prepareDiscordOutput(text: string): string[] {
  const outText = truncateCodeBlocks(text);
  return splitDiscord(outText);
}

export function imageMediaTypeToExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpeg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}

export function buildAttachments(images: ImageData[]): AttachmentBuilder[] {
  return images.map((img, i) => {
    const ext = imageMediaTypeToExtension(img.mediaType);
    const buf = Buffer.from(img.base64, 'base64');
    return new AttachmentBuilder(buf, { name: `image-${i + 1}.${ext}` });
  });
}

// Discord allows max 10 attachments per message.
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

type SendOpts = { content: string; allowedMentions: unknown; files?: AttachmentBuilder[] };

export async function editThenSendChunks(
  reply: { edit: (opts: SendOpts) => Promise<unknown> },
  channel: { send: (opts: SendOpts) => Promise<unknown> },
  text: string,
  images?: ImageData[],
): Promise<void> {
  const attachments = images && images.length > 0 ? buildAttachments(images) : [];
  const chunks = prepareDiscordOutput(text);

  const hasContent = chunks.length > 0 && chunks.some((c) => c.trim().length > 0);
  const hasImages = attachments.length > 0;

  if (!hasContent && !hasImages) {
    await reply.edit({ content: '(no output)', allowedMentions: NO_MENTIONS });
    return;
  }

  if (!hasContent && hasImages) {
    // Image-only: send with empty content string.
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await reply.edit({ content: '', allowedMentions: NO_MENTIONS, files: firstBatch });
    // Overflow images in extra messages.
    for (let i = MAX_ATTACHMENTS_PER_MESSAGE; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  // Text + optional images: attach images to the last chunk.
  const lastIdx = chunks.length - 1;

  if (lastIdx === 0 && attachments.length > 0) {
    // Single chunk with images: one edit with files attached.
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await reply.edit({ content: chunks[0] ?? '(no output)', allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let j = MAX_ATTACHMENTS_PER_MESSAGE; j < attachments.length; j += MAX_ATTACHMENTS_PER_MESSAGE) {
      await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(j, j + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  // Multi-chunk: first chunk via edit, rest via send, images on last chunk.
  await reply.edit({ content: chunks[0] ?? '(no output)', allowedMentions: NO_MENTIONS });
  for (let i = 1; i < chunks.length; i++) {
    if (i === lastIdx && attachments.length > 0) {
      const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      await channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS, files: firstBatch });
      for (let j = MAX_ATTACHMENTS_PER_MESSAGE; j < attachments.length; j += MAX_ATTACHMENTS_PER_MESSAGE) {
        await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(j, j + MAX_ATTACHMENTS_PER_MESSAGE) });
      }
    } else {
      await channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS });
    }
  }
}

export async function replyThenSendChunks(
  message: {
    reply: (opts: SendOpts) => Promise<unknown>;
    channel: { send: (opts: SendOpts) => Promise<unknown> };
  },
  text: string,
  images?: ImageData[],
): Promise<void> {
  const attachments = images && images.length > 0 ? buildAttachments(images) : [];
  const chunks = prepareDiscordOutput(text);

  const hasContent = chunks.length > 0 && chunks.some((c) => c.trim().length > 0);
  const hasImages = attachments.length > 0;

  if (!hasContent && !hasImages) {
    await message.reply({ content: '(no output)', allowedMentions: NO_MENTIONS });
    return;
  }

  if (!hasContent && hasImages) {
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await message.reply({ content: '', allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let i = MAX_ATTACHMENTS_PER_MESSAGE; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      await message.channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  const lastIdx = chunks.length - 1;
  if (lastIdx === 0 && attachments.length > 0) {
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await message.reply({ content: chunks[0] ?? '(no output)', allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let j = MAX_ATTACHMENTS_PER_MESSAGE; j < attachments.length; j += MAX_ATTACHMENTS_PER_MESSAGE) {
      await message.channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(j, j + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  await message.reply({ content: chunks[0] ?? '(no output)', allowedMentions: NO_MENTIONS });
  for (let i = 1; i < chunks.length; i++) {
    if (i === lastIdx && attachments.length > 0) {
      const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      await message.channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS, files: firstBatch });
      for (let j = MAX_ATTACHMENTS_PER_MESSAGE; j < attachments.length; j += MAX_ATTACHMENTS_PER_MESSAGE) {
        await message.channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(j, j + MAX_ATTACHMENTS_PER_MESSAGE) });
      }
    } else {
      await message.channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS });
    }
  }
}

/**
 * Decides whether a follow-up placeholder message should be suppressed.
 *
 * Suppress when there is effectively no output: no actions, no images, no
 * stripped-unrecognized blocks, and the cleaned text is under 50 chars.
 *
 * Never suppress when strippedUnrecognizedCount > 0 — the AI tried to act
 * but the action type was unknown/disabled, so the user must see "(no output)"
 * rather than a silent delete.
 */
export function shouldSuppressFollowUp(
  processedText: string,
  actionsCount: number,
  imagesCount: number,
  strippedUnrecognizedCount: number,
): boolean {
  if (strippedUnrecognizedCount > 0) return false;
  if (actionsCount > 0 || imagesCount > 0) return false;
  const chars = processedText.replace(/\s+/g, ' ').trim().length;
  return chars < 50;
}

export async function sendChunks(
  channel: { send: (opts: SendOpts) => Promise<unknown> },
  text: string,
  images?: ImageData[],
): Promise<void> {
  const attachments = images && images.length > 0 ? buildAttachments(images) : [];
  const chunks = prepareDiscordOutput(text);

  const hasContent = chunks.length > 0 && chunks.some((c) => c.trim().length > 0);
  const hasImages = attachments.length > 0;

  if (!hasContent && hasImages) {
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let i = MAX_ATTACHMENTS_PER_MESSAGE; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  const lastIdx = chunks.length - 1;
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].trim()) continue;
    if (i === lastIdx && attachments.length > 0) {
      const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      await channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS, files: firstBatch });
      for (let j = MAX_ATTACHMENTS_PER_MESSAGE; j < attachments.length; j += MAX_ATTACHMENTS_PER_MESSAGE) {
        await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(j, j + MAX_ATTACHMENTS_PER_MESSAGE) });
      }
    } else {
      await channel.send({ content: chunks[i], allowedMentions: NO_MENTIONS });
    }
  }
}
