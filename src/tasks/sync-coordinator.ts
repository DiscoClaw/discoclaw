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

  constructor(private readonly opts: TaskSyncCoordinatorOptions) {}

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
      if (result.closesDeferred && result.closesDeferred > 0) {
        metrics.increment('tasks.sync.retry.scheduled');
        this.opts.log?.info({ closesDeferred: result.closesDeferred }, 'tasks:coordinator scheduling retry for deferred closes');
        setTimeout(() => {
          this.sync().catch((err) => {
            metrics.increment('tasks.sync.retry.failed');
            this.opts.log?.warn({ err }, 'tasks:coordinator deferred-close retry failed');
          });
        }, 30_000);
      }
      return result;
    } catch (err) {
      recordSyncFailureMetrics(metrics, err, Date.now() - startedAtMs);
      throw err;
    } finally {
      this.syncing = false;
      if (this.pendingStatusPoster !== false) {
        const pendingPoster = this.pendingStatusPoster;
        this.pendingStatusPoster = false;
        // Fire-and-forget follow-up for coalesced triggers.
        metrics.increment('tasks.sync.follow_up.scheduled');
        this.sync(pendingPoster).catch((err) => {
          metrics.increment('tasks.sync.follow_up.failed');
          this.opts.log?.warn({ err }, 'tasks:coordinator follow-up sync failed');
        });
      }
    }
  }
}
