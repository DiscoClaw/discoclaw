import type { Client, Guild } from 'discord.js';
import type { TagMap, BeadSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import { runBeadSync } from './bead-sync.js';
import { reloadTagMapInPlace } from './discord-sync.js';
import { beadThreadCache } from './bead-thread-cache.js';

export type CoordinatorOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  beadsCwd: string;
  log?: LoggerLike;
  mentionUserId?: string;
  forumCountSync?: ForumCountSync;
  skipPhase5?: boolean;
};

export type SyncSource = 'watcher' | 'user';

/**
 * Shared sync coordinator that wraps runBeadSync() with a concurrency guard
 * and cache invalidation. Used by file watcher, startup sync, and beadSync action.
 */
export class BeadSyncCoordinator {
  private syncing = false;
  private pendingStatusPoster: StatusPoster | undefined | false = false;
  private suppressedUntil = 0;
  private catchUpScheduled = false;

  constructor(private readonly opts: CoordinatorOptions) {}

  /**
   * Suppress watcher-triggered syncs for the given duration.
   * User-triggered syncs always bypass suppression.
   * After the window expires, a catch-up sync fires automatically.
   */
  suppressSync(durationMs: number): void {
    this.suppressedUntil = Date.now() + durationMs;
  }

  /**
   * Run sync with concurrency guard.
   * - statusPoster: pass for explicit user-triggered syncs (beadSync action);
   *   omit for auto-triggered syncs (watcher, startup) to avoid status channel noise.
   * - source: 'watcher' for file-watcher triggered syncs (respects suppression),
   *   'user' (default) for user-initiated syncs (always runs).
   */
  async sync(statusPoster?: StatusPoster, source: SyncSource = 'user'): Promise<BeadSyncResult | null> {
    // Watcher-triggered syncs respect the suppression window.
    if (source === 'watcher' && Date.now() < this.suppressedUntil) {
      if (!this.catchUpScheduled) {
        this.catchUpScheduled = true;
        const delayMs = Math.max(0, this.suppressedUntil - Date.now());
        setTimeout(() => {
          this.catchUpScheduled = false;
          this.sync(undefined, 'watcher').catch((err) => {
            this.opts.log?.warn({ err }, 'beads:coordinator catch-up sync failed');
          });
        }, delayMs);
      }
      return null;
    }

    if (this.syncing) {
      // Preserve the most specific statusPoster from coalesced callers:
      // if any caller passes one, use it for the follow-up.
      if (statusPoster || this.pendingStatusPoster === false) {
        this.pendingStatusPoster = statusPoster;
      }
      return null; // coalesced into the running sync's follow-up
    }
    this.syncing = true;
    try {
      // Reload tag map if path is configured
      if (this.opts.tagMapPath) {
        try {
          await reloadTagMapInPlace(this.opts.tagMapPath, this.opts.tagMap);
        } catch (err) {
          this.opts.log?.warn({ err, tagMapPath: this.opts.tagMapPath }, 'beads:tag-map reload failed; using cached map');
        }
      }
      // Snapshot tagMap for deterministic behavior within this sync run
      const tagMapSnapshot = { ...this.opts.tagMap };
      const result = await runBeadSync({ ...this.opts, tagMap: tagMapSnapshot, statusPoster });
      beadThreadCache.invalidate();
      this.opts.forumCountSync?.requestUpdate();
      return result;
    } finally {
      this.syncing = false;
      if (this.pendingStatusPoster !== false) {
        const pendingPoster = this.pendingStatusPoster;
        this.pendingStatusPoster = false;
        // Fire-and-forget follow-up for coalesced triggers
        this.sync(pendingPoster).catch((err) => {
          this.opts.log?.warn({ err }, 'beads:coordinator follow-up sync failed');
        });
      }
    }
  }
}
