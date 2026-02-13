import type { LoggerLike } from './action-types.js';

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
  let starterId: string | undefined;

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
        starterId = starter.id;
        const line = formatMessageLine(starter, botName, 'thread starter');
        if (line) {
          if (line.length <= remaining) {
            sections.push(line);
            remaining -= line.length + 1;
          } else if (remaining > 50) {
            sections.push(line.slice(0, remaining - 3) + '...');
            remaining = 0;
          }
        }
      }
    } catch (err) {
      opts.log?.warn({ err }, 'thread-context: failed to fetch starter message');
    }
  }

  // 3. Recent thread messages (before the current command message)
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
          if (starterId && m.id === starterId) continue;

          const line = formatMessageLine(m, botName);
          if (!line) continue;

          if (line.length <= remaining) {
            lines.push(line);
            remaining -= line.length + 1;
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
