import type { TaskContext } from '../discord/actions-tasks.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { TaskStore } from './store.js';
import { createTaskService } from './service.js';
import { ensureTaskSyncCoordinator, wireTaskStoreSyncTriggers } from './task-sync.js';
import type { TaskSyncRunContext } from './task-sync.js';
import { TASK_SYNC_TRIGGER_EVENTS } from './sync-contract.js';
import { loadTagMap } from './discord-sync.js';

/**
 * Canonical task namespace for task-context initialization and sync wiring.
 */
export type InitializeTasksOpts = {
  enabled: boolean;
  tasksCwd?: string;
  tasksForum?: string;
  tasksTagMapPath?: string;
  tasksMentionUser?: string;
  tasksSidebar?: boolean;
  tasksAutoTag?: boolean;
  tasksAutoTagModel?: string;
  tasksSyncFailureRetryEnabled?: boolean;
  tasksSyncFailureRetryDelayMs?: number;
  tasksSyncDeferredRetryDelayMs?: number;
  runtime: RuntimeAdapter;
  statusPoster?: StatusPoster;
  log: LoggerLike;
  /** Resolved from system bootstrap or config. */
  systemTasksForumId?: string;
  /** In-process task store. If not provided, an in-memory store is created. */
  store?: TaskStore;
};

export type InitializeTasksResult = {
  taskCtx: TaskContext | undefined;
};

// ---------------------------------------------------------------------------
// Core initialization (no Discord client — context only)
// ---------------------------------------------------------------------------

/**
 * Build a TaskContext if prerequisites are met, or return undefined with
 * appropriate log warnings. This covers the "pre-bot" phase — before the
 * Discord client is available. Forum guard and sync trigger subscriptions are wired
 * separately after the bot connects.
 */
export async function initializeTasksContext(
  opts: InitializeTasksOpts,
): Promise<InitializeTasksResult> {
  if (!opts.enabled) {
    return { taskCtx: undefined };
  }

  const effectiveForum = opts.systemTasksForumId || opts.tasksForum || '';
  if (!effectiveForum) {
    opts.log.warn(
      'tasks: no forum resolved — set DISCORD_GUILD_ID or DISCOCLAW_TASKS_FORUM ' +
      '(set DISCOCLAW_TASKS_ENABLED=0 to suppress)',
    );
    return { taskCtx: undefined };
  }

  const tagMapPath = opts.tasksTagMapPath || '';
  const tagMap = await loadTagMap(tagMapPath);
  const tasksSidebar = opts.tasksSidebar ?? false;
  const tasksMentionUser = opts.tasksMentionUser;
  const sidebarMentionUserId = tasksSidebar ? tasksMentionUser : undefined;

  if (tasksSidebar && !tasksMentionUser) {
    opts.log.warn('tasks:sidebar enabled but DISCOCLAW_TASKS_MENTION_USER not set; sidebar mentions will be inactive');
  }

  let store = opts.store;
  if (!store) {
    const { TaskStore } = await import('./store.js');
    store = new TaskStore();
  }

  const taskCtx: TaskContext = {
    tasksCwd: opts.tasksCwd || process.cwd(),
    forumId: effectiveForum,
    tagMap,
    tagMapPath,
    store,
    taskService: createTaskService(store),
    runtime: opts.runtime,
    autoTag: opts.tasksAutoTag ?? true,
    autoTagModel: opts.tasksAutoTagModel ?? 'fast',
    mentionUserId: tasksMentionUser,
    sidebarMentionUserId,
    statusPoster: opts.statusPoster,
    log: opts.log,
    syncFailureRetryEnabled: opts.tasksSyncFailureRetryEnabled,
    syncFailureRetryDelayMs: opts.tasksSyncFailureRetryDelayMs,
    syncDeferredRetryDelayMs: opts.tasksSyncDeferredRetryDelayMs,
  };

  return { taskCtx };
}

// ---------------------------------------------------------------------------
// Post-connect wiring (store event subscriptions + startup sync)
// ---------------------------------------------------------------------------

export type WireTaskSyncOpts = {
  taskCtx: TaskContext;
  runCtx: TaskSyncRunContext;
  /** Disable Phase 5 (thread reconciliation) of the task sync cycle. */
  skipPhase5?: boolean;
};

export type WireTaskSyncResult = {
  stop(): void;
};

export async function wireTaskSync(opts: WireTaskSyncOpts): Promise<WireTaskSyncResult> {
  const log = opts.taskCtx.log;
  if (!log) {
    throw new Error('wireTaskSync requires taskCtx.log');
  }

  const syncCoordinator = await ensureTaskSyncCoordinator(
    opts.taskCtx,
    opts.runCtx,
    { skipPhase5: opts.skipPhase5 },
  );

  // Startup sync: fire-and-forget to avoid blocking cron init
  syncCoordinator.sync().catch((err) => {
    log.warn({ err }, 'tasks:startup-sync failed');
  });

  const subscriptions = wireTaskStoreSyncTriggers(opts.taskCtx, syncCoordinator, log);

  log.info(
    { tasksCwd: opts.taskCtx.tasksCwd, triggerEvents: TASK_SYNC_TRIGGER_EVENTS },
    'tasks:store-event sync triggers started',
  );

  return {
    stop() {
      subscriptions.stop();
    },
  };
}
