import { AttachmentBuilder } from 'discord.js';
import { splitDiscord, truncateCodeBlocks, closeFenceIfOpen } from './output-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import type { ImageData } from '../runtime/types.js';
import { QUERY_ACTION_TYPES } from './action-categories.js';

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

/**
 * Known-but-flag-gated action types mapped to actionable enable instructions.
 * Types not listed here are treated as truly unknown (typo or hallucination).
 */
const DISABLED_TYPE_HELP: Record<string, string> = {
  // Image generation — requires DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN + an API key.
  generateImage:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1` in .env (also requires `OPENAI_API_KEY` or `IMAGEGEN_GEMINI_API_KEY`).',
  // Moderation — requires DISCOCLAW_DISCORD_ACTIONS_MODERATION.
  ban: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MODERATION=1` in .env.',
  kick: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MODERATION=1` in .env.',
  timeout: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MODERATION=1` in .env.',
  // Deferred replies — requires DISCOCLAW_DISCORD_ACTIONS_DEFER.
  defer: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_DEFER=1` in .env.',
  // Bot profile — requires DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE.
  botSetStatus: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE=1` in .env.',
  botSetActivity: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE=1` in .env.',
  botSetNickname: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE=1` in .env.',
  // Polls — requires DISCOCLAW_DISCORD_ACTIONS_POLLS.
  poll: 'To enable: set `DISCOCLAW_DISCORD_ACTIONS_POLLS=1` in .env.',
  // Forge — requires DISCOCLAW_DISCORD_ACTIONS_FORGE + DISCOCLAW_FORGE_COMMANDS_ENABLED.
  forgeCreate:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_FORGE=1` and `DISCOCLAW_FORGE_COMMANDS_ENABLED=1` in .env.',
  forgeResume:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_FORGE=1` and `DISCOCLAW_FORGE_COMMANDS_ENABLED=1` in .env.',
  forgeStatus:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_FORGE=1` and `DISCOCLAW_FORGE_COMMANDS_ENABLED=1` in .env.',
  forgeCancel:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_FORGE=1` and `DISCOCLAW_FORGE_COMMANDS_ENABLED=1` in .env.',
  // Plan — requires DISCOCLAW_DISCORD_ACTIONS_PLAN + DISCOCLAW_PLAN_COMMANDS_ENABLED.
  planList:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  planShow:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  planApprove:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  planClose:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  planCreate:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  planRun:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_PLAN=1` and `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in .env.',
  // Memory — requires DISCOCLAW_DISCORD_ACTIONS_MEMORY + DISCOCLAW_DURABLE_MEMORY_ENABLED.
  memoryRemember:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MEMORY=1` and `DISCOCLAW_DURABLE_MEMORY_ENABLED=1` in .env.',
  memoryForget:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MEMORY=1` and `DISCOCLAW_DURABLE_MEMORY_ENABLED=1` in .env.',
  memoryShow:
    'To enable: set `DISCOCLAW_DISCORD_ACTIONS_MEMORY=1` and `DISCOCLAW_DURABLE_MEMORY_ENABLED=1` in .env.',
};

/**
 * Build a user-facing note for action types that were stripped because they
 * were unknown or disabled by the current action category flags.
 *
 * For known-but-disabled types, includes the env var needed to enable them.
 * For truly unknown types, falls back to a generic "unknown type" notice.
 */
export function buildUnavailableActionTypesNotice(strippedTypes: string[]): string {
  const uniqueTypes = Array.from(
    new Set(strippedTypes.map((t) => t.trim()).filter(Boolean)),
  );
  if (uniqueTypes.length === 0) return '';

  const knownLines: string[] = [];
  const unknownTypes: string[] = [];
  const seenHelp = new Set<string>();

  for (const t of uniqueTypes) {
    const help = DISABLED_TYPE_HELP[t];
    if (help) {
      // Deduplicate help lines (e.g. ban + kick share the same message).
      const line = `\`${t}\` is disabled. ${help}`;
      if (!seenHelp.has(help)) {
        seenHelp.add(help);
        // Group types sharing the same help text onto one line.
        const sharedTypes = uniqueTypes.filter((u) => DISABLED_TYPE_HELP[u] === help);
        const label = sharedTypes.map((u) => `\`${u}\``).join(', ');
        knownLines.push(`${label} ${sharedTypes.length === 1 ? 'is' : 'are'} disabled. ${help}`);
      }
    } else {
      unknownTypes.push(t);
    }
  }

  const parts: string[] = [...knownLines];
  if (unknownTypes.length > 0) {
    const rendered = unknownTypes.map((t) => `\`${t}\``).join(', ');
    const noun = unknownTypes.length === 1 ? 'type' : 'types';
    parts.push(`Ignored unavailable action ${noun}: ${rendered} (unknown type or category disabled).`);
  }

  return parts.join('\n');
}

export function appendUnavailableActionTypesNotice(
  text: string,
  strippedTypes: string[],
): string {
  const notice = buildUnavailableActionTypesNotice(strippedTypes);
  if (!notice) return text;
  const base = closeFenceIfOpen(String(text ?? '').trimEnd());
  return base ? `${base}\n\n${notice}` : notice;
}

export function buildParseFailureNotice(count: number): string {
  if (count <= 0) return '';
  if (count === 1) {
    return 'Warning: 1 action block failed to parse (malformed JSON) and was skipped.';
  }
  return `Warning: ${count} action blocks failed to parse (malformed JSON) and were skipped.`;
}

/**
 * Build a placeholder message for a follow-up triggered by a non-query action failure.
 *
 * Returns a formatted string like:
 *   "⚠️ Action failed (`taskCreate`: description too long). Retrying..."
 *
 * Returns null when the follow-up was triggered by a query success rather than a failure.
 */
export function buildFailureRetryPlaceholder(
  actions: { type: string }[],
  results: { ok: boolean; error?: string }[],
): string | null {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const result = results[i];
    if (!action || !result) continue;
    if (result.ok) continue;
    if (QUERY_ACTION_TYPES.has(action.type)) continue;
    const errorText = result.error ?? 'unknown error';
    const truncated = errorText.length > 120 ? errorText.slice(0, 117) + '...' : errorText;
    return `⚠️ Action failed (\`${action.type}\`: ${truncated}). Retrying...`;
  }
  return null;
}

export function appendParseFailureNotice(
  text: string,
  count: number,
): string {
  const notice = buildParseFailureNotice(count);
  if (!notice) return text;
  const base = closeFenceIfOpen(String(text ?? '').trimEnd());
  return base ? `${base}\n\n${notice}` : notice;
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
