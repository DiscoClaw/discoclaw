import type { TextBasedChannel } from 'discord.js';

export type MessageHistoryOpts = {
  budgetChars: number;
  fetchLimit?: number;
  /** Drop messages older than this many milliseconds. 0 or omitted = no cutoff. */
  maxAgeMs?: number;
  botDisplayName?: string;
  excludeMessageIds?: Iterable<string>;
  /** Reference timestamp (epoch ms) for relative-time labels. Defaults to Date.now(). */
  now?: number;
};

/**
 * Format a duration in milliseconds as a compact relative-time label.
 * Examples: "2m ago", "3h ago", "5d ago", "just now".
 */
export function formatRelativeTime(deltaMs: number): string {
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export type MessageHistoryResult = {
  /** Formatted text transcript in chronological order. */
  text: string;
};

const EMPTY_RESULT: MessageHistoryResult = { text: '' };

/**
 * Fetch recent messages from a Discord channel and format them as conversation
 * history suitable for prepending to a prompt.
 *
 * Returns text in chronological order. Messages with attachments or embeds
 * but no text content are represented as `[attachment]` / `[embed]`.
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
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const sorted = [...messages.values()]
    .filter((message) => !excludedMessageIds.has(message.id))
    .filter((message) => {
      if (maxAgeMs <= 0) return true;
      const ts = typeof message.createdTimestamp === 'number' ? message.createdTimestamp : 0;
      return ts > 0 && (now - ts) <= maxAgeMs;
    })
    .reverse();

  if (sorted.length === 0) return EMPTY_RESULT;

  // Build history from most recent backward so the most relevant context is kept.
  let remaining = opts.budgetChars;
  const selected: string[] = [];

  for (let i = sorted.length - 1; i >= 0 && remaining > 0; i--) {
    const m = sorted[i]!;
    const author = m.author.bot ? (opts.botDisplayName ?? 'Discoclaw') : (m.author.displayName || m.author.username);
    let content = String(m.content ?? '').trim();
    if (!content) {
      const atts = (m as unknown as Record<string, unknown>).attachments;
      const hasAttachments = atts && typeof (atts as Record<string, unknown>).size === 'number'
        && (atts as { size: number }).size > 0;
      const embeds = (m as unknown as Record<string, unknown>).embeds;
      const hasEmbeds = Array.isArray(embeds) && embeds.length > 0;
      if (hasAttachments) {
        content = '[attachment]';
      } else if (hasEmbeds) {
        content = '[embed]';
      } else {
        continue;
      }
    }
    const ts = typeof m.createdTimestamp === 'number' ? m.createdTimestamp : 0;
    const age = ts > 0 ? formatRelativeTime(now - ts) : '';
    const tag = age ? `${author}, ${age}` : author;
    const full = `[${tag}]: ${content}`;

    if (m.author.bot && full.length > remaining) {
      // Truncate bot messages to fit remaining budget.
      const prefix = `[${tag}]: `;
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

  const text = selected.length > 0 ? selected.join('\n') : '';
  return { text };
}
