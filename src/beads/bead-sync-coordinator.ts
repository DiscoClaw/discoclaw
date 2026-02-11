import type { Client, Guild } from 'discord.js';
import type { TagMap, BeadSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import { runBeadSync } from './bead-sync.js';
import { beadThreadCache } from './bead-thread-cache.js';

export type CoordinatorOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  beadsCwd: string;
  log?: LoggerLike;
};

/**
 * Shared sync coordinator that wraps runBeadSync() with a concurrency guard
 * and cache invalidation. Used by file watcher, startup sync, and beadSync action.
 */
export class BeadSyncCoordinator {
  private syncing = false;
  private pendingStatusPoster: StatusPoster | undefined | false = false;

  constructor(private readonly opts: CoordinatorOptions) {}

  /**
   * Run sync with concurrency guard.
   * - statusPoster: pass for explicit user-triggered syncs (beadSync action);
   *   omit for auto-triggered syncs (watcher, startup) to avoid status channel noise.
   */
  async sync(statusPoster?: StatusPoster): Promise<BeadSyncResult | null> {
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
      const result = await runBeadSync({ ...this.opts, statusPoster });
      beadThreadCache.invalidate();
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
