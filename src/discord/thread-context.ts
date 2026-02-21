import type { LoggerLike } from '../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadContextResult = {
  /** Formatted context string ready for injection into forge/plan descriptions. */
  section: string;
};

/** Minimal shape for a Discord thread channel. */
export type ThreadLikeChannel = {
  isThread(): boolean;
  name?: string;
  id?: string;
  fetchStarterMessage?(): Promise<ThreadMessage | null>;
  messages: {
    fetch(opts: { before?: string; limit?: number }): Promise<Map<string, ThreadMessage>>;
    fetchPinned?(): Promise<Map<string, ThreadMessage>>;
  };
};

export type ThreadMessage = {
  id: string;
  author: { bot?: boolean; displayName?: string; username: string };
  content?: string | null;
  attachments?: { size: number } | Map<string, unknown>;
  embeds?: { length: number } | unknown[];
};

export type ThreadContextOpts = {
  /** Max characters for the combined thread context. */
  budgetChars?: number;
  /** Max number of recent messages to fetch. */
  recentMessageLimit?: number;
  /** Bot display name for formatting. */
  botDisplayName?: string;
  /** Include pinned-thread posts in the context output. */
  includePinned?: boolean;
  log?: LoggerLike;
};

const DEFAULT_BUDGET_CHARS = 3000;
const DEFAULT_RECENT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasMedia(m: ThreadMessage): boolean {
  const attSize = m.attachments && ('size' in m.attachments ? m.attachments.size : 0);
  const embLen = m.embeds && ('length' in m.embeds ? m.embeds.length : 0);
  return (attSize ?? 0) > 0 || (embLen ?? 0) > 0;
}

function formatMessageLine(m: ThreadMessage, botName: string, suffix?: string): string | null {
  const content = String(m.content ?? '').trim();
  const author = m.author.bot
    ? botName
    : (m.author.displayName || m.author.username);
  const tag = suffix ? ` (${suffix})` : '';

  if (content) {
    return `[${author}${tag}]: ${content}`;
  }
  if (hasMedia(m)) {
    return `[${author}${tag}]: [attachment/embed]`;
  }
  return null; // no content and no media — skip
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Resolve thread context: the thread's starter message and recent posts.
 *
 * Returns null if the channel is not a thread.
 * When only the thread name is available, returns it alone (still useful context).
 * Errors are caught and logged — never throws.
 */
export async function resolveThreadContext(
  channel: ThreadLikeChannel,
  currentMessageId: string,
  opts: ThreadContextOpts = {},
): Promise<ThreadContextResult | null> {
  if (!channel.isThread()) return null;

  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const recentLimit = opts.recentMessageLimit ?? DEFAULT_RECENT_LIMIT;
  const botName = opts.botDisplayName ?? 'Discoclaw';

  const sections: string[] = [];
  let remaining = budget;
  const seenMessageIds = new Set<string>();

  // 1. Thread name
  const threadName = channel.name?.trim();
  if (threadName) {
    sections.push(`Thread: "${threadName}"`);
  }

  // 2. Starter message (the original post that started the thread)
    if (typeof channel.fetchStarterMessage === 'function') {
      try {
        const starter = await channel.fetchStarterMessage();
        if (starter) {
          const line = formatMessageLine(starter, botName, 'thread starter');
          if (line) {
          if (line.length <= remaining) {
            sections.push(line);
            remaining -= line.length + 1;
            seenMessageIds.add(starter.id);
          } else if (remaining > 50) {
            sections.push(line.slice(0, remaining - 3) + '...');
            remaining = 0;
            seenMessageIds.add(starter.id);
          }
        }
      }
    } catch (err) {
      opts.log?.warn({ err }, 'thread-context: failed to fetch starter message');
    }
  }

  // 3. Pinned thread messages (optional)
  if (opts.includePinned && remaining > 50) {
    const fetchPinned = channel.messages.fetchPinned;
    if (typeof fetchPinned === 'function') {
      try {
        const pinned = await fetchPinned.call(channel.messages);
        if (pinned && pinned.size > 0) {
          const sorted = Array.from(pinned.values())
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

          const pinnedLines: string[] = [];
          const maxPinnedLines = 3;
          for (const m of sorted) {
            if (pinnedLines.length >= maxPinnedLines) break;
            if (remaining <= 0) break;
            if (m.id && seenMessageIds.has(m.id)) continue;

            const line = formatMessageLine(m, botName, 'pinned');
            if (!line) continue;

            if (line.length <= remaining) {
              pinnedLines.push(line);
              remaining -= line.length + 1;
              if (m.id) seenMessageIds.add(m.id);
            } else if (remaining > 50) {
              pinnedLines.push(line.slice(0, remaining - 3) + '...');
              remaining = 0;
              if (m.id) seenMessageIds.add(m.id);
              break;
            } else {
              break;
            }
          }

          if (pinnedLines.length > 0) {
            sections.push('Pinned thread messages:');
            sections.push(...pinnedLines);
          }
        }
      } catch (err) {
        opts.log?.warn({ err }, 'thread-context: failed to fetch pinned messages');
      }
    }
  }

  // 4. Recent thread messages (before the current command message)
  if (remaining > 50 && recentLimit > 0) {
    try {
      const messages = await channel.messages.fetch({
        before: currentMessageId,
        limit: recentLimit,
      });

      if (messages && messages.size > 0) {
        // Sort by snowflake ID (ascending = chronological).
        const sorted = Array.from(messages.values())
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

        const lines: string[] = [];
        for (const m of sorted) {
          // Deduplicate: skip the starter message if it appears in recent messages
          if (m.id && seenMessageIds.has(m.id)) continue;

          const line = formatMessageLine(m, botName);
          if (!line) continue;

          if (line.length <= remaining) {
            lines.push(line);
            remaining -= line.length + 1;
            if (m.id) seenMessageIds.add(m.id);
          } else if (remaining > 50 && m.author.bot) {
            lines.push(line.slice(0, remaining - 3) + '...');
            remaining = 0;
            break;
          } else {
            break;
          }
        }

        if (lines.length > 0) {
          sections.push('Recent thread messages:');
          sections.push(...lines);
        }
      }
    } catch (err) {
      opts.log?.warn({ err }, 'thread-context: failed to fetch recent messages');
    }
  }

  if (sections.length === 0) return null;

  return { section: sections.join('\n') };
}
