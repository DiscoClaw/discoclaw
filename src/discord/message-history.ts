import type { TextBasedChannel } from 'discord.js';

import type { AttachmentLike } from './image-download.js';

export type MessageHistoryOpts = {
  budgetChars: number;
  fetchLimit?: number;
  botDisplayName?: string;
  excludeMessageIds?: Iterable<string>;
};

export type MessageHistoryResult = {
  /** Formatted text transcript in chronological order. */
  text: string;
  /** Attachments from history messages, ordered newest-first for budget trimming. */
  historyAttachments: AttachmentLike[];
};

const EMPTY_RESULT: MessageHistoryResult = { text: '', historyAttachments: [] };

/**
 * Fetch recent messages from a Discord channel and format them as conversation
 * history suitable for prepending to a prompt.
 *
 * Returns text in chronological order and attachments newest-first so the
 * caller can trim to an image budget starting from the most recent.
 */
export async function fetchMessageHistory(
  channel: TextBasedChannel,
  beforeMessageId: string | undefined,
  opts: MessageHistoryOpts,
): Promise<MessageHistoryResult> {
  if (opts.budgetChars <= 0) return EMPTY_RESULT;

  const excludedMessageIds = new Set(opts.excludeMessageIds ?? []);
  const requestedLimit = Math.max(0, opts.fetchLimit ?? 10);
  if (requestedLimit <= 0) return EMPTY_RESULT;

  let messages;
  try {
    const limit = Math.min(100, requestedLimit + excludedMessageIds.size);
    messages = await channel.messages.fetch(
      beforeMessageId
        ? { before: beforeMessageId, limit }
        : { limit },
    );
  } catch {
    return EMPTY_RESULT;
  }

  if (!messages || messages.size === 0) return EMPTY_RESULT;

  // Discord API returns newest-first; convert to array and reverse to chronological order.
  const sorted = [...messages.values()]
    .filter((message) => !excludedMessageIds.has(message.id))
    .reverse();

  if (sorted.length === 0) return EMPTY_RESULT;

  // Build history from most recent backward so the most relevant context is kept.
  let remaining = opts.budgetChars;
  const selected: string[] = [];

  for (let i = sorted.length - 1; i >= 0 && remaining > 0; i--) {
    const m = sorted[i]!;
    const author = m.author.bot ? (opts.botDisplayName ?? 'Discoclaw') : (m.author.displayName || m.author.username);
    const content = String(m.content ?? '');
    const full = `[${author}]: ${content}`;

    if (m.author.bot && full.length > remaining) {
      // Truncate bot messages to fit remaining budget.
      const prefix = `[${author}]: `;
      const maxContent = Math.max(0, remaining - prefix.length - 3);
      if (maxContent <= 0) break;
      selected.unshift(`${prefix}${content.slice(0, maxContent)}...`);
      remaining = 0;
    } else if (full.length > remaining) {
      // User message doesn't fit — stop.
      break;
    } else {
      selected.unshift(full);
      remaining -= full.length + 1; // +1 for newline separator
    }
  }

  // Extract attachments newest-first for downstream image budget trimming.
  const historyAttachments: AttachmentLike[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i]!;
    const atts = (m as unknown as Record<string, unknown>).attachments;
    if (atts && typeof (atts as Record<string, unknown>).values === 'function') {
      for (const a of (atts as { values(): Iterable<AttachmentLike> }).values()) {
        historyAttachments.push(a);
      }
    }
  }

  const text = selected.length > 0 ? selected.join('\n') : '';
  return { text, historyAttachments };
}
