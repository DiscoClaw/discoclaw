import type { LoggerLike } from './logger-types.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskDiscordClient, TaskDiscordGuild } from './discord-types.js';
import type { TaskSyncRunOptions } from './sync-types.js';
import type { TaskForumCountSync, TaskInFlightChecker, TaskStatusPoster } from './sync-context.js';
import { noopTaskMetrics, type TaskMetrics } from './metrics-types.js';
import type { TagMap, TaskSyncResult } from './types.js';
import { runTaskSync } from './task-sync-engine.js';
import { reloadTagMapInPlace } from './tag-map.js';
import { taskThreadCache } from './thread-cache.js';
import {
  classifySyncError,
  recordSyncFailureMetrics,
  recordSyncSuccessMetrics,
} from './sync-coordinator-metrics.js';
import {
  cancelDeferredCloseRetry,
  cancelFailureRetry,
  createTaskSyncRetryState,
  scheduleDeferredCloseRetry,
  scheduleFailureRetry,
  type TaskSyncRetryControls,
} from './sync-coordinator-retries.js';

/**
 * Canonical task-named sync coordinator implementation.
 */
type TaskSyncCoordinatorCoreOptions = {
  client: TaskDiscordClient;
  guild: TaskDiscordGuild;
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  taskService?: TaskService;
  log?: LoggerLike;
  mentionUserId?: string;
  forumCountSync?: TaskForumCountSync;
  hasInFlightForChannel?: TaskInFlightChecker;
  metrics?: TaskMetrics;
  enableFailureRetry?: boolean;
  failureRetryDelayMs?: number;
  deferredRetryDelayMs?: number;
};

export type TaskSyncCoordinatorOptions = TaskSyncCoordinatorCoreOptions & TaskSyncRunOptions;

export class TaskSyncCoordinator {
  private syncing = false;
  private pendingStatusPoster: TaskStatusPoster | undefined | false = false;
  private readonly retryState = createTaskSyncRetryState();

  constructor(private readonly opts: TaskSyncCoordinatorOptions) {}

  private retryControls(metrics: TaskMetrics): TaskSyncRetryControls {
    return {
      state: this.retryState,
      metrics,
      log: this.opts.log,
      runSync: () => this.sync(),
      enableFailureRetry: this.opts.enableFailureRetry,
      failureRetryDelayMs: this.opts.failureRetryDelayMs,
      deferredRetryDelayMs: this.opts.deferredRetryDelayMs,
    };
  }

  async sync(statusPoster?: TaskStatusPoster): Promise<TaskSyncResult | null> {
    const metrics = this.opts.metrics ?? noopTaskMetrics;
    const retries = this.retryControls(metrics);

    if (this.syncing) {
      metrics.increment('tasks.sync.coalesced');
      // Preserve the most specific statusPoster from coalesced callers:
      // if any caller passes one, use it for the follow-up.
      if (statusPoster || this.pendingStatusPoster === false) {
        this.pendingStatusPoster = statusPoster;
      }
      return null; // coalesced into the running sync's follow-up
    }
    this.syncing = true;
    metrics.increment('tasks.sync.started');
    const startedAtMs = Date.now();
    try {
      // Reload tag map if path is configured
      if (this.opts.tagMapPath) {
        metrics.increment('tasks.sync.tag_map_reload.attempted');
        try {
          await reloadTagMapInPlace(this.opts.tagMapPath, this.opts.tagMap);
          metrics.increment('tasks.sync.tag_map_reload.succeeded');
        } catch (err) {
          metrics.increment('tasks.sync.tag_map_reload.failed');
          this.opts.log?.warn({ err, tagMapPath: this.opts.tagMapPath }, 'tasks:tag-map reload failed; using cached map');
        }
      }

      // Snapshot tagMap for deterministic behavior within this sync run
      const tagMapSnapshot = { ...this.opts.tagMap };
      const result = await runTaskSync({ ...this.opts, tagMap: tagMapSnapshot, statusPoster });
      taskThreadCache.invalidate();
      this.opts.forumCountSync?.requestUpdate();
      recordSyncSuccessMetrics(metrics, result, Date.now() - startedAtMs);
      cancelFailureRetry(retries);
      if (result.closesDeferred && result.closesDeferred > 0) {
        scheduleDeferredCloseRetry(retries, result.closesDeferred);
      } else {
        cancelDeferredCloseRetry(retries);
      }
      return result;
    } catch (err) {
      recordSyncFailureMetrics(metrics, err, Date.now() - startedAtMs);
      cancelDeferredCloseRetry(retries);
      scheduleFailureRetry(retries);
      throw err;
    } finally {
      this.syncing = false;
      if (this.pendingStatusPoster !== false) {
        const pendingPoster = this.pendingStatusPoster;
        this.pendingStatusPoster = false;
        // Fire-and-forget follow-up for coalesced triggers.
        metrics.increment('tasks.sync.follow_up.scheduled');
        metrics.increment('tasks.sync.follow_up.triggered');
        this.sync(pendingPoster)
          .then(() => {
            metrics.increment('tasks.sync.follow_up.succeeded');
          })
          .catch((err) => {
            metrics.increment('tasks.sync.follow_up.failed');
            const message = err instanceof Error ? err.message : String(err ?? '');
            metrics.increment(`tasks.sync.follow_up.error_class.${classifySyncError(message)}`);
            this.opts.log?.warn({ err }, 'tasks:coordinator follow-up sync failed');
          });
      }
    }
  }
}
