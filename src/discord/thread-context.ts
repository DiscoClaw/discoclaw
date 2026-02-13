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
  fetchStarterMessage?(): Promise<StarterMessage | null>;
  messages: {
    fetch(opts: { before?: string; limit?: number }): Promise<Map<string, ThreadMessage>>;
  };
};

export type StarterMessage = {
  id: string;
  author: { bot?: boolean; displayName?: string; username: string };
  content?: string | null;
};

export type ThreadMessage = {
  id: string;
  author: { bot?: boolean; displayName?: string; username: string };
  content?: string | null;
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

const DEFAULT_BUDGET_CHARS = 2000;
const DEFAULT_RECENT_LIMIT = 5;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Resolve thread context: the thread's starter message and recent posts.
 *
 * Returns null if the channel is not a thread, or if no useful context is found.
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

  // 1. Thread name
  const threadName = channel.name?.trim();
  if (threadName) {
    const nameLine = `Thread: ${threadName}`;
    sections.push(nameLine);
    remaining -= nameLine.length + 1;
  }

  // 2. Starter message (the original post that started the thread)
  if (typeof channel.fetchStarterMessage === 'function') {
    try {
      const starter = await channel.fetchStarterMessage();
      if (starter) {
        const content = String(starter.content ?? '').trim();
        if (content) {
          const author = starter.author.bot
            ? botName
            : (starter.author.displayName || starter.author.username);
          const line = `[${author} (thread starter)]: ${content}`;
          if (line.length <= remaining) {
            sections.push(line);
            remaining -= line.length + 1;
          } else if (remaining > 50) {
            // Truncate to fit
            const truncated = line.slice(0, remaining - 3) + '...';
            sections.push(truncated);
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
        // Discord returns newest-first; reverse to chronological.
        const sorted = [...messages.values()].reverse();

        const lines: string[] = [];
        for (const m of sorted) {
          const content = String(m.content ?? '').trim();
          if (!content) continue;

          const author = m.author.bot
            ? botName
            : (m.author.displayName || m.author.username);
          const line = `[${author}]: ${content}`;

          if (line.length <= remaining) {
            lines.push(line);
            remaining -= line.length + 1;
          } else if (remaining > 50 && m.author.bot) {
            // Truncate bot messages to fit
            const truncated = line.slice(0, remaining - 3) + '...';
            lines.push(truncated);
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

  // Only the thread name isn't useful enough on its own
  if (sections.length <= 1 && threadName) return null;
  if (sections.length === 0) return null;

  return { section: sections.join('\n') };
}
