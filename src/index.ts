import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime, killActiveSubprocesses } from './runtime/claude-code-cli.js';
import { withConcurrencyLimit } from './runtime/concurrency-limit.js';
import { SessionManager } from './sessions.js';
import { loadDiscordChannelContext } from './discord/channel-context.js';
import { startDiscordBot } from './discord.js';
import type { StatusPoster } from './discord/status-channel.js';
import { acquirePidLock, releasePidLock } from './pidlock.js';
import { CronScheduler } from './cron/scheduler.js';
import { executeCronJob } from './cron/executor.js';
import { initCronForum } from './cron/forum-sync.js';
import type { ActionCategoryFlags } from './discord/actions.js';
import type { BeadContext } from './discord/actions-beads.js';
import type { CronContext } from './discord/actions-crons.js';
import { loadTagMap } from './beads/discord-sync.js';
import { checkBdAvailable } from './beads/bd-cli.js';
import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';
import { loadRunStats } from './cron/run-stats.js';
import { seedTagMap } from './cron/discord-sync.js';
import { ensureForumTags } from './discord/system-bootstrap.js';
import { parseConfig } from './config.js';
import { resolveDisplayName } from './identity.js';
import { globalMetrics } from './observability/metrics.js';

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
try {
  await fs.mkdir(pidLockDir, { recursive: true });
  await acquirePidLock(pidLockPath);
} catch (err) {
  log.error({ err }, 'Failed to acquire PID lock');
  process.exit(1);
}

let botStatus: StatusPoster | null = null;
let cronScheduler: CronScheduler | null = null;
const shutdown = async () => {
  // Kill Claude subprocesses first so they release session locks before the new instance starts.
  killActiveSubprocesses();
  // Best-effort: may not complete before SIGKILL on short shutdown windows.
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

// Best-effort: load only the channel index (small) and ensure placeholder channel files exist.
let discordChannelContext = undefined as Awaited<ReturnType<typeof loadDiscordChannelContext>> | undefined;
try {
  await fs.mkdir(contentDir, { recursive: true });
  discordChannelContext = await loadDiscordChannelContext({ contentDir, log });
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
const actionFollowupDepth = cfg.actionFollowupDepth;
const reactionHandlerEnabled = cfg.reactionHandlerEnabled;
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
const beadsAutoTag = cfg.beadsAutoTag;
const beadsAutoTagModel = cfg.beadsAutoTagModel;
const discordActionsBeads = cfg.discordActionsBeads;

const claudeBin = cfg.claudeBin;
const dangerouslySkipPermissions = cfg.dangerouslySkipPermissions;
const outputFormat = cfg.outputFormat;
const echoStdio = cfg.echoStdio;
const claudeDebugFile = cfg.claudeDebugFile ?? null;
const strictMcpConfig = cfg.strictMcpConfig;
const sessionScanning = cfg.sessionScanning;
const toolAwareStreaming = cfg.toolAwareStreaming;
const multiTurn = cfg.multiTurn;
const multiTurnHangTimeoutMs = cfg.multiTurnHangTimeoutMs;
const multiTurnIdleTimeoutMs = cfg.multiTurnIdleTimeoutMs;
const multiTurnMaxProcesses = cfg.multiTurnMaxProcesses;
const maxConcurrentInvocations = cfg.maxConcurrentInvocations;

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
  debugFile: claudeDebugFile,
  strictMcpConfig,
  sessionScanning,
  log,
  multiTurn,
  multiTurnHangTimeoutMs,
  multiTurnIdleTimeoutMs,
  multiTurnMaxProcesses,
});
const limitedRuntime = withConcurrencyLimit(runtime, { maxConcurrentInvocations, log });

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));

// Pre-flight: detect whether the bd CLI is installed (used to decide whether to bootstrap the beads forum).
let bdAvailable = false;
let bdVersion: string | undefined;
if (beadsEnabled) {
  const bd = await checkBdAvailable();
  bdAvailable = bd.available;
  bdVersion = bd.version;
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
  statusChannel,
  bootstrapEnsureBeadsForum: beadsEnabled && bdAvailable,
  toolAwareStreaming,
  actionFollowupDepth,
  reactionHandlerEnabled,
  reactionMaxAgeMs,
  healthCommandsEnabled,
  healthVerboseAllowlist,
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
    cronEnabled,
    beadsEnabled,
    requireChannelContext,
    autoIndexChannelContext,
  },
  metrics: globalMetrics,
};

const { client, status, system } = await startDiscordBot(botParams);
botStatus = status;

// --- Configure beads context after bootstrap (so the forum can be auto-created) ---
let beadCtx: BeadContext | undefined;
if (beadsEnabled) {
  if (!bdAvailable) {
    log.warn(
      'DISCOCLAW_BEADS_ENABLED=1 but the bd CLI was not found. ' +
      'Beads is a task-tracking system that syncs with Discord forum threads. ' +
      'It requires the `bd` binary (set BD_BIN to a custom path if needed). ' +
      'Beads subsystem disabled.',
    );
  } else {
    const effectiveForum = beadsForum || system?.beadsForumId || '';
    if (!effectiveForum) {
      log.warn('DISCOCLAW_BEADS_ENABLED=1 but no beads forum was resolved (set DISCORD_GUILD_ID or DISCOCLAW_BEADS_FORUM); beads subsystem disabled');
    } else {
      const tagMap = await loadTagMap(beadsTagMapPath);
      beadCtx = {
        beadsCwd,
        forumId: effectiveForum,
        tagMap,
        runtime,
        autoTag: beadsAutoTag,
        autoTagModel: beadsAutoTagModel,
        mentionUserId: beadsMentionUser,
        log,
      };
      botParams.beadCtx = beadCtx;
      botParams.discordActionsBeads = discordActionsBeads && beadsEnabled;
      log.info(
        { beadsCwd, beadsForum: effectiveForum, tagCount: Object.keys(tagMap).length, autoTag: beadsAutoTag, bdVersion },
        'beads:initialized',
      );
    }
  }
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

  const actionFlags: ActionCategoryFlags = {
    channels: discordActionsChannels,
    messaging: discordActionsMessaging,
    guild: discordActionsGuild,
    moderation: discordActionsModeration,
    polls: discordActionsPolls,
    beads: discordActionsBeads && beadsEnabled && Boolean(beadCtx),
    crons: discordActionsCrons && cronEnabled,
  };

  const cronCtx: CronContext = {
    scheduler: null as any, // Will be set after scheduler creation.
    client,
    forumId: effectiveCronForum,
    tagMapPath: cronTagMapPath,
    statsStore: cronStats,
    runtime,
    autoTag: cronAutoTag,
    autoTagModel: cronAutoTagModel,
    cwd: workspaceCwd,
    allowUserIds,
    log,
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
    actionFlags,
    beadCtx,
    cronCtx,
    statsStore: cronStats,
    lockDir: cronLocksDir,
  };

  cronScheduler = new CronScheduler((job) => executeCronJob(job, cronExecCtx), log);
  cronCtx.scheduler = cronScheduler;
  cronCtx.executorCtx = cronExecCtx;

  botParams.cronCtx = cronCtx;
  botParams.discordActionsCrons = discordActionsCrons && cronEnabled;

  try {
    await initCronForum({
      client,
      forumChannelNameOrId: effectiveCronForum,
      scheduler: cronScheduler,
      runtime,
      cronModel,
      cwd: workspaceCwd,
      allowUserIds,
      log,
      statsStore: cronStats,
    });
  } catch (err) {
    log.error({ err }, 'cron:forum init failed');
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

log.info('Discord bot started');
