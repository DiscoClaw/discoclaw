import type { Client, Guild } from 'discord.js';
import type { TagMap, TaskData, TaskSyncResult } from './types.js';
import { hasInFlightForChannel } from '../discord/inflight-replies.js';
export type { TaskSyncResult } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { TaskStore } from './store.js';
import { withTaskLifecycleLock } from './task-lifecycle.js';
import {
  resolveTasksForum,
  createTaskThread,
  closeTaskThread,
  isThreadArchived,
  isTaskThreadAlreadyClosed,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
  getThreadIdFromTask,
  ensureUnarchived,
  findExistingThreadForTask,
  extractShortIdFromThreadName,
  shortTaskId,
} from './discord-sync.js';

export type TaskSyncOptions = {
  client: Client;
  guild: Guild;
  forumId: string;
  tagMap: TagMap;
  store: TaskStore;
  log?: LoggerLike;
  throttleMs?: number;
  archivedDedupeLimit?: number;
  statusPoster?: StatusPoster;
  mentionUserId?: string;
  /** Disable Phase 5 (thread reconciliation). Useful for shared-forum deployments. */
  skipPhase5?: boolean;
};

function hasLabel(task: TaskData, label: string): boolean {
  return (task.labels ?? []).includes(label);
}

async function sleep(ms: number | undefined): Promise<void> {
  const n = ms ?? 0;
  if (n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

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
  const throttleMs = opts.throttleMs ?? 250;

  const forum = await resolveTasksForum(guild, forumId);
  if (!forum) {
    log?.warn({ forumId }, 'task-sync: forum not found');
    const result: TaskSyncResult = { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 1 };
    if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
    return result;
  }

  let threadsCreated = 0;
  let emojisUpdated = 0;
  let starterMessagesUpdated = 0;
  let threadsArchived = 0;
  let statusesUpdated = 0;
  let tagsUpdated = 0;
  let warnings = 0;
  let closesDeferred = 0;

  // Load all tasks (including closed for Phase 4).
  const allTasks = opts.store.list({ status: 'all' });

  // Phase 1: Create threads for tasks missing external_ref.
  const tasksMissingRef = allTasks.filter((task) =>
    !getThreadIdFromTask(task) &&
    task.status !== 'closed' &&
    !hasLabel(task, 'no-thread'),
  );
  for (const task of tasksMissingRef) {
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = opts.store.get(task.id) ?? task;
      if (
        getThreadIdFromTask(latestTask) ||
        latestTask.status === 'closed' ||
        hasLabel(latestTask, 'no-thread')
      ) {
        return;
      }

      try {
        // Dedupe: if the thread already exists, backfill external_ref instead of creating a duplicate.
        const existing = await findExistingThreadForTask(forum, latestTask.id, { archivedLimit: opts.archivedDedupeLimit });
        if (existing) {
          try {
            opts.store.update(latestTask.id, { externalRef: `discord:${existing}` });
            log?.info({ taskId: latestTask.id, threadId: existing }, 'task-sync:phase1 external-ref backfilled');
          } catch (err) {
            log?.warn({ err, taskId: latestTask.id, threadId: existing }, 'task-sync:phase1 external-ref backfill failed');
            warnings++;
          }
          return;
        }

        const threadId = await createTaskThread(forum, latestTask, tagMap, opts.mentionUserId);
        // Link back via external_ref.
        try {
          opts.store.update(latestTask.id, { externalRef: `discord:${threadId}` });
        } catch (err) {
          log?.warn({ err, taskId: latestTask.id }, 'task-sync:phase1 external-ref update failed');
          warnings++;
        }
        threadsCreated++;
        log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase1 thread created');
      } catch (err) {
        log?.warn({ err, taskId: latestTask.id }, 'task-sync:phase1 failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 2: Fix status/label mismatches (matches legacy shell behavior).
  const needsBlockedTasks = allTasks.filter((task) =>
    task.status === 'open' && (task.labels ?? []).some((l) => /^(waiting|blocked)-/.test(l)),
  );
  for (const task of needsBlockedTasks) {
    try {
      opts.store.update(task.id, { status: 'blocked' as any });
      task.status = 'blocked'; // keep in-memory copy current for Phase 3
      statusesUpdated++;
      log?.info({ taskId: task.id }, 'task-sync:phase2 status updated to blocked');
    } catch (err) {
      log?.warn({ err, taskId: task.id }, 'task-sync:phase2 failed');
      warnings++;
    }
    await sleep(throttleMs);
  }

  // Phase 3: Sync emoji/names for existing threads.
  const tasksWithRef = allTasks.filter((task) => getThreadIdFromTask(task) && task.status !== 'closed');
  for (const task of tasksWithRef) {
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = opts.store.get(task.id) ?? task;
      const threadId = getThreadIdFromTask(latestTask);
      if (!threadId || latestTask.status === 'closed') {
        return;
      }

      // Skip threads that are already archived — a concurrent taskClose may have
      // just archived this thread, and unarchiving it would undo that work.
      // Note: isThreadArchived never throws (fetchThreadChannel catches internally).
      if (await isThreadArchived(client, threadId)) {
        return;
      }

      // If archived, unarchive and keep unarchived for active tasks.
      try {
        await ensureUnarchived(client, threadId);
      } catch {}
      try {
        const changed = await updateTaskThreadName(client, threadId, latestTask);
        if (changed) {
          emojisUpdated++;
          log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 name updated');
        }
      } catch (err) {
        log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 failed');
        warnings++;
      }
      try {
        const starterChanged = await updateTaskStarterMessage(client, threadId, latestTask, opts.mentionUserId);
        if (starterChanged) {
          starterMessagesUpdated++;
          log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 starter updated');
        }
      } catch (err) {
        log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 starter update failed');
        warnings++;
      }
      try {
        const tagChanged = await updateTaskThreadTags(client, threadId, latestTask, tagMap);
        if (tagChanged) {
          tagsUpdated++;
          log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase3 tags updated');
        }
      } catch (err) {
        log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase3 tag update failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 4: Archive threads for closed tasks.
  const closedTasks = allTasks.filter((task) =>
    task.status === 'closed' && getThreadIdFromTask(task),
  );
  for (const task of closedTasks) {
    await withTaskLifecycleLock(task.id, async () => {
      const latestTask = opts.store.get(task.id) ?? task;
      const threadId = getThreadIdFromTask(latestTask);
      if (!threadId || latestTask.status !== 'closed') {
        return;
      }

      try {
        // Full idempotency check: skip only if the thread is archived AND has
        // the correct closed name and tags. This lets sync recover threads that
        // were archived with stale names (e.g., rename failed silently during close).
        if (await isTaskThreadAlreadyClosed(client, threadId, latestTask, tagMap)) {
          return;
        }
        if (hasInFlightForChannel(threadId)) {
          closesDeferred++;
          log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase4 close deferred (in-flight reply active)');
          return;
        }
        await closeTaskThread(client, threadId, latestTask, tagMap, log);
        threadsArchived++;
        log?.info({ taskId: latestTask.id, threadId }, 'task-sync:phase4 archived');
      } catch (err) {
        log?.warn({ err, taskId: latestTask.id, threadId }, 'task-sync:phase4 failed');
        warnings++;
      }
    });
    await sleep(throttleMs);
  }

  // Phase 5: Reconcile forum threads against tasks.
  let threadsReconciled = 0;
  let orphanThreadsFound = 0;

  if (!opts.skipPhase5) {
    // Build a map of short task IDs → tasks for quick lookup.
    const tasksByShortId = new Map<string, TaskData[]>();
    for (const task of allTasks) {
      const sid = shortTaskId(task.id);
      const arr = tasksByShortId.get(sid);
      if (arr) arr.push(task);
      else tasksByShortId.set(sid, [task]);
    }

    // Fetch active + archived forum threads.
    try {
      const activeThreads = await forum.threads.fetchActive();
      let archivedThreads: Map<string, any> = new Map();
      try {
        const fetched = await forum.threads.fetchArchived();
        archivedThreads = new Map(fetched.threads);
      } catch (err) {
        log?.warn({ err }, 'task-sync:phase5 failed to fetch archived threads');
        warnings++;
      }

      // Combine both sets — active threads take priority for duplicates.
      const allThreads = new Map([...archivedThreads, ...activeThreads.threads]);
      for (const thread of allThreads.values()) {
        const sid = extractShortIdFromThreadName(thread.name);
        if (!sid) continue; // not a task thread

        const tasks = tasksByShortId.get(sid);
        if (!tasks || tasks.length === 0) {
          // Orphan thread — no local task matches this short ID.
          orphanThreadsFound++;
          log?.info({ threadId: thread.id, threadName: thread.name, shortId: sid }, 'task-sync:phase5 orphan thread detected');
          await sleep(throttleMs);
          continue;
        }

        // Skip ambiguous cases (multiple tasks share the same short ID).
        if (tasks.length > 1) {
          log?.info({ threadId: thread.id, shortId: sid, count: tasks.length }, 'task-sync:phase5 short-id collision, skipping');
          await sleep(throttleMs);
          continue;
        }

        const task = tasks[0]!;

        // Layer 2 safety: if the task already has an external_ref pointing to
        // a different thread, this thread likely belongs to a foreign instance's
        // task with the same short ID — skip it.
        const existingThreadId = getThreadIdFromTask(task);
        if (existingThreadId && existingThreadId !== thread.id) {
          log?.info({ taskId: task.id, threadId: thread.id, existingThreadId }, 'task-sync:phase5 external_ref points to different thread, skipping');
          await sleep(throttleMs);
          continue;
        }

        // If task is closed but thread is not archived, archive it.
        if (task.status === 'closed' && !thread.archived) {
          if (hasInFlightForChannel(thread.id)) {
            closesDeferred++;
            log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
            await sleep(throttleMs);
            continue;
          }
          // Backfill external_ref if missing so Phase 4 can track this thread.
          if (!existingThreadId) {
            try {
              opts.store.update(task.id, { externalRef: `discord:${thread.id}` });
              log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 external_ref backfilled');
            } catch (err) {
              log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 external_ref backfill failed');
              warnings++;
            }
          }
          try {
            await closeTaskThread(client, thread.id, task, tagMap, log);
            threadsReconciled++;
            log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 reconciled (archived)');
          } catch (err) {
            log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archive failed');
            warnings++;
          }
          await sleep(throttleMs);
        } else if (task.status === 'closed' && thread.archived) {
          // Thread is already archived — check if it's fully reconciled (correct name + tags).
          // If stale (e.g., name or tags wrong), unarchive→edit→re-archive via closeTaskThread.
          try {
            const alreadyClosed = await isTaskThreadAlreadyClosed(client, thread.id, task, tagMap);
            if (!alreadyClosed) {
              if (hasInFlightForChannel(thread.id)) {
                closesDeferred++;
                log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 close deferred (in-flight reply active)');
              } else {
                log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archived thread is stale, unarchiving to reconcile');
                await closeTaskThread(client, thread.id, task, tagMap, log);
                threadsReconciled++;
                log?.info({ taskId: task.id, threadId: thread.id }, 'task-sync:phase5 reconciled (re-archived)');
              }
            }
          } catch (err) {
            log?.warn({ err, taskId: task.id, threadId: thread.id }, 'task-sync:phase5 archived reconcile failed');
            warnings++;
          }
          await sleep(throttleMs);
        }
      }
    } catch (err) {
      log?.warn({ err }, 'task-sync:phase5 failed to fetch active threads');
      warnings++;
    }
  }

  log?.info({ threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, threadsReconciled, orphanThreadsFound, closesDeferred, warnings }, 'task-sync: complete');
  const result: TaskSyncResult = { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, warnings, threadsReconciled, orphanThreadsFound, closesDeferred };
  if (opts.statusPoster?.taskSyncComplete) await opts.statusPoster.taskSyncComplete(result);
  return result;
}

// ---------------------------------------------------------------------------
// Legacy Bead* compatibility aliases
// ---------------------------------------------------------------------------

export type BeadSyncOptions = TaskSyncOptions;
export type BeadSyncResult = TaskSyncResult;
export const runBeadSync = runTaskSync;
