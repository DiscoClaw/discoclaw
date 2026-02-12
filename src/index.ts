import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime, killActiveSubprocesses } from './runtime/claude-code-cli.js';
import { withConcurrencyLimit } from './runtime/concurrency-limit.js';
import { SessionManager } from './sessions.js';
import { loadDiscordChannelContext, validatePaContextModules } from './discord/channel-context.js';
import { startDiscordBot } from './discord.js';
import type { StatusPoster } from './discord/status-channel.js';
import { acquirePidLock, releasePidLock } from './pidlock.js';
import { CronScheduler } from './cron/scheduler.js';
import { executeCronJob } from './cron/executor.js';
import { initCronForum } from './cron/forum-sync.js';
import { CronRunControl } from './cron/run-control.js';
import type { ActionCategoryFlags } from './discord/actions.js';
import type { BeadContext } from './discord/actions-beads.js';
import type { CronContext } from './discord/actions-crons.js';
import { initializeBeadsContext, wireBeadsSync } from './beads/initialize.js';
import { checkBdAvailable, bdList } from './beads/bd-cli.js';
import { ForumCountSync } from './discord/forum-count-sync.js';
import { resolveBeadsForum } from './beads/discord-sync.js';
import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';
import { probeWorkspacePermissions } from './workspace-permissions.js';
import { loadRunStats } from './cron/run-stats.js';
import { seedTagMap } from './cron/discord-sync.js';
import { loadCronTagMapStrict } from './cron/tag-map.js';
import { CronSyncCoordinator } from './cron/cron-sync-coordinator.js';
import { startCronTagMapWatcher } from './cron/cron-tag-map-watcher.js';
import { ensureForumTags, isSnowflake } from './discord/system-bootstrap.js';
import { parseConfig } from './config.js';
import { resolveDisplayName } from './identity.js';
import { globalMetrics } from './observability/metrics.js';
import { setDataFilePath, drainInFlightReplies, cleanupOrphanedReplies } from './discord/inflight-replies.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let parsedConfig;
try {
  parsedConfig = parseConfig(process.env);
} catch (err) {
  log.error({ err }, 'Invalid configuration');
  process.exit(1);
}
for (const warning of parsedConfig.warnings) {
  log.warn(warning);
}
for (const info of parsedConfig.infos) {
  log.info(info);
}
const cfg = parsedConfig.config;

const token = cfg.token;
const allowUserIds = cfg.allowUserIds;
const allowChannelIds = cfg.allowChannelIds;
const restrictChannelIds = cfg.restrictChannelIds;

const runtimeModel = cfg.runtimeModel;
const runtimeTools = cfg.runtimeTools;
const runtimeTimeoutMs = cfg.runtimeTimeoutMs;

const dataDir = cfg.dataDir;

// --- PID lock: prevent duplicate bot instances ---
const pidLockDir = dataDir ?? path.join(__dirname, '..', 'data');
const pidLockPath = path.join(pidLockDir, 'discoclaw.pid');
const pidLockDirPath = `${pidLockPath}.lock`;
try {
  await fs.mkdir(pidLockDir, { recursive: true });
  await acquirePidLock(pidLockPath);
  log.info({ pidLockDir: pidLockDirPath }, 'PID lock acquired (lockdir backend)');
} catch (err) {
  log.error({ err }, 'Failed to acquire PID lock');
  process.exit(1);
}

// --- Configure inflight reply persistence (for graceful shutdown + cold-start recovery) ---
setDataFilePath(path.join(pidLockDir, 'inflight.json'));

let botStatus: StatusPoster | null = null;
let cronScheduler: CronScheduler | null = null;
let beadSyncWatcher: { stop(): void } | null = null;
let cronTagMapWatcher: { stop(): void } | null = null;
let beadForumCountSync: ForumCountSync | undefined;
let cronForumCountSync: ForumCountSync | undefined;
const shutdown = async () => {
  // Edit all in-progress Discord replies before killing subprocesses.
  await drainInFlightReplies({ timeoutMs: 3000, log });
  // Kill Claude subprocesses so they release session locks before the new instance starts.
  killActiveSubprocesses();
  // Best-effort: may not complete before SIGKILL on short shutdown windows.
  beadForumCountSync?.stop();
  cronForumCountSync?.stop();
  beadSyncWatcher?.stop();
  cronTagMapWatcher?.stop();
  cronScheduler?.stopAll();
  await botStatus?.offline();
  await releasePidLock(pidLockPath);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const contentDir = cfg.contentDirOverride || (dataDir
  ? path.join(dataDir, 'content')
  : path.join(__dirname, '..', 'content'));

const contextModulesDir = path.join(__dirname, '..', '.context');

// Hard requirement: PA context modules must exist.
// This runs outside the try-catch — failure crashes the process.
await validatePaContextModules(contextModulesDir);

// Best-effort: load only the channel index (small) and ensure placeholder channel files exist.
let discordChannelContext = undefined as Awaited<ReturnType<typeof loadDiscordChannelContext>> | undefined;
try {
  await fs.mkdir(contentDir, { recursive: true });
  discordChannelContext = await loadDiscordChannelContext({ contentDir, contextModulesDir, log });
} catch (err) {
  log.warn({ err, contentDir }, 'Failed to initialize discord channel context; continuing without it');
  discordChannelContext = undefined;
}

const requireChannelContext = cfg.requireChannelContext;
const autoIndexChannelContext = cfg.autoIndexChannelContext;
const autoJoinThreads = cfg.autoJoinThreads;
const useRuntimeSessions = cfg.useRuntimeSessions;
const discordActionsEnabled = cfg.discordActionsEnabled;
const discordActionsChannels = cfg.discordActionsChannels;
const discordActionsMessaging = cfg.discordActionsMessaging;
const discordActionsGuild = cfg.discordActionsGuild;
const discordActionsModeration = cfg.discordActionsModeration;
const discordActionsPolls = cfg.discordActionsPolls;
const discordActionsBotProfile = cfg.discordActionsBotProfile;
const messageHistoryBudget = cfg.messageHistoryBudget;
const summaryEnabled = cfg.summaryEnabled;
const summaryModel = cfg.summaryModel;
const summaryMaxChars = cfg.summaryMaxChars;
const summaryEveryNTurns = cfg.summaryEveryNTurns;
const summaryDataDir = cfg.summaryDataDirOverride
  || (dataDir ? path.join(dataDir, 'memory', 'rolling') : path.join(__dirname, '..', 'data', 'memory', 'rolling'));
const durableMemoryEnabled = cfg.durableMemoryEnabled;
const durableDataDir = cfg.durableDataDirOverride
  || (dataDir ? path.join(dataDir, 'memory', 'durable') : path.join(__dirname, '..', 'data', 'memory', 'durable'));
const durableInjectMaxChars = cfg.durableInjectMaxChars;
const durableMaxItems = cfg.durableMaxItems;
const memoryCommandsEnabled = cfg.memoryCommandsEnabled;
const planCommandsEnabled = cfg.planCommandsEnabled;
const forgeCommandsEnabled = cfg.forgeCommandsEnabled;
const forgeMaxAuditRounds = cfg.forgeMaxAuditRounds;
const forgeDrafterModel = cfg.forgeDrafterModel;
const forgeAuditorModel = cfg.forgeAuditorModel;
const forgeTimeoutMs = cfg.forgeTimeoutMs;
const forgeProgressThrottleMs = cfg.forgeProgressThrottleMs;
const summaryToDurableEnabled = cfg.summaryToDurableEnabled;
const shortTermMemoryEnabled = cfg.shortTermMemoryEnabled;
const shortTermDataDir = cfg.shortTermDataDirOverride
  || (dataDir ? path.join(dataDir, 'memory', 'shortterm') : path.join(__dirname, '..', 'data', 'memory', 'shortterm'));
const shortTermMaxEntries = cfg.shortTermMaxEntries;
const shortTermMaxAgeMs = cfg.shortTermMaxAgeHours * 60 * 60 * 1000;
const shortTermInjectMaxChars = cfg.shortTermInjectMaxChars;
const actionFollowupDepth = cfg.actionFollowupDepth;
const reactionHandlerEnabled = cfg.reactionHandlerEnabled;
const reactionRemoveHandlerEnabled = cfg.reactionRemoveHandlerEnabled;
const reactionMaxAgeHours = cfg.reactionMaxAgeHours;
const reactionMaxAgeMs = reactionMaxAgeHours * 60 * 60 * 1000;
const healthCommandsEnabled = cfg.healthCommandsEnabled;
const healthVerboseAllowlist = cfg.healthVerboseAllowlist;
const statusChannel = cfg.statusChannel;
const guildId = cfg.guildId;
const cronEnabled = cfg.cronEnabled;
const cronForum = cfg.cronForum;
const cronModel = cfg.cronModel;
const discordActionsCrons = cfg.discordActionsCrons;
const cronAutoTag = cfg.cronAutoTag;
const cronAutoTagModel = cfg.cronAutoTagModel;
const cronStatsDir = cfg.cronStatsDirOverride
  || (dataDir ? path.join(dataDir, 'cron') : path.join(__dirname, '..', 'data', 'cron'));
const cronTagMapPath = cfg.cronTagMapPathOverride
  || path.join(cronStatsDir, 'tag-map.json');
const cronTagMapSeedPath = path.join(__dirname, '..', 'scripts', 'cron', 'cron-tag-map.json');

if (requireChannelContext && !discordChannelContext) {
  log.error({ contentDir }, 'DISCORD_REQUIRE_CHANNEL_CONTEXT=1 but channel context failed to initialize');
  process.exit(1);
}

const defaultWorkspaceCwd = dataDir
  ? path.join(dataDir, 'workspace')
  : path.join(__dirname, '..', 'workspace');
const workspaceCwd = cfg.workspaceCwdOverride || defaultWorkspaceCwd;
const groupsDir = cfg.groupsDirOverride || path.join(__dirname, '..', 'groups');
const useGroupDirCwd = cfg.useGroupDirCwd;

// --- Scaffold workspace PA files (first run) ---
await ensureWorkspaceBootstrapFiles(workspaceCwd, log);

// --- Probe workspace permissions (startup visibility) ---
const permProbe = await probeWorkspacePermissions(workspaceCwd);
if (permProbe.status === 'missing') {
  log.warn(
    { workspaceCwd },
    'PERMISSIONS.json not found — using env/default tools (this may grant full access). ' +
    'Run onboarding or manually create workspace/PERMISSIONS.json.',
  );
} else if (permProbe.status === 'invalid') {
  log.warn(
    { workspaceCwd, reason: permProbe.reason },
    'PERMISSIONS.json is invalid — falling back to env/default tools.',
  );
} else {
  log.info({ workspaceCwd, tier: permProbe.permissions.tier }, 'workspace permissions loaded');
}

// --- Resolve bot display name ---
const botDisplayName = await resolveDisplayName({
  configName: cfg.botDisplayName,
  workspaceCwd,
  log,
});
log.info({ botDisplayName }, 'resolved bot display name');

// --- Beads subsystem ---
const beadsEnabled = cfg.beadsEnabled;
const beadsCwd = cfg.beadsCwdOverride || workspaceCwd;
const beadsForum = cfg.beadsForum || '';
const beadsTagMapPath = cfg.beadsTagMapPathOverride
  || path.join(__dirname, '..', 'scripts', 'beads', 'bead-hooks', 'tag-map.json');
const beadsMentionUser = cfg.beadsMentionUser;
const beadsSidebar = cfg.beadsSidebar;
const sidebarMentionUserId = beadsSidebar ? beadsMentionUser : undefined;
const beadsAutoTag = cfg.beadsAutoTag;
const beadsAutoTagModel = cfg.beadsAutoTagModel;
const discordActionsBeads = cfg.discordActionsBeads;

const runtimeFallbackModel = cfg.runtimeFallbackModel;
const runtimeMaxBudgetUsd = cfg.runtimeMaxBudgetUsd;
const appendSystemPrompt = cfg.appendSystemPrompt;

const claudeBin = cfg.claudeBin;
const dangerouslySkipPermissions = cfg.dangerouslySkipPermissions;
const outputFormat = cfg.outputFormat;
const echoStdio = cfg.echoStdio;
const verbose = cfg.verbose;
const claudeDebugFile = cfg.claudeDebugFile ?? null;
const strictMcpConfig = cfg.strictMcpConfig;
const sessionScanning = cfg.sessionScanning;
const toolAwareStreaming = cfg.toolAwareStreaming;
const multiTurn = cfg.multiTurn;
const multiTurnHangTimeoutMs = cfg.multiTurnHangTimeoutMs;
const multiTurnIdleTimeoutMs = cfg.multiTurnIdleTimeoutMs;
const multiTurnMaxProcesses = cfg.multiTurnMaxProcesses;
const streamStallTimeoutMs = cfg.streamStallTimeoutMs;
const streamStallWarningMs = cfg.streamStallWarningMs;
const maxConcurrentInvocations = cfg.maxConcurrentInvocations;

// --- CLI version check: require >= 2.1.0 for new tools/flags ---
const MIN_CLAUDE_CLI_VERSION = '2.1.0';
try {
  const versionOutput = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    const current = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    const minimum = MIN_CLAUDE_CLI_VERSION.split('.').map(Number) as [number, number, number];
    let belowMinimum = false;
    for (let i = 0; i < 3; i++) {
      if (current[i] > minimum[i]) break;
      if (current[i] < minimum[i]) { belowMinimum = true; break; }
    }
    if (belowMinimum) {
      log.error(
        { version: current.join('.'), minimum: MIN_CLAUDE_CLI_VERSION },
        `Claude CLI >= ${MIN_CLAUDE_CLI_VERSION} required for Glob/Grep/Write tools and --fallback-model/--max-budget-usd/--append-system-prompt flags. Run: claude update`,
      );
      process.exit(1);
    }
    log.info({ claudeCliVersion: current.join('.') }, 'Claude CLI version check passed');
  } else {
    log.warn({ raw: versionOutput.slice(0, 100) }, 'Could not parse Claude CLI version (continuing)');
  }
} catch (err) {
  log.error({ err, claudeBin }, 'Failed to check Claude CLI version — is the CLI installed?');
  process.exit(1);
}

// Debug: surface common "works in terminal but not in systemd" issues without logging secrets.
if (cfg.debugRuntime) {
  log.info(
    {
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        PATH: process.env.PATH,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ? '(set)' : '(unset)',
        DISPLAY: process.env.DISPLAY ? '(set)' : '(unset)',
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ? '(set)' : '(unset)',
      },
      claude: {
        bin: claudeBin,
        outputFormat,
        echoStdio,
        verbose,
        dangerouslySkipPermissions,
      },
      runtime: {
        model: runtimeModel,
        toolsCount: runtimeTools.length,
        timeoutMs: runtimeTimeoutMs,
        workspaceCwd,
        groupsDir,
        useRuntimeSessions,
        maxConcurrentInvocations,
      },
    },
    'debug:runtime config',
  );
}

const runtime = createClaudeCliRuntime({
  claudeBin,
  dangerouslySkipPermissions,
  outputFormat,
  echoStdio,
  verbose,
  debugFile: claudeDebugFile,
  strictMcpConfig,
  fallbackModel: runtimeFallbackModel,
  maxBudgetUsd: runtimeMaxBudgetUsd,
  appendSystemPrompt,
  sessionScanning,
  log,
  multiTurn,
  multiTurnHangTimeoutMs,
  multiTurnIdleTimeoutMs,
  multiTurnMaxProcesses,
  streamStallTimeoutMs,
});
const limitedRuntime = withConcurrencyLimit(runtime, { maxConcurrentInvocations, log });

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));

// Pre-flight: detect whether the bd CLI is installed (used to decide whether to bootstrap the beads forum).
// Full context init is deferred to post-connect so system bootstrap can auto-create the forum first.
let bdAvailable = false;
let bdVersion: string | undefined;
if (beadsEnabled) {
  const bd = await checkBdAvailable();
  bdAvailable = bd.available;
  bdVersion = bd.version;
  if (!bd.available) {
    log.warn(
      'beads: bd CLI not found — install bd or set BD_BIN to a custom path ' +
      '(set DISCOCLAW_BEADS_ENABLED=0 to suppress this warning)',
    );
  }
}

const botParams = {
  token,
  allowUserIds,
  guildId,
  botDisplayName,
  allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
  log,
  discordChannelContext,
  requireChannelContext,
  autoIndexChannelContext,
  autoJoinThreads,
  useRuntimeSessions,
  runtime: limitedRuntime,
  sessionManager,
  workspaceCwd,
  groupsDir,
  useGroupDirCwd,
  runtimeModel,
  runtimeTools,
  runtimeTimeoutMs,
  discordActionsEnabled,
  discordActionsChannels,
  discordActionsMessaging,
  discordActionsGuild,
  discordActionsModeration,
  discordActionsPolls,
  discordActionsBotProfile,
  // Enable beads/crons actions only after contexts are configured.
  discordActionsBeads: false,
  discordActionsCrons: false,
  beadCtx: undefined as BeadContext | undefined,
  cronCtx: undefined as CronContext | undefined,
  messageHistoryBudget,
  summaryEnabled,
  summaryModel,
  summaryMaxChars,
  summaryEveryNTurns,
  summaryDataDir,
  durableMemoryEnabled,
  durableDataDir,
  durableInjectMaxChars,
  durableMaxItems,
  memoryCommandsEnabled,
  planCommandsEnabled,
  forgeCommandsEnabled,
  forgeMaxAuditRounds,
  forgeDrafterModel,
  forgeAuditorModel,
  forgeTimeoutMs,
  forgeProgressThrottleMs,
  summaryToDurableEnabled,
  shortTermMemoryEnabled,
  shortTermDataDir,
  shortTermMaxEntries,
  shortTermMaxAgeMs,
  shortTermInjectMaxChars,
  statusChannel,
  bootstrapEnsureBeadsForum: beadsEnabled && bdAvailable,
  existingCronsId: isSnowflake(cronForum ?? '') ? cronForum : undefined,
  existingBeadsId: isSnowflake(beadsForum) ? beadsForum : undefined,
  toolAwareStreaming,
  streamStallWarningMs,
  actionFollowupDepth,
  reactionHandlerEnabled,
  reactionRemoveHandlerEnabled,
  reactionMaxAgeMs,
  healthCommandsEnabled,
  healthVerboseAllowlist,
  botStatus: cfg.botStatus,
  botActivity: cfg.botActivity,
  botActivityType: cfg.botActivityType,
  botAvatar: cfg.botAvatar,
  healthConfigSnapshot: {
    runtimeModel,
    runtimeTimeoutMs,
    runtimeTools,
    useRuntimeSessions,
    toolAwareStreaming,
    maxConcurrentInvocations,
    discordActionsEnabled,
    summaryEnabled,
    durableMemoryEnabled,
    messageHistoryBudget,
    reactionHandlerEnabled,
    reactionRemoveHandlerEnabled,
    cronEnabled,
    beadsEnabled,
    beadsActive: false,
    requireChannelContext,
    autoIndexChannelContext,
  },
  metrics: globalMetrics,
  appendSystemPrompt,
};

const { client, status, system } = await startDiscordBot(botParams);
botStatus = status;

// --- Cold-start: clean up orphaned in-flight replies from a previous unclean exit ---
await cleanupOrphanedReplies({ client, dataFilePath: path.join(pidLockDir, 'inflight.json'), log });

// --- Configure beads context after bootstrap (so the forum can be auto-created) ---
let beadCtx: BeadContext | undefined;
if (beadsEnabled && bdAvailable) {
  const beadsResult = await initializeBeadsContext({
    enabled: true,
    beadsCwd,
    beadsForum,
    beadsTagMapPath,
    beadsMentionUser,
    beadsSidebar,
    beadsAutoTag,
    beadsAutoTagModel,
    runtime,
    statusPoster: botStatus ?? undefined,
    log,
    systemBeadsForumId: system?.beadsForumId,
  });
  beadCtx = beadsResult.beadCtx;
}

if (beadCtx) {
  // Attach status poster now that the bot is connected (may not have been available during pre-flight).
  if (!beadCtx.statusPoster && botStatus) {
    beadCtx.statusPoster = botStatus;
  }
  botParams.beadCtx = beadCtx;
  botParams.discordActionsBeads = discordActionsBeads && beadsEnabled;
  botParams.healthConfigSnapshot.beadsActive = true;

  // Wire coordinator + watcher + startup sync
  const resolvedGuildId = guildId || system?.guildId || '';
  const guild = resolvedGuildId ? client.guilds.cache.get(resolvedGuildId) : undefined;
  if (guild) {
    // Create forum count sync for beads.
    const beadForum = await resolveBeadsForum(guild, beadCtx.forumId);
    if (beadForum) {
      beadForumCountSync = new ForumCountSync(
        client,
        beadForum.id,
        async () => {
          const all = await bdList({ status: 'all' }, beadsCwd);
          return all.filter(b => b.status !== 'closed').length;
        },
        log,
      );
      beadCtx.forumCountSync = beadForumCountSync;
    }

    const wired = await wireBeadsSync({
      beadCtx,
      client,
      guild,
      guildId: resolvedGuildId,
      beadsCwd,
      sidebarMentionUserId,
      log,
      forumCountSync: beadForumCountSync,
    });
    beadSyncWatcher = wired.syncWatcher;
  } else {
    log.warn({ resolvedGuildId }, 'beads:sync-watcher skipped; guild not in cache');
  }

  log.info(
    { beadsCwd, beadsForum: beadCtx.forumId, tagCount: Object.keys(beadCtx.tagMap).length, autoTag: beadsAutoTag, bdVersion },
    'beads:initialized',
  );
}

// --- Cron subsystem ---
const effectiveCronForum = cronForum || system?.cronsForumId || undefined;
if (cronEnabled && effectiveCronForum) {
  // Seed tag map from repo if target doesn't exist yet.
  await seedTagMap(cronTagMapSeedPath, cronTagMapPath);

  // Load persistent stats.
  const cronLocksDir = path.join(cronStatsDir, 'locks');
  await fs.mkdir(cronLocksDir, { recursive: true });

  const cronStatsPath = path.join(cronStatsDir, 'cron-run-stats.json');
  const cronStats = await loadRunStats(cronStatsPath);

  const cronActionFlags: ActionCategoryFlags = {
    channels: discordActionsChannels,
    messaging: discordActionsMessaging,
    guild: discordActionsGuild,
    moderation: discordActionsModeration,
    polls: discordActionsPolls,
    beads: discordActionsBeads && beadsEnabled && Boolean(beadCtx),
    // Prevent cron jobs from mutating cron state via emitted action blocks.
    crons: false,
    botProfile: false, // Intentionally excluded from cron flows to avoid rate-limit and abuse issues.
  };
  const cronRunControl = new CronRunControl();

  // Load cron tag map (strict, but fallback to empty on first run)
  const cronTagMap = await loadCronTagMapStrict(cronTagMapPath).catch((err) => {
    log.warn({ err, cronTagMapPath }, 'cron:tag-map strict load failed; starting with empty map');
    return {} as Record<string, string>;
  });

  const cronPendingThreadIds = new Set<string>();

  const cronCtx: CronContext = {
    scheduler: null as any, // Will be set after scheduler creation.
    client,
    forumId: effectiveCronForum,
    tagMapPath: cronTagMapPath,
    tagMap: cronTagMap,
    statsStore: cronStats,
    runtime,
    autoTag: cronAutoTag,
    autoTagModel: cronAutoTagModel,
    cwd: workspaceCwd,
    allowUserIds,
    log,
    pendingThreadIds: cronPendingThreadIds,
  };

  const cronExecCtx = {
    client,
    runtime,
    model: runtimeModel,
    cwd: workspaceCwd,
    tools: runtimeTools,
    timeoutMs: runtimeTimeoutMs,
    status: botStatus,
    log,
    allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
    discordActionsEnabled,
    actionFlags: cronActionFlags,
    beadCtx,
    cronCtx,
    statsStore: cronStats,
    lockDir: cronLocksDir,
    runControl: cronRunControl,
  };

  cronScheduler = new CronScheduler((job) => executeCronJob(job, cronExecCtx), log);
  cronCtx.scheduler = cronScheduler;
  cronCtx.executorCtx = cronExecCtx;

  botParams.cronCtx = cronCtx;
  botParams.discordActionsCrons = discordActionsCrons && cronEnabled;

  let cronForumResult: { forumId: string } = { forumId: '' };
  try {
    cronForumResult = await initCronForum({
      client,
      forumChannelNameOrId: effectiveCronForum,
      scheduler: cronScheduler,
      runtime,
      cronModel,
      cwd: workspaceCwd,
      allowUserIds,
      log,
      statsStore: cronStats,
      pendingThreadIds: cronPendingThreadIds,
      onCountChanged: () => cronForumCountSync?.requestUpdate(),
    });
  } catch (err) {
    log.error({ err }, 'cron:forum init failed');
  }

  // Create forum count sync for crons (after initCronForum so all jobs are loaded).
  if (cronForumResult.forumId) {
    cronForumCountSync = new ForumCountSync(
      client,
      cronForumResult.forumId,
      () => cronScheduler!.listJobs().length,
      log,
    );
    cronCtx.forumCountSync = cronForumCountSync;
    cronForumCountSync.requestUpdate();
  }

  // Wire coordinator + watcher for cron tag-map hot-reload
  if (cronForumResult.forumId) {
    const cronSyncCoordinator = new CronSyncCoordinator({
      client,
      forumId: cronForumResult.forumId,
      scheduler: cronScheduler!,
      statsStore: cronStats,
      runtime,
      tagMap: cronTagMap,
      tagMapPath: cronTagMapPath,
      autoTag: cronAutoTag,
      autoTagModel: cronAutoTagModel,
      cwd: workspaceCwd,
      log,
      forumCountSync: cronForumCountSync,
    });
    cronCtx.syncCoordinator = cronSyncCoordinator;

    // Startup sync (fire-and-forget; reconciles tags changed while bot was down)
    cronSyncCoordinator.sync().catch((err) => {
      log.warn({ err }, 'cron:startup-sync failed');
    });

    // File watcher for tag-map hot-reload
    cronTagMapWatcher = startCronTagMapWatcher({
      coordinator: cronSyncCoordinator,
      tagMapPath: cronTagMapPath,
      log,
    });
  }

  // Bootstrap forum tags from the tag map (creates missing tags on the Discord forum).
  if (system?.guildId) {
    const guild = client.guilds.cache.get(system.guildId);
    if (guild) {
      try {
        await ensureForumTags(guild, effectiveCronForum, cronTagMapPath, log);
      } catch (err) {
        log.warn({ err }, 'cron:forum tag bootstrap failed');
      }
    }
  }

  log.info(
    { cronForum: effectiveCronForum, autoTag: cronAutoTag, actionsCrons: discordActionsCrons, statsDir: cronStatsDir },
    'cron:initialized',
  );
} else if (cronEnabled && !effectiveCronForum) {
  log.warn('DISCOCLAW_CRON_ENABLED=1 but no cron forum was resolved (set DISCORD_GUILD_ID or DISCOCLAW_CRON_FORUM); cron subsystem disabled');
}

if (reactionHandlerEnabled) {
  log.info({ reactionMaxAgeHours }, 'reaction:handler enabled');
}
if (reactionRemoveHandlerEnabled) {
  log.info({ reactionMaxAgeHours }, 'reaction-remove:handler enabled');
}

log.info('Discord bot started');
