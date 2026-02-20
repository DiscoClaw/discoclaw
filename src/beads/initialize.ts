import type { Client, Guild } from 'discord.js';
import type { TaskContext } from '../discord/actions-tasks.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import type { TaskStore } from '../tasks/store.js';
import { loadTagMap } from './discord-sync.js';
import { initBeadsForumGuard } from './forum-guard.js';

export type InitializeBeadsOpts = {
  enabled: boolean;
  beadsCwd: string;
  beadsForum: string;
  beadsTagMapPath: string;
  beadsMentionUser?: string;
  beadsSidebar: boolean;
  beadsAutoTag: boolean;
  beadsAutoTagModel: string;
  runtime: RuntimeAdapter;
  statusPoster?: StatusPoster;
  log: LoggerLike;
  /** Resolved from system bootstrap or config. */
  systemBeadsForumId?: string;
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
 * Build a BeadContext if prerequisites are met, or return undefined with
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

  const effectiveForum = opts.systemBeadsForumId || opts.beadsForum || '';
  if (!effectiveForum) {
    opts.log.warn(
      'beads: no forum resolved — set DISCORD_GUILD_ID or DISCOCLAW_BEADS_FORUM ' +
      '(set DISCOCLAW_BEADS_ENABLED=0 to suppress)',
    );
    return { taskCtx: undefined };
  }

  const tagMap = await loadTagMap(opts.beadsTagMapPath);
  const sidebarMentionUserId = opts.beadsSidebar ? opts.beadsMentionUser : undefined;

  if (opts.beadsSidebar && !opts.beadsMentionUser) {
    opts.log.warn('beads:sidebar enabled but DISCOCLAW_BEADS_MENTION_USER not set; sidebar mentions will be inactive');
  }

  let store = opts.store;
  if (!store) {
    const { TaskStore } = await import('../tasks/store.js');
    store = new TaskStore();
  }

  const taskCtx: TaskContext = {
    beadsCwd: opts.beadsCwd,
    forumId: effectiveForum,
    tagMap,
    tagMapPath: opts.beadsTagMapPath,
    store,
    runtime: opts.runtime,
    autoTag: opts.beadsAutoTag,
    autoTagModel: opts.beadsAutoTagModel,
    mentionUserId: opts.beadsMentionUser,
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
  beadsCwd: string;
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

  // Wire store events to trigger Discord sync on mutations (updated, closed, labeled).
  // Note: 'created' is intentionally excluded — beadCreate handles thread creation directly.
  const triggerSync = () => {
    syncCoordinator.sync().catch((err) => {
      opts.log.warn({ err }, 'beads:store-event sync failed');
    });
  };
  const store = opts.taskCtx.store;
  store.on('updated', triggerSync);
  store.on('closed', triggerSync);
  store.on('labeled', triggerSync);

  opts.log.info({ beadsCwd: opts.beadsCwd }, 'tasks:store-event watcher started');

  return {
    stop() {
      store.off('updated', triggerSync);
      store.off('closed', triggerSync);
      store.off('labeled', triggerSync);
    },
  };
}
