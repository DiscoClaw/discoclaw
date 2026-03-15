import type { TagMap, TaskSyncResult } from './types.js';
export type { TaskSyncResult } from './types.js';
import type { LoggerLike } from './logger-types.js';
import type { TaskDiscordClient, TaskDiscordGuild } from './discord-types.js';
import type { TaskInFlightChecker, TaskStatusPoster } from './sync-context.js';
import type { TaskStore } from './store.js';
import type { TaskService } from './service.js';
import type { TaskSyncRunOptions } from './sync-types.js';
import { createTaskService } from './service.js';
import {
  ingestTaskSyncSnapshot,
  planTaskSyncApplyExecution,
} from './task-sync-pipeline.js';
import {
  type TaskSyncApplyContext,
  createTaskSyncApplyCounters,
} from './task-sync-apply-types.js';
import {
  applyTaskSyncExecutionPlan,
} from './task-sync-phase-apply.js';
import {
  runTaskSyncReconcilePhase,
} from './task-sync-reconcile.js';
import { resolveTasksForum } from './thread-ops.js';

type TaskSyncCoreOptions = {
  client: TaskDiscordClient;
  guild: TaskDiscordGuild;
  forumId: string;
  tagMap: TagMap;
  store: TaskStore;
  taskService?: TaskService;
  log?: LoggerLike;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  statusPoster?: TaskStatusPoster;
  mentionUserId?: string;
  hasInFlightForChannel?: TaskInFlightChecker;
};

export type TaskSyncOptions = TaskSyncCoreOptions & TaskSyncRunOptions;

/**
 * 5-phase safety-net sync between tasks DB and Discord forum threads.
 *
 * Phase 1: Create threads for tasks missing external_ref.
 * Phase 2: Fix label mismatches (e.g., blocked label on open tasks).
 * Phase 3: Sync emoji/names/starter content for existing threads.
 * Phase 4: Archive threads for closed tasks.
 * Phase 5: Reconcile forum threads against tasks — archive stale threads
 *          for closed tasks and detect orphan threads with no matching task.
 */
export async function runTaskSync(opts: TaskSyncOptions): Promise<TaskSyncResult> {
  const { client, guild, forumId, tagMap, log } = opts;
  const taskService = opts.taskService ?? createTaskService(opts.store);
  const throttleMs = opts.throttleMs ?? 250;
  const hasInFlightForChannel = opts.hasInFlightForChannel ?? (() => false);

  const forum = await resolveTasksForum(guild, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'task-sync: forum not found');
    const result: TaskSyncResult = {
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
      warnings: 1,
    };
    if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
    return result;
  }

  const counters = createTaskSyncApplyCounters();

  // Stage 1: ingest
  const allTasks = ingestTaskSyncSnapshot(opts.store.list({ status: 'all' }));
  // Stage 2-4: compose normalize+diff+apply plan
  const applyPlan = planTaskSyncApplyExecution(allTasks);

  // Stage 4: apply
  const applyCtx: TaskSyncApplyContext = {
    client,
    forum,
    tagMap,
    store: opts.store,
    taskService,
    log,
    throttleMs,
    archivedDedupeLimit: opts.archivedDedupeLimit,
    mentionUserId: opts.mentionUserId,
    hasInFlightForChannel,
    counters,
  };

  await applyTaskSyncExecutionPlan(applyCtx, applyPlan);

  const phase5 = await runTaskSyncReconcilePhase(applyCtx, allTasks, opts);
  const threadsReconciled = phase5.threadsReconciled;
  const orphanThreadsFound = phase5.orphanThreadsFound;

  log?.info({
    threadsCreated: counters.threadsCreated,
    emojisUpdated: counters.emojisUpdated,
    starterMessagesUpdated: counters.starterMessagesUpdated,
    threadsArchived: counters.threadsArchived,
    statusesUpdated: counters.statusesUpdated,
    tagsUpdated: counters.tagsUpdated,
    threadsReconciled,
    orphanThreadsFound,
    closesDeferred: counters.closesDeferred,
    warnings: counters.warnings,
  }, 'task-sync: complete');

  const result: TaskSyncResult = {
    threadsCreated: counters.threadsCreated,
    emojisUpdated: counters.emojisUpdated,
    starterMessagesUpdated: counters.starterMessagesUpdated,
    threadsArchived: counters.threadsArchived,
    statusesUpdated: counters.statusesUpdated,
    tagsUpdated: counters.tagsUpdated,
    warnings: counters.warnings,
    threadsReconciled,
    orphanThreadsFound,
    closesDeferred: counters.closesDeferred,
  };

  if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
  return result;
}
