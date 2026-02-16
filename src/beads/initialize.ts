import type { Client, Guild } from 'discord.js';
import type { BeadContext } from '../discord/actions-beads.js';
import type { LoggerLike } from '../discord/action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { StatusPoster } from '../discord/status-channel.js';
import type { ForumCountSync } from '../discord/forum-count-sync.js';
import { loadTagMap } from './discord-sync.js';
import { checkBdAvailable, ensureBdDatabaseReady } from './bd-cli.js';
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
};

export type InitializeBeadsResult = {
  beadCtx: BeadContext | undefined;
  bdAvailable: boolean;
  bdVersion?: string;
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
    return { beadCtx: undefined, bdAvailable: false };
  }

  const bd = await checkBdAvailable();
  if (!bd.available) {
    opts.log.warn(
      'beads: bd CLI not found — install bd or set BD_BIN to a custom path ' +
      '(set DISCOCLAW_BEADS_ENABLED=0 to suppress this warning)',
    );
    return { beadCtx: undefined, bdAvailable: false };
  }

  // Verify the database is initialized with a prefix. Without this, bd may
  // silently route operations to a different instance's database via the
  // global daemon registry (~/.beads/registry.json).
  const dbCheck = await ensureBdDatabaseReady(opts.beadsCwd);
  if (!dbCheck.ready) {
    opts.log.error(
      { beadsCwd: opts.beadsCwd },
      'beads: database not initialized and auto-init failed — ' +
      'run "bd --db <path> --no-daemon config set issue_prefix <prefix>" manually',
    );
    return { beadCtx: undefined, bdAvailable: bd.available, bdVersion: bd.version };
  }
  opts.log.info({ beadsCwd: opts.beadsCwd, prefix: dbCheck.prefix }, 'beads:database prefix verified');

  const effectiveForum = opts.systemBeadsForumId || opts.beadsForum || '';
  if (!effectiveForum) {
    opts.log.warn(
      'beads: no forum resolved — set DISCORD_GUILD_ID or DISCOCLAW_BEADS_FORUM ' +
      '(set DISCOCLAW_BEADS_ENABLED=0 to suppress)',
    );
    return { beadCtx: undefined, bdAvailable: bd.available, bdVersion: bd.version };
  }

  const tagMap = await loadTagMap(opts.beadsTagMapPath);
  const sidebarMentionUserId = opts.beadsSidebar ? opts.beadsMentionUser : undefined;

  if (opts.beadsSidebar && !opts.beadsMentionUser) {
    opts.log.warn('beads:sidebar enabled but DISCOCLAW_BEADS_MENTION_USER not set; sidebar mentions will be inactive');
  }

  const beadCtx: BeadContext = {
    beadsCwd: opts.beadsCwd,
    forumId: effectiveForum,
    tagMap,
    tagMapPath: opts.beadsTagMapPath,
    runtime: opts.runtime,
    autoTag: opts.beadsAutoTag,
    autoTagModel: opts.beadsAutoTagModel,
    mentionUserId: opts.beadsMentionUser,
    sidebarMentionUserId,
    statusPoster: opts.statusPoster,
    log: opts.log,
  };

  return { beadCtx, bdAvailable: bd.available, bdVersion: bd.version };
}

// ---------------------------------------------------------------------------
// Post-connect wiring (forum guard + sync watcher + startup sync)
// ---------------------------------------------------------------------------

export type WireBeadsSyncOpts = {
  beadCtx: BeadContext;
  client: Client;
  guild: Guild;
  guildId: string;
  beadsCwd: string;
  sidebarMentionUserId?: string;
  log: LoggerLike;
  forumCountSync?: ForumCountSync;
  /** Skip forum guard installation (caller already installed it). */
  skipForumGuard?: boolean;
};

export type WireBeadsSyncResult = {
  syncWatcher: { stop(): void } | null;
};

export async function wireBeadsSync(opts: WireBeadsSyncOpts): Promise<WireBeadsSyncResult> {
  if (!opts.skipForumGuard) {
    initBeadsForumGuard({ client: opts.client, forumId: opts.beadCtx.forumId, log: opts.log });
  }

  const { BeadSyncCoordinator } = await import('./bead-sync-coordinator.js');
  const { startBeadSyncWatcher } = await import('./bead-sync-watcher.js');

  const syncCoordinator = new BeadSyncCoordinator({
    client: opts.client,
    guild: opts.guild,
    forumId: opts.beadCtx.forumId,
    tagMap: opts.beadCtx.tagMap,
    tagMapPath: opts.beadCtx.tagMapPath,
    beadsCwd: opts.beadsCwd,
    log: opts.log,
    mentionUserId: opts.sidebarMentionUserId,
    forumCountSync: opts.forumCountSync,
  });
  opts.beadCtx.syncCoordinator = syncCoordinator;

  // Startup sync: fire-and-forget to avoid blocking cron init
  syncCoordinator.sync().catch((err) => {
    opts.log.warn({ err }, 'beads:startup-sync failed');
  });

  const syncWatcher = startBeadSyncWatcher({
    coordinator: syncCoordinator,
    beadsCwd: opts.beadsCwd,
    log: opts.log,
    tagMapPath: opts.beadCtx.tagMapPath,
    tagMap: opts.beadCtx.tagMap,
  });
  opts.log.info({ beadsCwd: opts.beadsCwd }, 'beads:file-watcher started');

  return { syncWatcher };
}
