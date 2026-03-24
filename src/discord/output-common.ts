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

function imagegenSetupWalkthrough(): string {
  return [
    'Setup walkthrough:',
    '1. Open the instance `.env` file used by this bot.',
    '2. Set `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1`.',
    '3. Configure one provider: set `OPENAI_API_KEY` for OpenAI image models, or set `IMAGEGEN_GEMINI_API_KEY` for Gemini/Imagen image models.',
    '4. Optional: set `IMAGEGEN_DEFAULT_MODEL` if you want a specific default such as `dall-e-3`, `gpt-image-1`, or `imagen-4.0-generate-001`.',
    '5. Reload the bot with `!restart`, then retry the image request.',
  ].join(' ');
}

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

export async function editThenSendChunksWithPrefix(
  reply: { edit: (opts: SendOpts) => Promise<unknown> },
  channel: { send: (opts: SendOpts) => Promise<unknown> },
  prefix: string,
  text: string,
  images?: ImageData[],
): Promise<void> {
  const normalizedPrefix = closeFenceIfOpen(String(prefix ?? '').trimEnd());
  if (!normalizedPrefix) {
    await editThenSendChunks(reply, channel, text, images);
    return;
  }

  const attachments = images && images.length > 0 ? buildAttachments(images) : [];
  const chunks = prepareDiscordOutput(text);
  const hasContent = chunks.length > 0 && chunks.some((c) => c.trim().length > 0);
  const hasImages = attachments.length > 0;

  if (!hasContent && !hasImages) {
    await reply.edit({ content: normalizedPrefix, allowedMentions: NO_MENTIONS });
    return;
  }

  if (!hasContent && hasImages) {
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await reply.edit({ content: normalizedPrefix, allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let i = MAX_ATTACHMENTS_PER_MESSAGE; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  let firstContent = normalizedPrefix;
  let remainingText = chunks.slice(1).join('\n');
  const separator = '\n\n';
  const firstChunk = chunks[0] ?? '';
  const availableForFirstChunk = 2000 - normalizedPrefix.length - separator.length;

  if (availableForFirstChunk > 0 && firstChunk.trim().length > 0) {
    const firstChunkPieces = splitDiscord(firstChunk, availableForFirstChunk);
    const firstChunkPiece = firstChunkPieces[0] ?? '';
    if (firstChunkPiece.trim().length > 0) {
      firstContent = `${normalizedPrefix}${separator}${firstChunkPiece}`;
      remainingText = [...firstChunkPieces.slice(1), ...chunks.slice(1)].join('\n');
    } else {
      remainingText = chunks.join('\n');
    }
  } else {
    remainingText = chunks.join('\n');
  }

  if (!remainingText && attachments.length > 0) {
    const firstBatch = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    await reply.edit({ content: firstContent, allowedMentions: NO_MENTIONS, files: firstBatch });
    for (let i = MAX_ATTACHMENTS_PER_MESSAGE; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      await channel.send({ content: '', allowedMentions: NO_MENTIONS, files: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
    }
    return;
  }

  await reply.edit({ content: firstContent, allowedMentions: NO_MENTIONS });
  if (remainingText || attachments.length > 0) {
    await sendChunks(channel, remainingText, images);
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

const DISCORD_ACTION_INTENT_BASE_VERBS = String.raw`create|send|edit|delete|close|open|post|react|launch|remember|forget|pin|unpin|crosspost|archive|ban|kick|timeout|set`;
const DISCORD_ACTION_INTENT_PROGRESSIVE_VERBS = String.raw`creating|sending|editing|deleting|closing|opening|posting|reacting|launching|remembering|forgetting|pinning|unpinning|crossposting|archiving|banning|kicking|setting`;
const DISCORD_ACTION_INTENT_RESOURCE_NOUNS = String.raw`channel|thread|message|reply|task|plan|cron|poll|reaction|pin|user|member|nickname|status|activity|canvas|image|file|attachment|memory|preference|fact|note`;
const DISCORD_ACTION_INTENT_NEGATION_RE =
  /\b(?:i have not started yet|i haven't started yet|have not started yet|haven't started yet|not started yet|i have not begun yet|i haven't begun yet|have not begun yet|haven't begun yet|i am not starting|i'm not starting|i am not doing that yet|i'm not doing that yet|not proceeding now|not handling it now)\b/i;
const DISCORD_ACTION_INTENT_EXPLANATION_RE =
  /\b(?:example(?: only)?|for example|for instance|e\.g\.|i can|i could|i would|you can|you could|you would|if you want|when you're ready|would use|would emit|would send|would create|would run|do not run|don't run|not run)\b/i;
const DISCORD_ACTION_INTENT_PATTERNS = [
  new RegExp(
    String.raw`\b(?:i am|i'm)\s+(?:${DISCORD_ACTION_INTENT_PROGRESSIVE_VERBS})\b[^.!?\n]{0,80}\b(?:${DISCORD_ACTION_INTENT_RESOURCE_NOUNS})s?\b(?:[^.!?\n]{0,40}\b(?:now|already)\b)?`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:i am|i'm)\s+going to\s+(?:${DISCORD_ACTION_INTENT_BASE_VERBS})\b[^.!?\n]{0,80}\b(?:${DISCORD_ACTION_INTENT_RESOURCE_NOUNS})s?\b[^.!?\n]{0,40}\b(?:now|for you|in this response)\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:i will|i'll)\s+(?:go ahead and\s+)?(?:${DISCORD_ACTION_INTENT_BASE_VERBS})\b[^.!?\n]{0,80}\b(?:${DISCORD_ACTION_INTENT_RESOURCE_NOUNS})s?\b[^.!?\n]{0,40}\b(?:now|for you|in this response)\b`,
    'i',
  ),
  /\b(?:(?:i am|i'm)\s+)?proceeding now\b/i,
  /\b(?:(?:i am|i'm)\s+)?already handling (?:it|that|this)(?: now)?\b/i,
  /\b(?:(?:i am|i'm)\s+)?taking the next pass(?: now)?\b/i,
  /\b(?:(?:i am|i'm)\s+)?cleaning(?: [^.!?\n]{0,40})? up now\b/i,
];

function stripCodeLikeDiscordActionText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^(?: {4}|\t).*(?:\r?\n|$)/gm, ' ');
}

export function claimsImmediateDiscordActionIntent(text: string): boolean {
  const normalized = stripCodeLikeDiscordActionText(String(text ?? ''))
    .replace(/[’]/g, '\'')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  const sentences = normalized.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const candidate = sentence.trim();
    if (!candidate) continue;
    if (DISCORD_ACTION_INTENT_NEGATION_RE.test(candidate)) continue;
    if (DISCORD_ACTION_INTENT_EXPLANATION_RE.test(candidate)) continue;
    if (DISCORD_ACTION_INTENT_PATTERNS.some((re) => re.test(candidate))) {
      return true;
    }
  }

  return false;
}

export function buildPromisedDiscordActionWithoutExecutionNotice(
  visibleReplyText: string,
  actionsCount: number,
  actionResultsCount: number,
): string {
  if (actionsCount > 0 || actionResultsCount > 0) return '';
  if (!claimsImmediateDiscordActionIntent(visibleReplyText)) return '';
  return 'Warning: this reply says Discord-managed work is starting or being handled now, but this turn ended with zero actionable `<discord-action>` blocks and zero executed action results. If work has not started yet, say that clearly instead.';
}

export function appendPromisedDiscordActionWithoutExecutionNotice(
  text: string,
  actionsCount: number,
  actionResultsCount: number,
): string {
  const notice = buildPromisedDiscordActionWithoutExecutionNotice(text, actionsCount, actionResultsCount);
  if (!notice) return text;
  const base = closeFenceIfOpen(String(text ?? '').trimEnd());
  return base ? `${base}\n\n${notice}` : notice;
}

/**
 * Known-but-flag-gated action types mapped to actionable enable instructions.
 * Types not listed here are treated as truly unknown (typo or hallucination).
 */
const DISABLED_TYPE_HELP: Record<string, string> = {
  // Image generation — requires DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN + an API key.
  generateImage: imagegenSetupWalkthrough(),
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
  // Canvas Activities — experimental, default-off, and requires Discord Activity setup.
  launchCanvas:
    'Canvas Activities are experimental and disabled by default. Fresh installs and upgraded installs both require an explicit opt-in: set `DISCOCLAW_CANVAS_ENABLED=1`, then complete Discord Activity setup in the Developer Portal (URL Mapping + enable Activities) and expose the canvas endpoint over public HTTPS. No redirect URI or client secret needed; DiscoClaw uses pre-authenticated activity context by default.',
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
  memoryQuery:
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
