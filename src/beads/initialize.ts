import type { Client, Guild } from 'discord.js';
import type { TaskContext } from '../discord/actions-tasks.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { TaskStore } from '../tasks/store.js';
import { TASK_SYNC_TRIGGER_EVENTS } from '../tasks/sync-contract.js';
import { loadTagMap } from './discord-sync.js';
import { initBeadsForumGuard } from './forum-guard.js';

export type InitializeBeadsOpts = {
  enabled: boolean;
  tasksCwd?: string;
  tasksForum?: string;
  tasksTagMapPath?: string;
  tasksMentionUser?: string;
  tasksSidebar?: boolean;
  tasksAutoTag?: boolean;
  tasksAutoTagModel?: string;
  runtime: RuntimeAdapter;
  statusPoster?: StatusPoster;
  log: LoggerLike;
  /** Resolved from system bootstrap or config. */
  systemTasksForumId?: string;
  /** In-process task store. If not provided, an in-memory store is created. */
  store?: TaskStore;
};

export type InitializeBeadsResult = {
  taskCtx: TaskContext | undefined;
};

// ---------------------------------------------------------------------------
// Core initialization (no Discord client — context only)
// ---------------------------------------------------------------------------

/**
 * Build a TaskContext if prerequisites are met, or return undefined with
 * appropriate log warnings. This covers the "pre-bot" phase — before the
 * Discord client is available. Forum guard and sync watcher are wired
 * separately after the bot connects.
 */
export async function initializeBeadsContext(
  opts: InitializeBeadsOpts,
): Promise<InitializeBeadsResult> {
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
    const { TaskStore } = await import('../tasks/store.js');
    store = new TaskStore();
  }

  const taskCtx: TaskContext = {
    tasksCwd: opts.tasksCwd || process.cwd(),
    forumId: effectiveForum,
    tagMap,
    tagMapPath,
    store,
    runtime: opts.runtime,
    autoTag: opts.tasksAutoTag ?? true,
    autoTagModel: opts.tasksAutoTagModel ?? 'fast',
    mentionUserId: tasksMentionUser,
    sidebarMentionUserId,
    statusPoster: opts.statusPoster,
    log: opts.log,
  };

  return { taskCtx };
}

// ---------------------------------------------------------------------------
// Post-connect wiring (forum guard + store event subscriptions + startup sync)
// ---------------------------------------------------------------------------

export type WireBeadsSyncOpts = {
  taskCtx: TaskContext;
  client: Client;
  guild: Guild;
  guildId: string;
  tasksCwd?: string;
  sidebarMentionUserId?: string;
  log: LoggerLike;
  forumCountSync?: ForumCountSync;
  /** Skip forum guard installation (caller already installed it). */
  skipForumGuard?: boolean;
  /** Disable Phase 5 (thread reconciliation) of the bead sync cycle. */
  skipPhase5?: boolean;
};

export type WireBeadsSyncResult = {
  stop(): void;
};

export async function wireBeadsSync(opts: WireBeadsSyncOpts): Promise<WireBeadsSyncResult> {
  if (!opts.skipForumGuard) {
    initBeadsForumGuard({
      client: opts.client,
      forumId: opts.taskCtx.forumId,
      log: opts.log,
      store: opts.taskCtx.store,
      tagMap: opts.taskCtx.tagMap,
    });
  }

  const { BeadSyncCoordinator } = await import('./bead-sync-coordinator.js');

  const syncCoordinator = new BeadSyncCoordinator({
    client: opts.client,
    guild: opts.guild,
    forumId: opts.taskCtx.forumId,
    tagMap: opts.taskCtx.tagMap,
    tagMapPath: opts.taskCtx.tagMapPath,
    store: opts.taskCtx.store,
    log: opts.log,
    mentionUserId: opts.sidebarMentionUserId,
    forumCountSync: opts.forumCountSync,
    skipPhase5: opts.skipPhase5,
  });
  opts.taskCtx.syncCoordinator = syncCoordinator;

  // Startup sync: fire-and-forget to avoid blocking cron init
  syncCoordinator.sync().catch((err) => {
    opts.log.warn({ err }, 'beads:startup-sync failed');
  });

  // Wire only contract-approved TaskStore mutations into coordinator sync.
  const triggerSync = (eventName: string) => {
    syncCoordinator.sync().catch((err) => {
      opts.log.warn({ err, eventName }, 'beads:store-event sync failed');
    });
  };
  const store = opts.taskCtx.store;
  const subscriptions = TASK_SYNC_TRIGGER_EVENTS.map((eventName) => {
    const handler = () => triggerSync(eventName);
    store.on(eventName, handler);
    return { eventName, handler };
  });

  opts.log.info({ tasksCwd: opts.tasksCwd, triggerEvents: TASK_SYNC_TRIGGER_EVENTS }, 'tasks:store-event watcher started');

  return {
    stop() {
      for (const sub of subscriptions) {
        store.off(sub.eventName, sub.handler);
      }
    },
  };
}
