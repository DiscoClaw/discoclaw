import type { Client, Guild } from 'discord.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { TaskStore } from './store.js';
import type { TagMap, TaskSyncResult } from './types.js';
import { runBeadSync } from './bead-sync.js';
import { reloadTagMapInPlace } from './discord-sync.js';
import { taskThreadCache } from './thread-cache.js';

/**
 * Canonical task-named sync coordinator implementation.
 */
export type TaskSyncCoordinatorOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  log?: LoggerLike;
  mentionUserId?: string;
  forumCountSync?: ForumCountSync;
  skipPhase5?: boolean;
};

export class TaskSyncCoordinator {
  private syncing = false;
  private pendingStatusPoster: StatusPoster | undefined | false = false;

  constructor(private readonly opts: TaskSyncCoordinatorOptions) {}

  async sync(statusPoster?: StatusPoster): Promise<TaskSyncResult | null> {
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
          this.opts.log?.warn({ err, tagMapPath: this.opts.tagMapPath }, 'tasks:tag-map reload failed; using cached map');
        }
      }
      // Snapshot tagMap for deterministic behavior within this sync run
      const tagMapSnapshot = { ...this.opts.tagMap };
      const result = await runBeadSync({ ...this.opts, tagMap: tagMapSnapshot, statusPoster });
      taskThreadCache.invalidate();
      this.opts.forumCountSync?.requestUpdate();
      if (result.closesDeferred && result.closesDeferred > 0) {
        this.opts.log?.info({ closesDeferred: result.closesDeferred }, 'tasks:coordinator scheduling retry for deferred closes');
        setTimeout(() => {
          this.sync().catch((err) => {
            this.opts.log?.warn({ err }, 'tasks:coordinator deferred-close retry failed');
          });
        }, 30_000);
      }
      return result;
    } finally {
      this.syncing = false;
      if (this.pendingStatusPoster !== false) {
        const pendingPoster = this.pendingStatusPoster;
        this.pendingStatusPoster = false;
        // Fire-and-forget follow-up for coalesced triggers.
        this.sync(pendingPoster).catch((err) => {
          this.opts.log?.warn({ err }, 'tasks:coordinator follow-up sync failed');
        });
      }
    }
  }
}
