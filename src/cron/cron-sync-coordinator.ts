import type { Client } from 'discord.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { CronRunStats } from './run-stats.js';
import type { CronScheduler } from './scheduler.js';
import type { TagMap } from './discord-sync.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { CronSyncResult } from './cron-sync.js';
import { reloadCronTagMapInPlace } from './tag-map.js';
import { runCronSync } from './cron-sync.js';

export type CronSyncCoordinatorOptions = {
  client: Client;
  forumId: string;
  scheduler: CronScheduler;
  statsStore: CronRunStats;
  runtime: RuntimeAdapter;
  tagMap: TagMap;
  tagMapPath: string;
  autoTag: boolean;
  autoTagModel: string;
  cwd: string;
  log?: LoggerLike;
  forumCountSync?: ForumCountSync;
};

/**
 * Shared cron sync coordinator wrapping runCronSync() with a concurrency guard,
 * tag-map reload, and deterministic snapshotting. Mirrors TaskSyncCoordinator.
 */
export class CronSyncCoordinator {
  private syncing = false;
  private pendingSync = false;

  constructor(private opts: CronSyncCoordinatorOptions) {}

  /** Update the auto-tag model at runtime (called by modelSet propagation). */
  setAutoTagModel(model: string): void {
    this.opts = { ...this.opts, autoTagModel: model };
  }

  /**
   * Run sync with concurrency guard.
   * Returns null when coalesced into a running sync's follow-up.
   */
  async sync(): Promise<CronSyncResult | null> {
    if (this.syncing) {
      this.pendingSync = true;
      return null;
    }
    this.syncing = true;
    try {
      // Reload tag map from disk before sync
      if (this.opts.tagMapPath) {
        try {
          await reloadCronTagMapInPlace(this.opts.tagMapPath, this.opts.tagMap);
        } catch (err) {
          this.opts.log?.warn({ err, tagMapPath: this.opts.tagMapPath }, 'cron:coordinator tag-map reload failed; using cached map');
        }
      }
      // Snapshot for deterministic behavior within this sync run
      const tagMapSnapshot = { ...this.opts.tagMap };
      const result = await runCronSync({
        client: this.opts.client,
        forumId: this.opts.forumId,
        scheduler: this.opts.scheduler,
        statsStore: this.opts.statsStore,
        runtime: this.opts.runtime,
        tagMap: tagMapSnapshot,
        autoTag: this.opts.autoTag,
        autoTagModel: this.opts.autoTagModel,
        cwd: this.opts.cwd,
        log: this.opts.log,
      });
      this.opts.forumCountSync?.requestUpdate();
      return result;
    } finally {
      this.syncing = false;
      if (this.pendingSync) {
        this.pendingSync = false;
        // Fire-and-forget follow-up for coalesced triggers
        this.sync().catch((err) => {
          this.opts.log?.warn({ err }, 'cron:coordinator follow-up sync failed');
        });
      }
    }
  }
}
