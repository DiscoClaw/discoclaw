import type { TextBasedChannel } from 'discord.js';

export type MessageHistoryOpts = {
  budgetChars: number;
  fetchLimit?: number;
  botDisplayName?: string;
};

/**
 * Fetch recent messages from a Discord channel and format them as conversation
 * history suitable for prepending to a prompt.
 *
 * Returns an empty string if no history is available or on any fetch error.
 */
export async function fetchMessageHistory(
  channel: TextBasedChannel,
  beforeMessageId: string,
  opts: MessageHistoryOpts,
): Promise<string> {
  if (opts.budgetChars <= 0) return '';

  let messages;
  try {
    messages = await channel.messages.fetch({
      before: beforeMessageId,
      limit: opts.fetchLimit ?? 10,
    });
  } catch {
    return '';
  }

  if (!messages || messages.size === 0) return '';

  // Discord API returns newest-first; convert to array and reverse to chronological order.
  const sorted = [...messages.values()].reverse();

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

  if (selected.length === 0) return '';
  return selected.join('\n');
}
