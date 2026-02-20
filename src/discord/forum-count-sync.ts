import { ChannelType, type Client } from 'discord.js';
import type { LoggerLike } from './action-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip a trailing `・N` (or legacy ` ・ N`, `(N)`, `-・-N`) count suffix from a forum name. */
export function stripCountSuffix(name: string): string {
  let result = name;
  // Loop to handle stacked corruption (e.g. "tasks-6-・-・-6" from multiple
  // rounds of count-sync running on already-slugified names).
  let prev: string;
  do {
    prev = result;
    // Strip structured suffix: `・N`, ` ・ N`, `-・-N`, or `(N)`.
    result = result.replace(/[\s-]*(?:・[\s-]*\d+|\(\d+\))$/, '');
    // Clean up any trailing separator debris (lone `・` without a count digit).
    result = result.replace(/[\s-]*・[\s-]*$/, '');
    // Strip Discord-slugified numeric suffix (e.g. "tasks-6" from "tasks (6)").
    // Greedy: a forum named "tasks-3" loses the "-3". Acceptable since
    // count sync is the only thing that sets these suffixed names.
    result = result.replace(/-\d+$/, '');
  } while (result !== prev);
  return result;
}

// ---------------------------------------------------------------------------
// ForumCountSync
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 10_000;       // 10s debounce after last requestUpdate()
const MIN_INTERVAL_MS = 5 * 60_000; // 5min minimum between actual setName() calls

/**
 * Keeps a forum channel name in sync with a dynamic item count.
 * Aggressively debounces to stay within Discord's 2-per-10-min channel rename limit.
 */
export class ForumCountSync {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateMs = 0;
  private stopped = false;

  constructor(
    private readonly client: Client,
    private readonly forumId: string,
    private readonly countFn: () => number | Promise<number>,
    private readonly log?: LoggerLike,
  ) {}

  /** Schedule a count update (debounced). */
  requestUpdate(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.execute();
    }, DEBOUNCE_MS);
  }

  /** Cancel all pending timers. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.deferredTimer) { clearTimeout(this.deferredTimer); this.deferredTimer = null; }
  }

  private async execute(): Promise<void> {
    if (this.stopped) return;

    // Rate-limit: if last setName() was too recent, defer.
    const now = Date.now();
    const elapsed = now - this.lastUpdateMs;
    if (elapsed < MIN_INTERVAL_MS && this.lastUpdateMs > 0) {
      const remaining = MIN_INTERVAL_MS - elapsed;
      this.log?.info({ forumId: this.forumId, deferMs: remaining }, 'forum-count-sync: deferred (rate limit)');
      if (this.deferredTimer) clearTimeout(this.deferredTimer);
      this.deferredTimer = setTimeout(() => {
        this.deferredTimer = null;
        void this.execute();
      }, remaining);
      return;
    }

    let count: number;
    try {
      count = await this.countFn();
    } catch (err) {
      this.log?.warn({ err, forumId: this.forumId }, 'forum-count-sync: countFn failed');
      return;
    }

    const channel = this.client.channels.cache.get(this.forumId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      this.log?.warn({ forumId: this.forumId }, 'forum-count-sync: forum channel not found or not a forum');
      return;
    }

    const currentName = channel.name;
    const baseName = stripCountSuffix(currentName);
    const newName = `${baseName}・${count}`;

    if (newName === currentName) {
      this.log?.info({ forumId: this.forumId, name: currentName }, 'forum-count-sync: name unchanged, skipping');
      return;
    }

    try {
      await channel.setName(newName);
      this.lastUpdateMs = Date.now();
      this.log?.info({ forumId: this.forumId, name: newName }, 'forum-count-sync: updated');
    } catch (err: any) {
      // Handle Discord 429 rate limit.
      const retryAfter = err?.retryAfter ?? err?.retry_after;
      if (retryAfter && typeof retryAfter === 'number') {
        const retryMs = retryAfter * 1000;
        this.log?.warn({ forumId: this.forumId, retryAfter }, 'forum-count-sync: rate limited, rescheduling');
        if (this.deferredTimer) clearTimeout(this.deferredTimer);
        this.deferredTimer = setTimeout(() => {
          this.deferredTimer = null;
          void this.execute();
        }, retryMs);
        return;
      }
      this.log?.warn({ err, forumId: this.forumId }, 'forum-count-sync: setName failed');
    }
  }
}
