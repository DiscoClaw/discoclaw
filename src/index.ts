import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime, killActiveSubprocesses } from './runtime/claude-code-cli.js';
import { SessionManager } from './sessions.js';
import { parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';
import { loadDiscordChannelContext } from './discord/channel-context.js';
import { startDiscordBot } from './discord.js';
import type { StatusPoster } from './discord/status-channel.js';
import { acquirePidLock, releasePidLock } from './pidlock.js';
import { CronScheduler } from './cron/scheduler.js';
import { executeCronJob } from './cron/executor.js';
import { initCronForum } from './cron/forum-sync.js';
import type { ActionCategoryFlags } from './discord/actions.js';
import type { BeadContext } from './discord/actions-beads.js';
import { loadTagMap } from './beads/discord-sync.js';
import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.DISCORD_TOKEN ?? '';
if (!token) {
  log.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

const allowUserIds = parseAllowUserIds(process.env.DISCORD_ALLOW_USER_IDS);
if (allowUserIds.size === 0) {
  log.warn('DISCORD_ALLOW_USER_IDS is empty: bot will respond to nobody (fail closed)');
}

const allowChannelIdsRaw = process.env.DISCORD_CHANNEL_IDS;
const restrictChannelIds = (allowChannelIdsRaw ?? '').trim().length > 0;
const allowChannelIds = parseAllowChannelIds(allowChannelIdsRaw);
if (restrictChannelIds && allowChannelIds.size === 0) {
  log.warn('DISCORD_CHANNEL_IDS was set but no valid IDs were parsed: bot will respond to no guild channels (fail closed)');
}

const runtimeModel = (process.env.RUNTIME_MODEL ?? 'opus').trim() || 'opus';
const runtimeTools = String(process.env.RUNTIME_TOOLS ?? 'Bash,Read,Edit,WebSearch,WebFetch')
  .split(/[,\s]+/g)
  .map((t) => t.trim())
  .filter(Boolean);
const runtimeTimeoutMsRaw = (process.env.RUNTIME_TIMEOUT_MS ?? '').trim();
const runtimeTimeoutMs = runtimeTimeoutMsRaw ? Math.max(1, Number(runtimeTimeoutMsRaw)) : 10 * 60_000;

const dataDir = process.env.DISCOCLAW_DATA_DIR;

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

const contentDir = (process.env.DISCOCLAW_CONTENT_DIR ?? '').trim() || (dataDir
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

const requireChannelContext = (process.env.DISCORD_REQUIRE_CHANNEL_CONTEXT ?? '1') === '1';
const autoIndexChannelContext = (process.env.DISCORD_AUTO_INDEX_CHANNEL_CONTEXT ?? '1') === '1';
const autoJoinThreads = (process.env.DISCORD_AUTO_JOIN_THREADS ?? '0') === '1';
const useRuntimeSessions = (process.env.DISCOCLAW_RUNTIME_SESSIONS ?? '1') === '1';
const discordActionsEnabled = (process.env.DISCOCLAW_DISCORD_ACTIONS ?? '0') === '1';
const discordActionsChannels = (process.env.DISCOCLAW_DISCORD_ACTIONS_CHANNELS ?? '1') === '1';
const discordActionsMessaging = (process.env.DISCOCLAW_DISCORD_ACTIONS_MESSAGING ?? '0') === '1';
const discordActionsGuild = (process.env.DISCOCLAW_DISCORD_ACTIONS_GUILD ?? '0') === '1';
const discordActionsModeration = (process.env.DISCOCLAW_DISCORD_ACTIONS_MODERATION ?? '0') === '1';
const discordActionsPolls = (process.env.DISCOCLAW_DISCORD_ACTIONS_POLLS ?? '0') === '1';
const messageHistoryBudget = Math.max(0, Number(process.env.DISCOCLAW_MESSAGE_HISTORY_BUDGET ?? '3000'));
const summaryEnabled = (process.env.DISCOCLAW_SUMMARY_ENABLED ?? '1') === '1';
const summaryModel = (process.env.DISCOCLAW_SUMMARY_MODEL ?? 'haiku').trim() || 'haiku';
const summaryMaxChars = Math.max(0, Number(process.env.DISCOCLAW_SUMMARY_MAX_CHARS ?? '2000'));
const summaryEveryNTurns = Math.max(1, Number(process.env.DISCOCLAW_SUMMARY_EVERY_N_TURNS ?? '5'));
const summaryDataDir = (process.env.DISCOCLAW_SUMMARY_DATA_DIR ?? '').trim()
  || (dataDir ? path.join(dataDir, 'memory', 'rolling') : path.join(__dirname, '..', 'data', 'memory', 'rolling'));
const durableMemoryEnabled = (process.env.DISCOCLAW_DURABLE_MEMORY_ENABLED ?? '1') === '1';
const durableDataDir = (process.env.DISCOCLAW_DURABLE_DATA_DIR ?? '').trim()
  || (dataDir ? path.join(dataDir, 'memory', 'durable') : path.join(__dirname, '..', 'data', 'memory', 'durable'));
const durableInjectMaxChars = Math.max(1, Number(process.env.DISCOCLAW_DURABLE_INJECT_MAX_CHARS ?? '2000'));
const durableMaxItems = Math.max(1, Number(process.env.DISCOCLAW_DURABLE_MAX_ITEMS ?? '200'));
const memoryCommandsEnabled = (process.env.DISCOCLAW_MEMORY_COMMANDS_ENABLED ?? '1') === '1';
const statusChannel = (process.env.DISCOCLAW_STATUS_CHANNEL ?? '').trim() || undefined;
const cronEnabled = (process.env.DISCOCLAW_CRON_ENABLED ?? '0') === '1';
const cronForum = (process.env.DISCOCLAW_CRON_FORUM ?? '').trim() || undefined;
const cronModel = (process.env.DISCOCLAW_CRON_MODEL ?? 'haiku').trim() || 'haiku';

if (requireChannelContext && !discordChannelContext) {
  log.error({ contentDir }, 'DISCORD_REQUIRE_CHANNEL_CONTEXT=1 but channel context failed to initialize');
  process.exit(1);
}

const defaultWorkspaceCwd = dataDir
  ? path.join(dataDir, 'workspace')
  : path.join(__dirname, '..', 'workspace');
// Treat empty env vars as "unset" so `.env` placeholders don't override defaults.
const workspaceCwd = (process.env.WORKSPACE_CWD ?? '').trim() || defaultWorkspaceCwd;
const groupsDir = (process.env.GROUPS_DIR ?? '').trim() || path.join(__dirname, '..', 'groups');
const useGroupDirCwd = (process.env.USE_GROUP_DIR_CWD ?? '0') === '1';

// --- Scaffold workspace PA files (first run) ---
await ensureWorkspaceBootstrapFiles(workspaceCwd, log);

// --- Beads subsystem ---
const beadsEnabled = (process.env.DISCOCLAW_BEADS_ENABLED ?? '0') === '1';
const beadsCwd = (process.env.DISCOCLAW_BEADS_CWD ?? '').trim() || workspaceCwd;
const beadsForum = (process.env.DISCOCLAW_BEADS_FORUM ?? '').trim() || '';
const beadsTagMapPath = (process.env.DISCOCLAW_BEADS_TAG_MAP ?? '').trim()
  || path.join(__dirname, '..', 'scripts', 'beads', 'bead-hooks', 'tag-map.json');
const beadsMentionUser = (process.env.DISCOCLAW_BEADS_MENTION_USER ?? '').trim() || undefined;
const beadsAutoTag = (process.env.DISCOCLAW_BEADS_AUTO_TAG ?? '1') === '1';
const beadsAutoTagModel = (process.env.DISCOCLAW_BEADS_AUTO_TAG_MODEL ?? 'haiku').trim() || 'haiku';
const discordActionsBeads = (process.env.DISCOCLAW_DISCORD_ACTIONS_BEADS ?? '0') === '1';

const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
const dangerouslySkipPermissions = (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS ?? '0') === '1';
const outputFormat = (process.env.CLAUDE_OUTPUT_FORMAT ?? 'text') === 'stream-json'
  ? 'stream-json'
  : 'text';
const echoStdio = (process.env.CLAUDE_ECHO_STDIO ?? '0') === '1';
const claudeDebugFile = (process.env.CLAUDE_DEBUG_FILE ?? '').trim() || null;
const strictMcpConfig = (process.env.CLAUDE_STRICT_MCP_CONFIG ?? '1') === '1';
const sessionScanning = (process.env.DISCOCLAW_SESSION_SCANNING ?? '0') === '1';
const toolAwareStreaming = (process.env.DISCOCLAW_TOOL_AWARE_STREAMING ?? '0') === '1';
const multiTurn = (process.env.DISCOCLAW_MULTI_TURN ?? '1') === '1';
const multiTurnHangTimeoutMs = Math.max(1, Number(process.env.DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS ?? '60000'));
const multiTurnIdleTimeoutMs = Math.max(1, Number(process.env.DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS ?? '300000'));
const multiTurnMaxProcesses = Math.max(1, Number(process.env.DISCOCLAW_MULTI_TURN_MAX_PROCESSES ?? '5'));

// Debug: surface common "works in terminal but not in systemd" issues without logging secrets.
if ((process.env.DISCOCLAW_DEBUG_RUNTIME ?? '0') === '1') {
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

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));

// --- Build BeadContext if beads enabled ---
let beadCtx: BeadContext | undefined;
if (beadsEnabled && beadsForum) {
  const tagMap = await loadTagMap(beadsTagMapPath);
  beadCtx = {
    beadsCwd,
    forumId: beadsForum,
    tagMap,
    runtime,
    autoTag: beadsAutoTag,
    autoTagModel: beadsAutoTagModel,
    mentionUserId: beadsMentionUser,
    log,
  };
  log.info({ beadsCwd, beadsForum, tagCount: Object.keys(tagMap).length, autoTag: beadsAutoTag }, 'beads:initialized');
} else if (beadsEnabled && !beadsForum) {
  log.warn('DISCOCLAW_BEADS_ENABLED=1 but DISCOCLAW_BEADS_FORUM is not set; beads subsystem disabled');
}

const { client, status } = await startDiscordBot({
  token,
  allowUserIds,
  allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
  log,
  discordChannelContext,
  requireChannelContext,
  autoIndexChannelContext,
  autoJoinThreads,
  useRuntimeSessions,
  runtime,
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
  discordActionsBeads: discordActionsBeads && beadsEnabled,
  beadCtx,
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
  toolAwareStreaming,
});
botStatus = status;

// --- Cron subsystem ---
if (cronEnabled && cronForum) {
  const actionFlags: ActionCategoryFlags = {
    channels: discordActionsChannels,
    messaging: discordActionsMessaging,
    guild: discordActionsGuild,
    moderation: discordActionsModeration,
    polls: discordActionsPolls,
    beads: discordActionsBeads && beadsEnabled,
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
    discordActionsEnabled,
    actionFlags,
    beadCtx,
  };

  cronScheduler = new CronScheduler((job) => executeCronJob(job, cronExecCtx), log);

  try {
    await initCronForum({
      client,
      forumChannelNameOrId: cronForum,
      scheduler: cronScheduler,
      runtime,
      cronModel,
      cwd: workspaceCwd,
      log,
    });
  } catch (err) {
    log.error({ err }, 'cron:forum init failed');
  }
} else if (cronEnabled && !cronForum) {
  log.warn('DISCOCLAW_CRON_ENABLED=1 but DISCOCLAW_CRON_FORUM is not set; cron subsystem disabled');
}

log.info('Discord bot started');
