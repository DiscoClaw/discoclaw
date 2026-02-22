import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime } from './runtime/claude-code-cli.js';
import { killAllSubprocesses } from './runtime/cli-adapter.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { createOpenAICompatRuntime } from './runtime/openai-compat.js';
import { createCodexCliRuntime } from './runtime/codex-cli.js';
import { createGeminiCliRuntime } from './runtime/gemini-cli.js';
import { createConcurrencyLimiter, withConcurrencyLimit } from './runtime/concurrency-limit.js';
import { SessionManager } from './sessions.js';
import { loadDiscordChannelContext, resolveDiscordChannelContext, validatePaContextModules } from './discord/channel-context.js';
import { parseDiscordActions, executeDiscordActions, discordActionsPromptSection, buildDisplayResultLines } from './discord/actions.js';
import type { ActionCategoryFlags, ActionContext, DiscordActionResult } from './discord/actions.js';
import { resolveChannel, fmtTime } from './discord/action-utils.js';
import { DeferScheduler } from './discord/defer-scheduler.js';
import type { DeferActionRequest, DeferredRun } from './discord/actions-defer.js';
import { startDiscordBot, getActiveForgeId } from './discord.js';
import type { StatusPoster } from './discord/status-channel.js';
import { acquirePidLock, releasePidLock } from './pidlock.js';
import { CronScheduler } from './cron/scheduler.js';
import { executeCronJob } from './cron/executor.js';
import { initCronForum } from './cron/forum-sync.js';
import { CronRunControl } from './cron/run-control.js';
import type { TaskContext } from './tasks/task-context.js';
import type { CronContext } from './discord/actions-crons.js';
import type { ForgeContext } from './discord/actions-forge.js';
import type { PlanContext } from './discord/actions-plan.js';
import type { MemoryContext } from './discord/actions-memory.js';
import { ForgeOrchestrator } from './discord/forge-commands.js';
import { initializeTasksContext, wireTaskSync } from './tasks/initialize.js';
import type { TaskSyncWiring } from './tasks/sync-types.js';
import { ForumCountSync } from './discord/forum-count-sync.js';
import { resolveTasksForum } from './tasks/thread-ops.js';
import { initTasksForumGuard } from './tasks/forum-guard.js';
import { reloadTagMapInPlace } from './tasks/tag-map.js';
import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';
import { probeWorkspacePermissions } from './workspace-permissions.js';
import { loadRunStats } from './cron/run-stats.js';
import { seedTagMap } from './cron/discord-sync.js';
import { loadCronTagMapStrict } from './cron/tag-map.js';
import { CronSyncCoordinator } from './cron/cron-sync-coordinator.js';
import { startCronTagMapWatcher } from './cron/cron-tag-map-watcher.js';
import { ensureForumTags, isSnowflake } from './discord/system-bootstrap.js';
import { parseConfig } from './config.js';
import { startWebhookServer } from './webhook/server.js';
import type { WebhookServer } from './webhook/server.js';
import { resolveModel } from './runtime/model-tiers.js';
import { resolveDisplayName } from './identity.js';
import { globalMetrics } from './observability/metrics.js';
import { MemorySampler } from './observability/memory-sampler.js';
import {
  setDataFilePath,
  drainInFlightReplies,
  cleanupOrphanedReplies,
  hasInFlightForChannel,
} from './discord/inflight-replies.js';
import { writeShutdownContext, readAndClearShutdownContext, formatStartupInjection } from './discord/shutdown-context.js';
import { getGitHash } from './version.js';
import { runCredentialChecks, formatCredentialReport } from './health/credential-check.js';
import { buildContextFiles, inlineContextFiles, loadWorkspacePaFiles, resolveEffectiveTools } from './discord/prompt-common.js';
import { mapRuntimeErrorToUserMessage } from './discord/user-errors.js';
import { NO_MENTIONS } from './discord/allowed-mentions.js';
import { appendUnavailableActionTypesNotice } from './discord/output-common.js';
import { TaskStore } from './tasks/store.js';
import { migrateLegacyTaskDataFile, resolveTaskDataPath } from './tasks/path-defaults.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const bootStartMs = Date.now();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

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

const primaryRuntimeName = cfg.primaryRuntime;
let runtimeModel = cfg.runtimeModel;
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

// Detect first-ever boot via a stable marker file (persists across restarts).
// The PID lock dir is transient (removed on shutdown) so it can't be used here.
const bootMarkerPath = path.join(pidLockDir, '.boot-marker');
let firstBoot = false;
try {
  await fs.access(bootMarkerPath);
} catch {
  firstBoot = true;
  await fs.writeFile(bootMarkerPath, new Date().toISOString() + '\n', 'utf-8');
}

// --- Configure inflight reply persistence (for graceful shutdown + cold-start recovery) ---
setDataFilePath(path.join(pidLockDir, 'inflight.json'));

// --- Resolve current build hash (best-effort; null if git unavailable) ---
const gitHash = await getGitHash();
if (gitHash) {
  log.info({ gitHash }, 'startup:build hash resolved');
}

// --- Read shutdown context from previous run (before bot connects to avoid race) ---
let startupInjection: string | null = null;
let startupCtx: Awaited<ReturnType<typeof readAndClearShutdownContext>>;
{
  startupCtx = await readAndClearShutdownContext(pidLockDir, { firstBoot });
  startupInjection = formatStartupInjection(startupCtx);
  if (startupInjection) {
    if (gitHash) startupInjection = `Build: ${gitHash}. ${startupInjection}`;
    log.info({ type: startupCtx.type, activeForge: startupCtx.shutdown?.activeForge }, 'startup:context loaded');
  } else {
    if (gitHash) startupInjection = `Build: ${gitHash}.`;
    if (startupCtx.type === 'first-boot') {
      log.info('startup:first boot detected (no prior shutdown context)');
    }
  }
}

let botStatus: StatusPoster | null = null;
let cronScheduler: CronScheduler | null = null;
let taskSyncWiring: TaskSyncWiring | null = null;
let cronTagMapWatcher: { stop(): void } | null = null;
let taskForumCountSync: ForumCountSync | undefined;
let cronForumCountSync: ForumCountSync | undefined;
let webhookServer: WebhookServer | null = null;
let savedCronExecCtx: import('./cron/executor.js').CronExecutorContext | null = null;
const memorySampler = new MemorySampler();
globalMetrics.setMemorySampler(memorySampler);
memorySampler.sample();
const memorySamplerInterval = setInterval(() => {
  memorySampler.sample();
}, 30_000);
memorySamplerInterval.unref?.();
const shutdown = async () => {
  // Write default shutdown context (skip if !restart already wrote a richer one).
  try {
    await writeShutdownContext(
      pidLockDir,
      {
        reason: 'unknown',
        timestamp: new Date().toISOString(),
        activeForge: getActiveForgeId(),
      },
      { skipIfExists: true },
    );
  } catch (err) {
    log.warn({ err }, 'shutdown:failed to write shutdown context');
  }

  // Edit all in-progress Discord replies before killing subprocesses.
  await drainInFlightReplies({ timeoutMs: 3000, log });
  // Kill all CLI subprocesses so they release session locks before the new instance starts.
  killAllSubprocesses();
  // Best-effort: may not complete before SIGKILL on short shutdown windows.
  taskForumCountSync?.stop();
  cronForumCountSync?.stop();
  taskSyncWiring?.stop();
  cronTagMapWatcher?.stop();
  cronScheduler?.stopAll();
  clearInterval(memorySamplerInterval);
  if (webhookServer) {
    await webhookServer.close().catch((err) => log.warn({ err }, 'webhook:close error'));
  }
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
const discordActionsForge = cfg.discordActionsForge;
const discordActionsPlan = cfg.discordActionsPlan;
const discordActionsMemory = cfg.discordActionsMemory;
const messageHistoryBudget = cfg.messageHistoryBudget;
const summaryEnabled = cfg.summaryEnabled;
let summaryModel = cfg.summaryModel;
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
const planPhasesEnabled = cfg.planPhasesEnabled;
const planPhaseMaxContextFiles = cfg.planPhaseMaxContextFiles;
const planPhaseTimeoutMs = cfg.planPhaseTimeoutMs;
const planPhaseMaxAuditFixAttempts = cfg.planPhaseMaxAuditFixAttempts;
const forgeCommandsEnabled = cfg.forgeCommandsEnabled;
const forgeMaxAuditRounds = cfg.forgeMaxAuditRounds;
const forgeDrafterModel = cfg.forgeDrafterModel;
const forgeAuditorModel = cfg.forgeAuditorModel;
const forgeTimeoutMs = cfg.forgeTimeoutMs;
const forgeProgressThrottleMs = cfg.forgeProgressThrottleMs;
const forgeAutoImplement = cfg.forgeAutoImplement;
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
let cronModel = cfg.cronModel;
const discordActionsCrons = cfg.discordActionsCrons;
const cronAutoTag = cfg.cronAutoTag;
let cronAutoTagModel = cfg.cronAutoTagModel;
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

// --- Credential health checks (run concurrently with workspace/bot init) ---
const credentialCheckPromise = runCredentialChecks({
  token: cfg.token,
  openaiApiKey: cfg.openaiApiKey,
  openaiBaseUrl: cfg.openaiBaseUrl,
});

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
  log.error(
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

// --- Load persisted scaffold state (forum IDs created on previous boots) ---
const scaffoldStatePath = path.join(pidLockDir, 'system-scaffold.json');
let scaffoldState: { guildId?: string; systemCategoryId?: string; cronsForumId?: string; tasksForumId?: string } = {};
try {
  const raw = await fs.readFile(scaffoldStatePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object') {
    // Invalidate if guild changed — IDs from a different guild are meaningless.
    if (guildId && typeof parsed.guildId === 'string' && parsed.guildId !== guildId) {
      log.warn({ savedGuild: parsed.guildId, currentGuild: guildId }, 'system-scaffold: guild mismatch, ignoring persisted forum IDs');
    } else {
      if (typeof parsed.systemCategoryId === 'string') scaffoldState.systemCategoryId = parsed.systemCategoryId;
      if (typeof parsed.cronsForumId === 'string') scaffoldState.cronsForumId = parsed.cronsForumId;
      if (typeof parsed.tasksForumId === 'string') scaffoldState.tasksForumId = parsed.tasksForumId;
    }
  }
} catch {
  // No persisted state yet — first boot or file missing.
}
const cronForum = cfg.cronForum || scaffoldState.cronsForumId;

// --- Tasks subsystem ---
const tasksEnabled = cfg.tasksEnabled;
const tasksCwd = cfg.tasksCwdOverride || workspaceCwd;
const tasksForum = cfg.tasksForum || scaffoldState.tasksForumId || '';
const tasksDataRoot = dataDir ?? path.join(__dirname, '..', 'data');
const tasksDataDir = path.join(tasksDataRoot, 'tasks');
const tasksPersistPath =
  resolveTaskDataPath(tasksDataRoot, 'tasks.jsonl')
  ?? path.join(tasksDataDir, 'tasks.jsonl');
const tasksTagMapDefaultPath =
  resolveTaskDataPath(tasksDataRoot, 'tag-map.json')
  ?? path.join(tasksDataDir, 'tag-map.json');
const tasksTagMapPath = cfg.tasksTagMapPathOverride
  || tasksTagMapDefaultPath;
const tasksTagMapSeedPath = path.join(__dirname, '..', 'scripts', 'tasks', 'tag-map.json');
const tasksMentionUser = cfg.tasksMentionUser;
const tasksSidebar = cfg.tasksSidebar;
const tasksAutoTag = cfg.tasksAutoTag;
let tasksAutoTagModel = cfg.tasksAutoTagModel;
const tasksSyncFailureRetryEnabled = cfg.tasksSyncFailureRetryEnabled;
const tasksSyncFailureRetryDelayMs = cfg.tasksSyncFailureRetryDelayMs;
const tasksSyncDeferredRetryDelayMs = cfg.tasksSyncDeferredRetryDelayMs;
const discordActionsTasks = cfg.discordActionsTasks;
const tasksPrefix = cfg.tasksPrefix;

// Initialize shared task store (used by tasks, forge, and plan subsystems).
// Created unconditionally so forge/plan have a persistent store even when tasks are disabled.
for (const dir of new Set([path.dirname(tasksPersistPath), path.dirname(tasksTagMapPath)])) {
  await fs.mkdir(dir, { recursive: true });
}

const tasksMigration = await migrateLegacyTaskDataFile(tasksDataRoot, 'tasks.jsonl');
if (tasksMigration.migrated) {
  log.warn(
    { from: tasksMigration.fromPath, to: tasksMigration.toPath },
    'tasks: migrated legacy beads task store to canonical path',
  );
}

const sharedTaskStore = new TaskStore({ prefix: tasksPrefix, persistPath: tasksPersistPath });
await sharedTaskStore.load();
log.info({ count: sharedTaskStore.size(), prefix: tasksPrefix }, 'tasks:store loaded');

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
const progressStallTimeoutMs = cfg.progressStallTimeoutMs;
const streamStallWarningMs = cfg.streamStallWarningMs;
const maxConcurrentInvocations = cfg.maxConcurrentInvocations;
const sharedConcurrencyLimiter = createConcurrencyLimiter(maxConcurrentInvocations);

// Build runtime registry
const runtimeRegistry = new RuntimeRegistry();

const MIN_CLAUDE_CLI_VERSION = '2.1.0';
const ensureClaudeCliVersion = () => {
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
      return;
    }
    log.warn({ raw: versionOutput.slice(0, 100) }, 'Could not parse Claude CLI version (continuing)');
  } catch (err) {
    log.error({ err, claudeBin }, 'Failed to check Claude CLI version — is the CLI installed?');
    process.exit(1);
  }
};

const registerClaudeRuntime = () => {
  ensureClaudeCliVersion();
  const claudeRuntime = createClaudeCliRuntime({
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
    progressStallTimeoutMs,
  });
  const limitedClaudeRuntime = withConcurrencyLimit(claudeRuntime, {
    maxConcurrentInvocations,
    limiter: sharedConcurrencyLimiter,
    log,
  });
  runtimeRegistry.register('claude', limitedClaudeRuntime);
  return limitedClaudeRuntime;
};

if (cfg.openaiApiKey) {
  const openaiRuntimeRaw = createOpenAICompatRuntime({
    baseUrl: cfg.openaiBaseUrl ?? 'https://api.openai.com/v1',
    apiKey: cfg.openaiApiKey,
    defaultModel: cfg.openaiModel,
    log,
  });
  const openaiRuntime = withConcurrencyLimit(openaiRuntimeRaw, {
    maxConcurrentInvocations,
    limiter: sharedConcurrencyLimiter,
    log,
  });
  runtimeRegistry.register('openai', openaiRuntime);
}

// Register Codex CLI runtime.
const codexRuntimeRaw = createCodexCliRuntime({
  codexBin: cfg.codexBin,
  defaultModel: cfg.codexModel,
  dangerouslyBypassApprovalsAndSandbox: cfg.codexDangerouslyBypassApprovalsAndSandbox,
  disableSessions: cfg.codexDisableSessions,
  log,
});
const codexRuntime = withConcurrencyLimit(codexRuntimeRaw, {
  maxConcurrentInvocations,
  limiter: sharedConcurrencyLimiter,
  log,
});
runtimeRegistry.register('codex', codexRuntime);
log.info(
  {
    codexBin: cfg.codexBin,
    model: cfg.codexModel,
    dangerouslyBypassApprovalsAndSandbox: cfg.codexDangerouslyBypassApprovalsAndSandbox,
    disableSessions: cfg.codexDisableSessions,
  },
  'runtime:codex registered',
);

// Register Gemini CLI runtime.
const geminiRuntimeRaw = createGeminiCliRuntime({
  geminiBin: cfg.geminiBin,
  defaultModel: cfg.geminiModel,
  log,
});
const geminiRuntime = withConcurrencyLimit(geminiRuntimeRaw, {
  maxConcurrentInvocations,
  limiter: sharedConcurrencyLimiter,
  log,
});
runtimeRegistry.register('gemini', geminiRuntime);
log.info(
  { geminiBin: cfg.geminiBin, model: cfg.geminiModel },
  'runtime:gemini registered',
);

const claudeRequested = primaryRuntimeName === 'claude' || cfg.forgeDrafterRuntime === 'claude' || cfg.forgeAuditorRuntime === 'claude';
if (claudeRequested) {
  registerClaudeRuntime();
}

const runtime = runtimeRegistry.get(primaryRuntimeName);
if (!runtime) {
  log.error(
    {
      primaryRuntime: primaryRuntimeName,
      availableRuntimes: runtimeRegistry.list(),
    },
    'PRIMARY_RUNTIME is not available. Check configuration (OPENAI_API_KEY, Claude CLI, runtime name).',
  );
  process.exit(1);
}
const limitedRuntime = runtime;

runtimeModel = resolveModel(cfg.runtimeModel, runtime.id);
summaryModel = resolveModel(cfg.summaryModel, runtime.id);
cronModel = resolveModel(cfg.cronModel, runtime.id);
cronAutoTagModel = resolveModel(cfg.cronAutoTagModel, runtime.id);
  tasksAutoTagModel = resolveModel(cfg.tasksAutoTagModel, runtime.id);
log.info(
  { primaryRuntime: primaryRuntimeName, runtimeId: runtime.id, model: runtimeModel },
  'runtime:primary selected',
);

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
        selected: primaryRuntimeName,
        runtimeId: runtime.id,
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

// Resolve the drafter runtime (if configured)
let drafterRuntime: import('./runtime/types.js').RuntimeAdapter | undefined;
if (cfg.forgeDrafterRuntime) {
  drafterRuntime = cfg.forgeDrafterRuntime === primaryRuntimeName
    ? limitedRuntime
    : runtimeRegistry.get(cfg.forgeDrafterRuntime);
  if (!drafterRuntime) {
    log.warn(
      `FORGE_DRAFTER_RUNTIME='${cfg.forgeDrafterRuntime}' but no adapter registered with that name. Available: ${runtimeRegistry.list().join(', ')}. Falling back to PRIMARY_RUNTIME='${primaryRuntimeName}'.`,
    );
  }
}

// Resolve the auditor runtime (if configured)
let auditorRuntime: import('./runtime/types.js').RuntimeAdapter | undefined;
if (cfg.forgeAuditorRuntime) {
  auditorRuntime = cfg.forgeAuditorRuntime === primaryRuntimeName
    ? limitedRuntime
    : runtimeRegistry.get(cfg.forgeAuditorRuntime);
  if (!auditorRuntime) {
    log.warn(
      `FORGE_AUDITOR_RUNTIME='${cfg.forgeAuditorRuntime}' but no adapter registered with that name. Available: ${runtimeRegistry.list().join(', ')}. Falling back to PRIMARY_RUNTIME='${primaryRuntimeName}'.`,
    );
  }
}

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));


const botParams = {
  token,
  allowUserIds,
  guildId,
  botDisplayName,
  dataDir: pidLockDir,
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
  projectCwd: projectRoot,
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
  // Enable tasks/crons actions only after contexts are configured.
  discordActionsTasks: false,
  discordActionsCrons: false,
  // Forge/plan/memory action flags — contexts are wired below after subsystem init.
  discordActionsForge: discordActionsForge && forgeCommandsEnabled,
  discordActionsPlan: discordActionsPlan && planCommandsEnabled,
  discordActionsMemory: discordActionsMemory && durableMemoryEnabled,
  discordActionsConfig: discordActionsEnabled, // Always enabled when actions are on — model switching is a core capability.
  discordActionsDefer: cfg.discordActionsDefer,
  deferMaxDelaySeconds: cfg.deferMaxDelaySeconds,
  deferMaxConcurrent: cfg.deferMaxConcurrent,
  deferScheduler: undefined as DeferScheduler<DeferActionRequest, ActionContext> | undefined,
  taskCtx: undefined as TaskContext | undefined,
  cronCtx: undefined as CronContext | undefined,
  forgeCtx: undefined as ForgeContext | undefined,
  planCtx: undefined as PlanContext | undefined,
  memoryCtx: undefined as MemoryContext | undefined,
  configCtx: undefined as import('./discord/actions-config.js').ConfigContext | undefined,
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
  planPhasesEnabled,
  planPhaseMaxContextFiles,
  planPhaseTimeoutMs,
  planPhaseMaxAuditFixAttempts,
  forgeCommandsEnabled,
  forgeMaxAuditRounds,
  forgeDrafterModel,
  forgeAuditorModel,
  forgeTimeoutMs,
  forgeProgressThrottleMs,
  forgeAutoImplement,
  drafterRuntime,
  auditorRuntime,
  summaryToDurableEnabled,
  shortTermMemoryEnabled,
  shortTermDataDir,
  shortTermMaxEntries,
  shortTermMaxAgeMs,
  shortTermInjectMaxChars,
  statusChannel,
  bootstrapEnsureTasksForum: tasksEnabled,
  existingCronsId: isSnowflake(cronForum ?? '') ? cronForum : undefined,
  existingTasksId: isSnowflake(tasksForum) ? tasksForum : undefined,
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
    tasksEnabled,
    tasksActive: false,
    tasksSyncFailureRetryEnabled,
    tasksSyncFailureRetryDelayMs,
    tasksSyncDeferredRetryDelayMs,
    requireChannelContext,
    autoIndexChannelContext,
  },
  metrics: globalMetrics,
  appendSystemPrompt,
  startupInjection,
};

if (discordActionsEnabled && cfg.discordActionsDefer) {
  const handleDeferredRun = async (run: DeferredRun): Promise<void> => {
    const { action, context } = run;
    const guild = context.guild;
    if (!guild) {
      log?.warn({ run, action }, 'defer:missing-guild');
      return;
    }

    const channel = resolveChannel(guild, action.channel);
    if (!channel) {
      log?.warn({ run, channel: action.channel }, 'defer:target channel not found');
      return;
    }

    if (botParams.allowChannelIds?.size) {
      const ch: any = channel;
      const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false;
      const parentId = isThread ? String(ch.parentId ?? '') : '';
      const allowed =
        botParams.allowChannelIds.has(channel.id) ||
        (parentId && botParams.allowChannelIds.has(parentId));
      if (!allowed) {
        log?.warn({ channelId: channel.id }, 'defer:target channel not allowlisted');
        return;
      }
    }

    const isThread = typeof (channel as any)?.isThread === 'function' ? (channel as any).isThread() : false;
    const threadParentId = isThread ? String((channel as any).parentId ?? '') : null;

    const channelCtx = resolveDiscordChannelContext({
      ctx: discordChannelContext,
      isDm: false,
      channelId: channel.id,
      threadParentId,
    });

    const paFiles = await loadWorkspacePaFiles(workspaceCwd, { skip: !!appendSystemPrompt });
    const contextFiles = buildContextFiles(paFiles, discordChannelContext, channelCtx.contextPath);
    let inlinedContext = '';
    if (contextFiles.length > 0) {
      try {
        inlinedContext = await inlineContextFiles(contextFiles, {
          required: new Set(discordChannelContext?.paContextFiles ?? []),
        });
      } catch (err) {
        log?.warn({ err, channelId: channel.id }, 'defer:context inline failed');
      }
    }

    const deferredActionFlags: ActionCategoryFlags = {
      channels: botParams.discordActionsChannels,
      messaging: botParams.discordActionsMessaging,
      guild: botParams.discordActionsGuild,
      moderation: botParams.discordActionsModeration,
      polls: botParams.discordActionsPolls,
      tasks: Boolean(botParams.discordActionsTasks),
      crons: Boolean(botParams.discordActionsCrons),
      botProfile: Boolean(botParams.discordActionsBotProfile),
      forge: Boolean(botParams.discordActionsForge),
      plan: Boolean(botParams.discordActionsPlan),
      // Deferred runs do not carry a user identity, so memory actions are disabled.
      memory: false,
      config: Boolean(botParams.discordActionsConfig),
      defer: false,
    };

    let prompt =
      (inlinedContext ? `${inlinedContext}\n\n` : '') +
      `---\nDeferred follow-up scheduled for <#${channel.id}> (runs at ${fmtTime(run.runsAt)}).\n---\n` +
      `User message:\n${action.prompt}`;

    if (botParams.discordActionsEnabled) {
      prompt += '\n\n---\n' + discordActionsPromptSection(deferredActionFlags, botDisplayName);
    }

    const noteLines: string[] = [];
    let effectiveTools = runtimeTools;
    try {
      const toolsInfo = await resolveEffectiveTools({
        workspaceCwd,
        runtimeTools,
        runtimeCapabilities: runtime.capabilities,
        runtimeId: runtime.id,
        log,
      });
      effectiveTools = toolsInfo.effectiveTools;
      if (toolsInfo.permissionNote) noteLines.push(`Permission note: ${toolsInfo.permissionNote}`);
      if (toolsInfo.runtimeCapabilityNote) noteLines.push(`Runtime capability note: ${toolsInfo.runtimeCapabilityNote}`);
    } catch (err) {
      log?.warn({ err }, 'defer:resolve effective tools failed');
    }

    if (noteLines.length > 0) {
      prompt += `\n\n---\n${noteLines.join('\n')}\n`;
    }

    const addDirs: string[] = [];
    if (useGroupDirCwd) addDirs.push(workspaceCwd);
    if (discordChannelContext) addDirs.push(discordChannelContext.contentDir);
    const uniqueAddDirs = addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined;

    let finalText = '';
    let deltaText = '';
    let runtimeError: string | undefined;
    try {
      for await (const evt of runtime.invoke({
        prompt,
        model: resolveModel(botParams.runtimeModel, runtime.id),
        cwd: workspaceCwd,
        addDirs: uniqueAddDirs,
        tools: effectiveTools,
        timeoutMs: runtimeTimeoutMs,
      })) {
        if (evt.type === 'text_final') {
          finalText = evt.text;
        } else if (evt.type === 'text_delta') {
          deltaText += evt.text;
        } else if (evt.type === 'error') {
          runtimeError = evt.message;
          finalText = mapRuntimeErrorToUserMessage(evt.message);
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtimeError ??= msg;
      finalText = mapRuntimeErrorToUserMessage(msg);
      log?.warn({ err }, 'defer:runtime invocation failed');
    }

    const processedText = finalText || deltaText || '';
    const parsed = parseDiscordActions(processedText, deferredActionFlags);
    const actCtx: ActionContext = {
      guild,
      client: context.client,
      channelId: channel.id,
      messageId: `defer-${Date.now()}`,
      threadParentId,
      confirmation: {
        mode: 'automated',
      },
    };
    let actionResults: DiscordActionResult[] = [];
    if (parsed.actions.length > 0) {
      actionResults = await executeDiscordActions(parsed.actions, actCtx, log, {
        taskCtx: botParams.taskCtx,
        cronCtx: botParams.cronCtx,
        forgeCtx: botParams.forgeCtx,
        planCtx: botParams.planCtx,
        memoryCtx: botParams.memoryCtx,
        configCtx: botParams.configCtx,
      });
    }

    const displayLines = buildDisplayResultLines(parsed.actions, actionResults);
    let outgoingText = parsed.cleanText.trim();
    if (displayLines.length > 0) {
      outgoingText = outgoingText ? `${outgoingText}\n\n${displayLines.join('\n')}` : displayLines.join('\n');
    }
    outgoingText = appendUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
    if (!outgoingText && runtimeError) {
      outgoingText = runtimeError;
    }

    if (outgoingText) {
      try {
        await channel.send({ content: outgoingText, allowedMentions: NO_MENTIONS });
      } catch (err) {
        log?.warn({ err, channelId: channel.id }, 'defer:failed to post follow-up');
      }
    }
  };

  const deferScheduler = new DeferScheduler({
    maxDelaySeconds: cfg.deferMaxDelaySeconds,
    maxConcurrent: cfg.deferMaxConcurrent,
    jobHandler: handleDeferredRun,
  });
  botParams.deferScheduler = deferScheduler;
  log.info({ maxDelaySeconds: cfg.deferMaxDelaySeconds, maxConcurrent: cfg.deferMaxConcurrent }, 'defer:scheduler configured');
}

const { client, status, system } = await startDiscordBot(botParams);
botStatus = status;

// --- Persist scaffold state (forum IDs) for next boot ---
if (system) {
  const newState: Record<string, string> = {};
  const resolvedGuild = guildId || system.guildId || '';
  if (resolvedGuild) newState.guildId = resolvedGuild;
  if (system.systemCategoryId) newState.systemCategoryId = system.systemCategoryId;
  if (system.cronsForumId) newState.cronsForumId = system.cronsForumId;
  if (system.tasksForumId) newState.tasksForumId = system.tasksForumId;
  if (Object.keys(newState).length > 0) {
    try {
      await fs.writeFile(scaffoldStatePath, JSON.stringify(newState, null, 2) + '\n', 'utf8');
      log.info({ scaffoldStatePath }, 'system-scaffold: persisted forum IDs');
    } catch (err) {
      log.warn({ err, scaffoldStatePath }, 'system-scaffold: failed to persist forum IDs');
    }
  }
}

// --- Cold-start: clean up orphaned in-flight replies from a previous unclean exit ---
await cleanupOrphanedReplies({ client, dataFilePath: path.join(pidLockDir, 'inflight.json'), log });

// --- Configure task context after bootstrap (so the forum can be auto-created) ---
let taskCtx: TaskContext | undefined;
if (tasksEnabled) {
  // Seed tag map from repo if data-dir copy doesn't exist yet.
  await seedTagMap(tasksTagMapSeedPath, tasksTagMapPath);

  const tasksResult = await initializeTasksContext({
    enabled: true,
    tasksCwd,
    tasksForum,
    tasksTagMapPath,
    tasksMentionUser,
    tasksSidebar,
    tasksAutoTag,
    tasksAutoTagModel,
    syncRunOptions: { skipPhase5: cfg.tasksSyncSkipPhase5 },
    tasksSyncFailureRetryEnabled,
    tasksSyncFailureRetryDelayMs,
    tasksSyncDeferredRetryDelayMs,
    runtime,
    resolveModel,
    metrics: globalMetrics,
    statusPoster: botStatus ?? undefined,
    hasInFlightForChannel,
    log,
    systemTasksForumId: system?.tasksForumId,
    store: sharedTaskStore,
  });
  taskCtx = tasksResult.taskCtx;
}

if (taskCtx) {
  // Attach status poster now that the bot is connected (may not have been available during pre-flight).
  if (!taskCtx.statusPoster && botStatus) {
    taskCtx.statusPoster = botStatus;
  }
  botParams.taskCtx = taskCtx;
  botParams.discordActionsTasks = discordActionsTasks && tasksEnabled;
  botParams.healthConfigSnapshot.tasksActive = true;

  // Wire coordinator + sync triggers + startup sync
  const resolvedGuildId = guildId || system?.guildId || '';
  const guild = resolvedGuildId ? client.guilds.cache.get(resolvedGuildId) : undefined;
  if (guild) {
    // Create forum count sync for tasks.
    const tasksForumChannel = await resolveTasksForum(guild, taskCtx.forumId);
    if (tasksForumChannel) {
      taskForumCountSync = new ForumCountSync(
        client,
        tasksForumChannel.id,
        async () => {
          return taskCtx!.store.list({ status: 'all' }).filter((b) => b.status !== 'closed').length;
        },
        log,
      );
      taskCtx.forumCountSync = taskForumCountSync;
      taskForumCountSync.requestUpdate();
    }

    // Install forum guard before any async operations that touch the forum.
    initTasksForumGuard({ client, forumId: taskCtx.forumId, log, store: taskCtx.store, tagMap: taskCtx.tagMap });

    // Tag bootstrap + reload BEFORE wireTaskSync so the first sync has the correct tag map.
    if (tasksForumChannel) {
      try {
        await ensureForumTags(guild, tasksForumChannel.id, tasksTagMapPath, {
          seedPath: tasksTagMapSeedPath,
          log,
        });
      } catch (err) {
        log.warn({ err }, 'tasks:tag bootstrap failed');
      }
      try {
        await reloadTagMapInPlace(tasksTagMapPath, taskCtx.tagMap);
      } catch (err) {
        log.warn({ err }, 'tasks:tag map reload failed');
      }
    }

    // Wire coordinator + sync triggers + startup sync (now uses correct tag map).
    const wired = await wireTaskSync(taskCtx, { client, guild });
    taskSyncWiring = wired;
  } else {
    log.warn({ resolvedGuildId }, 'tasks:sync wiring skipped; guild not in cache');
  }

  log.info(
    { tasksCwd, tasksForum: taskCtx.forumId, tagCount: Object.keys(taskCtx.tagMap).length, autoTag: tasksAutoTag },
    'tasks:initialized',
  );
}

// --- Forge / Plan / Memory action contexts ---
// Initialized before cron so cron executor can reference these contexts.
{
  const plansDir = path.join(workspaceCwd, 'plans');
  const effectiveTaskStore = sharedTaskStore;

  if (forgeCommandsEnabled && discordActionsForge) {
    botParams.forgeCtx = {
      orchestratorFactory: () =>
        new ForgeOrchestrator({
          runtime: limitedRuntime,
          drafterRuntime,
          auditorRuntime,
          model: botParams.runtimeModel,
          cwd: projectRoot,
          workspaceCwd,
          taskStore: effectiveTaskStore,
          plansDir,
          maxAuditRounds: forgeMaxAuditRounds,
          progressThrottleMs: forgeProgressThrottleMs,
          timeoutMs: forgeTimeoutMs,
          drafterModel: botParams.forgeDrafterModel,
          auditorModel: botParams.forgeAuditorModel,
          log,
        }),
      plansDir,
      workspaceCwd,
      taskStore: effectiveTaskStore,
      onProgress: async (msg) => {
        // Action-initiated forges log progress rather than posting to a channel.
        log.info({ msg }, 'forge:action:progress');
      },
      log,
    };
    log.info('forge:action context initialized');
  }

  if (planCommandsEnabled && discordActionsPlan) {
    botParams.planCtx = {
      plansDir,
      workspaceCwd,
      taskStore: effectiveTaskStore,
      log,
      runtime: limitedRuntime,
      model: runtimeModel,
      phaseTimeoutMs: planPhaseTimeoutMs,
      maxAuditFixAttempts: planPhaseMaxAuditFixAttempts,
      onProgress: async (msg) => {
        log.info({ msg }, 'plan:action:progress');
      },
    };
    log.info('plan:action context initialized');
  }

  if (durableMemoryEnabled && discordActionsMemory) {
    // Store a template memoryCtx — handlers override userId and Discord metadata per-message.
    botParams.memoryCtx = {
      userId: '',  // Placeholder — overridden per-message with msg.author.id.
      durableDataDir,
      durableMaxItems,
      durableInjectMaxChars,
      log,
    };
    log.info('memory:action context initialized');
  }

  if (discordActionsEnabled) {
    // Config actions are always available when actions are enabled.
    // botParams is read by reference, so mutations here take effect on next invocation.
    botParams.configCtx = {
      botParams,
      runtime: limitedRuntime,
    };
    log.info('config:action context initialized');
  }
}

// --- Cron subsystem ---
const effectiveCronForum = system?.cronsForumId || cronForum || undefined;
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
    tasks: discordActionsTasks && tasksEnabled && Boolean(taskCtx),
    // Prevent cron jobs from mutating cron state via emitted action blocks.
    crons: false,
    botProfile: false, // Intentionally excluded from cron flows to avoid rate-limit and abuse issues.
    forge: discordActionsForge && forgeCommandsEnabled, // Enables cron → forge autonomous workflows.
    plan: discordActionsPlan && planCommandsEnabled, // Enables cron → plan autonomous workflows.
    memory: false, // No user context in cron flows.
    config: false, // No model switching from cron flows.
    defer: false,
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

  if (botParams.deferScheduler) {
    cronCtx.deferScheduler = botParams.deferScheduler;
  }

  const cronExecCtx = {
    client,
    runtime,
    model: runtimeModel,
    cronExecModel: undefined as string | undefined,
    cwd: workspaceCwd,
    tools: runtimeTools,
    timeoutMs: runtimeTimeoutMs,
    status: botStatus,
    log,
    allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
    discordActionsEnabled,
    actionFlags: cronActionFlags,
    deferScheduler: botParams.deferScheduler,
    taskCtx,
    cronCtx,
    forgeCtx: botParams.forgeCtx,
    planCtx: botParams.planCtx,
    statsStore: cronStats,
    lockDir: cronLocksDir,
    runControl: cronRunControl,
  };

  savedCronExecCtx = cronExecCtx;
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
        await ensureForumTags(guild, effectiveCronForum, cronTagMapPath, { log });
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
  log.warn('DISCOCLAW_CRON_ENABLED=1 but no agents forum was resolved (set DISCORD_GUILD_ID or DISCOCLAW_CRON_FORUM); cron subsystem disabled');
}

// --- Webhook subsystem ---
if (cfg.webhookEnabled && savedCronExecCtx) {
  if (!cfg.webhookConfigPath) {
    log.warn('DISCOCLAW_WEBHOOK_ENABLED=1 but DISCOCLAW_WEBHOOK_CONFIG is not set; webhook server disabled');
  } else {
    const resolvedGuildId = guildId || system?.guildId || '';
    if (!resolvedGuildId) {
      log.warn('DISCOCLAW_WEBHOOK_ENABLED=1 but no guild ID resolved; webhook server disabled');
    } else {
      // Build a webhook-specific executor context with security overrides:
      // no Discord actions, no tools.
      const webhookExecCtx = {
        ...savedCronExecCtx,
        discordActionsEnabled: false,
        tools: [],
      };

      try {
        const webhookHost = '127.0.0.1';
        webhookServer = await startWebhookServer({
          configPath: cfg.webhookConfigPath,
          port: cfg.webhookPort,
          host: webhookHost,
          guildId: resolvedGuildId,
          executorCtx: webhookExecCtx,
          log,
        });
        log.info({ port: cfg.webhookPort, configPath: cfg.webhookConfigPath }, 'webhook:server started');
        if (webhookHost === '127.0.0.1' || webhookHost === '::1') {
          log.warn(
            { host: webhookHost, port: cfg.webhookPort },
            'webhook:server is bound to loopback — external services (e.g. GitHub) cannot reach it. See docs/webhook-exposure.md for exposure options (Tailscale Funnel recommended)',
          );
        }
      } catch (err) {
        log.error({ err }, 'webhook:server failed to start');
      }
    }
  }
} else if (cfg.webhookEnabled && !savedCronExecCtx) {
  log.warn('DISCOCLAW_WEBHOOK_ENABLED=1 but cron executor context is not available; webhook server disabled');
}

if (reactionHandlerEnabled) {
  log.info({ reactionMaxAgeHours }, 'reaction:handler enabled');
}
if (reactionRemoveHandlerEnabled) {
  log.info({ reactionMaxAgeHours }, 'reaction-remove:handler enabled');
}

log.info('Discord bot started');

// --- Await credential check results and log any failures ---
const credentialCheckReport = await credentialCheckPromise;
const credentialReport = formatCredentialReport(credentialCheckReport);
if (credentialCheckReport.criticalFailures.length > 0) {
  for (const name of credentialCheckReport.criticalFailures) {
    const result = credentialCheckReport.results.find((r) => r.name === name);
    log.error({ name, message: result?.message }, 'boot:credential-check: critical credential failed');
  }
}
for (const result of credentialCheckReport.results) {
  if (result.status === 'fail' && !credentialCheckReport.criticalFailures.includes(result.name)) {
    log.warn({ name: result.name, message: result.message }, 'boot:credential-check: non-critical credential failed');
  }
}
log.info({ credentialReport }, 'boot:credential-check');

// --- Boot report (replaces the bare online() call in startDiscordBot) ---
if (botStatus?.bootReport) {
  const actionCategoriesEnabled: string[] = [];
  if (discordActionsChannels) actionCategoriesEnabled.push('channels');
  if (discordActionsMessaging) actionCategoriesEnabled.push('messaging');
  if (discordActionsGuild) actionCategoriesEnabled.push('guild');
  if (discordActionsModeration) actionCategoriesEnabled.push('moderation');
  if (discordActionsPolls) actionCategoriesEnabled.push('polls');
  if (discordActionsTasks && tasksEnabled) actionCategoriesEnabled.push('tasks');
  if (discordActionsCrons && cronEnabled) actionCategoriesEnabled.push('crons');
  if (discordActionsBotProfile) actionCategoriesEnabled.push('bot-profile');
  if (discordActionsForge && forgeCommandsEnabled) actionCategoriesEnabled.push('forge');
  if (discordActionsPlan && planCommandsEnabled) actionCategoriesEnabled.push('plan');
  if (discordActionsMemory && durableMemoryEnabled) actionCategoriesEnabled.push('memory');

  botStatus.bootReport({
    startupType: startupCtx.type,
    shutdownReason: startupCtx.shutdown?.reason,
    shutdownMessage: startupCtx.shutdown?.message,
    shutdownRequestedBy: startupCtx.shutdown?.requestedBy,
    activeForge: startupCtx.shutdown?.activeForge,
    tasksEnabled: tasksEnabled,
    forumResolved: Boolean(taskCtx?.forumId),
    cronsEnabled: Boolean(cronEnabled && botParams.cronCtx),
    cronJobCount: cronScheduler?.listJobs().length,
    memoryEpisodicOn: summaryEnabled,
    memorySemanticOn: durableMemoryEnabled,
    memoryWorkingOn: shortTermMemoryEnabled,
    actionCategoriesEnabled,
    configWarnings: parsedConfig.warnings.length,
    permissionsStatus: permProbe.status === 'valid' ? 'ok' : permProbe.status,
    permissionsReason: permProbe.status === 'invalid' ? permProbe.reason : undefined,
    permissionsTier: permProbe.status === 'valid' ? permProbe.permissions.tier : undefined,
    credentialReport,
    runtimeModel,
    bootDurationMs: Date.now() - bootStartMs,
    buildVersion: gitHash ?? undefined,
  }).catch((err) => log.warn({ err }, 'status-channel: boot report failed'));
}
