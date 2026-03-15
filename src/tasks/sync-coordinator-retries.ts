import type { LoggerLike } from './logger-types.js';
import type { TaskMetrics } from './metrics-types.js';
import { classifySyncError } from './sync-coordinator-metrics.js';

export type TaskSyncRetryState = {
  failureRetryPending: boolean;
  deferredCloseRetryPending: boolean;
  failureRetryTimeout: ReturnType<typeof setTimeout> | null;
  deferredCloseRetryTimeout: ReturnType<typeof setTimeout> | null;
};

export type TaskSyncRetryControls = {
  state: TaskSyncRetryState;
  metrics: TaskMetrics;
  log?: LoggerLike;
  runSync: () => Promise<unknown>;
  enableFailureRetry?: boolean;
  failureRetryDelayMs?: number;
  deferredRetryDelayMs?: number;
};

export function createTaskSyncRetryState(): TaskSyncRetryState {
  return {
    failureRetryPending: false,
    deferredCloseRetryPending: false,
    failureRetryTimeout: null,
    deferredCloseRetryTimeout: null,
  };
}

export function scheduleFailureRetry(ctrl: TaskSyncRetryControls): void {
  if (ctrl.enableFailureRetry === false) {
    ctrl.metrics.increment('tasks.sync.failure_retry.disabled');
    return;
  }
  if (ctrl.state.failureRetryPending) {
    ctrl.metrics.increment('tasks.sync.failure_retry.coalesced');
    return;
  }

  ctrl.state.failureRetryPending = true;
  const delayMs = ctrl.failureRetryDelayMs ?? 30_000;
  ctrl.metrics.increment('tasks.sync.failure_retry.scheduled');
  ctrl.log?.info({ delayMs }, 'tasks:coordinator scheduling retry after sync failure');

  ctrl.state.failureRetryTimeout = setTimeout(() => {
    ctrl.state.failureRetryPending = false;
    ctrl.state.failureRetryTimeout = null;
    ctrl.metrics.increment('tasks.sync.failure_retry.triggered');
    ctrl.runSync().catch((err) => {
      ctrl.metrics.increment('tasks.sync.failure_retry.failed');
      const message = err instanceof Error ? err.message : String(err ?? '');
      ctrl.metrics.increment(`tasks.sync.failure_retry.error_class.${classifySyncError(message)}`);
      ctrl.log?.warn({ err }, 'tasks:coordinator failure retry sync failed');
    });
  }, delayMs);
}

export function cancelFailureRetry(ctrl: TaskSyncRetryControls): void {
  if (!ctrl.state.failureRetryPending || !ctrl.state.failureRetryTimeout) return;
  clearTimeout(ctrl.state.failureRetryTimeout);
  ctrl.state.failureRetryTimeout = null;
  ctrl.state.failureRetryPending = false;
  ctrl.metrics.increment('tasks.sync.failure_retry.canceled');
}

export function scheduleDeferredCloseRetry(
  ctrl: TaskSyncRetryControls,
  closesDeferred: number,
): void {
  if (ctrl.state.deferredCloseRetryPending) {
    ctrl.metrics.increment('tasks.sync.retry.coalesced');
    return;
  }

  ctrl.state.deferredCloseRetryPending = true;
  const delayMs = ctrl.deferredRetryDelayMs ?? 30_000;
  ctrl.metrics.increment('tasks.sync.retry.scheduled');
  ctrl.log?.info(
    { closesDeferred, delayMs },
    'tasks:coordinator scheduling retry for deferred closes',
  );

  ctrl.state.deferredCloseRetryTimeout = setTimeout(() => {
    ctrl.state.deferredCloseRetryPending = false;
    ctrl.state.deferredCloseRetryTimeout = null;
    ctrl.metrics.increment('tasks.sync.retry.triggered');
    ctrl.runSync().catch((err) => {
      ctrl.metrics.increment('tasks.sync.retry.failed');
      const message = err instanceof Error ? err.message : String(err ?? '');
      ctrl.metrics.increment(`tasks.sync.retry.error_class.${classifySyncError(message)}`);
      ctrl.log?.warn({ err }, 'tasks:coordinator deferred-close retry failed');
    });
  }, delayMs);
}

export function cancelDeferredCloseRetry(ctrl: TaskSyncRetryControls): void {
  if (!ctrl.state.deferredCloseRetryPending || !ctrl.state.deferredCloseRetryTimeout) return;
  clearTimeout(ctrl.state.deferredCloseRetryTimeout);
  ctrl.state.deferredCloseRetryTimeout = null;
  ctrl.state.deferredCloseRetryPending = false;
  ctrl.metrics.increment('tasks.sync.retry.canceled');
}
