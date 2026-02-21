import type { Client, Guild } from 'discord.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { LoggerLike } from '../discord/action-types.js';
import { globalMetrics, type MetricsRegistry } from '../observability/metrics.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TagMap, TaskSyncResult } from './types.js';
import { runTaskSync } from './task-sync-engine.js';
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
  taskService?: TaskService;
  log?: LoggerLike;
  mentionUserId?: string;
  forumCountSync?: ForumCountSync;
  skipPhase5?: boolean;
  metrics?: Pick<MetricsRegistry, 'increment'>;
  enableFailureRetry?: boolean;
  failureRetryDelayMs?: number;
  deferredRetryDelayMs?: number;
};

function classifySyncError(message?: string): string {
  const msg = String(message ?? '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg.includes('timed out')) return 'timeout';
  if (msg.includes('missing permissions') || msg.includes('missing access')) return 'discord_permissions';
  if (msg.includes('unauthorized') || msg.includes('auth')) return 'auth';
  if (msg.includes('stream stall')) return 'stream_stall';
  return 'other';
}

function incrementIfPositive(
  metrics: Pick<MetricsRegistry, 'increment'>,
  name: string,
  value?: number,
): void {
  const count = Number(value ?? 0);
  if (count > 0) metrics.increment(name, count);
}

function recordSyncSuccessMetrics(
  metrics: Pick<MetricsRegistry, 'increment'>,
  result: TaskSyncResult,
  durationMs: number,
): void {
  metrics.increment('tasks.sync.succeeded');
  metrics.increment('tasks.sync.duration_ms.total', Math.max(0, durationMs));
  metrics.increment('tasks.sync.duration_ms.samples');
  incrementIfPositive(metrics, 'tasks.sync.transition.threads_created', result.threadsCreated);
  incrementIfPositive(metrics, 'tasks.sync.transition.thread_names_updated', result.emojisUpdated);
  incrementIfPositive(metrics, 'tasks.sync.transition.starter_messages_updated', result.starterMessagesUpdated);
  incrementIfPositive(metrics, 'tasks.sync.transition.threads_archived', result.threadsArchived);
  incrementIfPositive(metrics, 'tasks.sync.transition.statuses_updated', result.statusesUpdated);
  incrementIfPositive(metrics, 'tasks.sync.transition.tags_updated', result.tagsUpdated);
  incrementIfPositive(metrics, 'tasks.sync.transition.threads_reconciled', result.threadsReconciled);
  incrementIfPositive(metrics, 'tasks.sync.transition.orphan_threads_found', result.orphanThreadsFound);
  incrementIfPositive(metrics, 'tasks.sync.transition.closes_deferred', result.closesDeferred);
  incrementIfPositive(metrics, 'tasks.sync.transition.warnings', result.warnings);
}

function recordSyncFailureMetrics(
  metrics: Pick<MetricsRegistry, 'increment'>,
  error: unknown,
  durationMs: number,
): void {
  metrics.increment('tasks.sync.failed');
  metrics.increment('tasks.sync.duration_ms.total', Math.max(0, durationMs));
  metrics.increment('tasks.sync.duration_ms.samples');
  const message = error instanceof Error ? error.message : String(error ?? '');
  metrics.increment(`tasks.sync.error_class.${classifySyncError(message)}`);
}

export class TaskSyncCoordinator {
  private syncing = false;
  private pendingStatusPoster: StatusPoster | undefined | false = false;
  private failureRetryPending = false;
  private deferredCloseRetryPending = false;
  private failureRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  private deferredCloseRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TaskSyncCoordinatorOptions) {}

  private scheduleFailureRetry(metrics: Pick<MetricsRegistry, 'increment'>): void {
    if (this.opts.enableFailureRetry === false) {
      metrics.increment('tasks.sync.failure_retry.disabled');
      return;
    }
    if (this.failureRetryPending) {
      metrics.increment('tasks.sync.failure_retry.coalesced');
      return;
    }

    this.failureRetryPending = true;
    const delayMs = this.opts.failureRetryDelayMs ?? 30_000;
    metrics.increment('tasks.sync.failure_retry.scheduled');
    this.opts.log?.info({ delayMs }, 'tasks:coordinator scheduling retry after sync failure');

    this.failureRetryTimeout = setTimeout(() => {
      this.failureRetryPending = false;
      this.failureRetryTimeout = null;
      metrics.increment('tasks.sync.failure_retry.triggered');
      this.sync().catch((err) => {
        metrics.increment('tasks.sync.failure_retry.failed');
        const message = err instanceof Error ? err.message : String(err ?? '');
        metrics.increment(`tasks.sync.failure_retry.error_class.${classifySyncError(message)}`);
        this.opts.log?.warn({ err }, 'tasks:coordinator failure retry sync failed');
      });
    }, delayMs);
  }

  private cancelFailureRetry(metrics: Pick<MetricsRegistry, 'increment'>): void {
    if (!this.failureRetryPending || !this.failureRetryTimeout) return;
    clearTimeout(this.failureRetryTimeout);
    this.failureRetryTimeout = null;
    this.failureRetryPending = false;
    metrics.increment('tasks.sync.failure_retry.canceled');
  }

  private scheduleDeferredCloseRetry(
    metrics: Pick<MetricsRegistry, 'increment'>,
    closesDeferred: number,
  ): void {
    if (this.deferredCloseRetryPending) {
      metrics.increment('tasks.sync.retry.coalesced');
      return;
    }

    this.deferredCloseRetryPending = true;
    const delayMs = this.opts.deferredRetryDelayMs ?? 30_000;
    metrics.increment('tasks.sync.retry.scheduled');
    this.opts.log?.info(
      { closesDeferred, delayMs },
      'tasks:coordinator scheduling retry for deferred closes',
    );

    this.deferredCloseRetryTimeout = setTimeout(() => {
      this.deferredCloseRetryPending = false;
      this.deferredCloseRetryTimeout = null;
      metrics.increment('tasks.sync.retry.triggered');
      this.sync().catch((err) => {
        metrics.increment('tasks.sync.retry.failed');
        const message = err instanceof Error ? err.message : String(err ?? '');
        metrics.increment(`tasks.sync.retry.error_class.${classifySyncError(message)}`);
        this.opts.log?.warn({ err }, 'tasks:coordinator deferred-close retry failed');
      });
    }, delayMs);
  }

  private cancelDeferredCloseRetry(metrics: Pick<MetricsRegistry, 'increment'>): void {
    if (!this.deferredCloseRetryPending || !this.deferredCloseRetryTimeout) return;
    clearTimeout(this.deferredCloseRetryTimeout);
    this.deferredCloseRetryTimeout = null;
    this.deferredCloseRetryPending = false;
    metrics.increment('tasks.sync.retry.canceled');
  }

  async sync(statusPoster?: StatusPoster): Promise<TaskSyncResult | null> {
    const metrics = this.opts.metrics ?? globalMetrics;
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
        try {
          await reloadTagMapInPlace(this.opts.tagMapPath, this.opts.tagMap);
        } catch (err) {
          this.opts.log?.warn({ err, tagMapPath: this.opts.tagMapPath }, 'tasks:tag-map reload failed; using cached map');
        }
      }
      // Snapshot tagMap for deterministic behavior within this sync run
      const tagMapSnapshot = { ...this.opts.tagMap };
      const result = await runTaskSync({ ...this.opts, tagMap: tagMapSnapshot, statusPoster });
      taskThreadCache.invalidate();
      this.opts.forumCountSync?.requestUpdate();
      recordSyncSuccessMetrics(metrics, result, Date.now() - startedAtMs);
      this.cancelFailureRetry(metrics);
      if (result.closesDeferred && result.closesDeferred > 0) {
        this.scheduleDeferredCloseRetry(metrics, result.closesDeferred);
      } else {
        this.cancelDeferredCloseRetry(metrics);
      }
      return result;
    } catch (err) {
      recordSyncFailureMetrics(metrics, err, Date.now() - startedAtMs);
      this.cancelDeferredCloseRetry(metrics);
      this.scheduleFailureRetry(metrics);
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
