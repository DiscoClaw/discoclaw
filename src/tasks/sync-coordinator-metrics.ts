import type { TaskMetrics } from './metrics-types.js';
import type { TaskSyncResult } from './types.js';

export function classifySyncError(message?: string): string {
  const msg = String(message ?? '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg.includes('timed out')) return 'timeout';
  if (msg.includes('missing permissions') || msg.includes('missing access')) return 'discord_permissions';
  if (msg.includes('unauthorized') || msg.includes('auth')) return 'auth';
  if (msg.includes('stream stall')) return 'stream_stall';
  return 'other';
}

function incrementIfPositive(
  metrics: TaskMetrics,
  name: string,
  value?: number,
): void {
  const count = Number(value ?? 0);
  if (count > 0) metrics.increment(name, count);
}

export function recordSyncSuccessMetrics(
  metrics: TaskMetrics,
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

export function recordSyncFailureMetrics(
  metrics: TaskMetrics,
  error: unknown,
  durationMs: number,
): void {
  metrics.increment('tasks.sync.failed');
  metrics.increment('tasks.sync.duration_ms.total', Math.max(0, durationMs));
  metrics.increment('tasks.sync.duration_ms.samples');
  const message = error instanceof Error ? error.message : String(error ?? '');
  metrics.increment(`tasks.sync.error_class.${classifySyncError(message)}`);
}
