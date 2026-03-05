import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime } from './runtime/claude-code-cli.js';
import { killAllSubprocesses } from './runtime/cli-adapter.js';
import { RuntimeRegistry } from './runtime/registry.js';
import type { RuntimeAdapter } from './runtime/types.js';
import { createOpenAICompatRuntime } from './runtime/openai-compat.js';
import { createCodexCliRuntime } from './runtime/codex-cli.js';
import { createGeminiCliRuntime } from './runtime/gemini-cli.js';
import { createGeminiRestRuntime } from './runtime/gemini-rest.js';
import { createAnthropicRestRuntime } from './runtime/anthropic-rest.js';
import { createConcurrencyLimiter } from './runtime/concurrency-limit.js';
import { SessionManager } from './sessions.js';
import { loadDiscordChannelContext, validatePaContextModules, ensureIndexedDiscordChannelContext, resolveDiscordChannelContext } from './discord/channel-context.js';
import { buildDurableMemorySection } from './discord/prompt-common.js';
import type { ActionCategoryFlags, ActionContext } from './discord/actions.js';
import { parseDiscordActions, executeDiscordActions, buildTieredDiscordActionsPromptSection, buildAllResultLines } from './discord/actions.js';
import { DiscordTransportClient } from './discord/transport-client.js';
import { buildVoiceActionFlags } from './voice/voice-action-flags.js';
import { loadVoiceIdentity, buildVoicePrompt, buildVoiceFollowUpPrompt, buildVoicePromptSectionEstimates } from './voice/voice-prompt-builder.js';
import { sanitizeForVoice, sanitizeVoiceReplyForSpeech } from './voice/voice-sanitize.js';
import type { Turn } from './voice/conversation-buffer.js';
import type { SubsystemContexts } from './discord/actions.js';
import { shouldTriggerFollowUp } from './discord/action-categories.js';
import type { DeferScheduler } from './discord/defer-scheduler.js';
import type { DeferActionRequest } from './discord/actions-defer.js';
import { configureDeferredScheduler, type ConfigureDeferredSchedulerOpts } from './discord/deferred-runner.js';
import { startDiscordBot, getActiveForgeId } from './discord.js';
import type { StatusPoster } from './discord/status-channel.js';
import { LongRunWatchdog, type LongRunWatchdogRun } from './discord/long-run-watchdog.js';
import { NO_MENTIONS } from './discord/allowed-mentions.js';
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
import type { ImagegenContext } from './discord/actions-imagegen.js';
import type { SpawnContext } from './discord/actions-spawn.js';
import { cancelAll as cancelAllSpawns } from './discord/spawn-registry.js';
import { tryAbortAll } from './discord/abort-registry.js';
import { VoiceConnectionManager } from './voice/connection-manager.js';
import { AudioPipelineManager } from './voice/audio-pipeline.js';
import { VoicePresenceHandler } from './voice/presence-handler.js';
import { opusDecoderFactory } from './voice/opus.js';
import { TranscriptMirror } from './voice/transcript-mirror.js';
import { ForgeOrchestrator } from './discord/forge-commands.js';
import { initializeTasksContext, wireTaskSync } from './tasks/initialize.js';
import { ForumCountSync } from './discord/forum-count-sync.js';
import { resolveTasksForum } from './tasks/thread-ops.js';
import { initTasksForumGuard } from './tasks/forum-guard.js';
import { reloadTagMapInPlace } from './tasks/tag-map.js';
import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';
import { probeWorkspacePermissions } from './workspace-permissions.js';
import { detectMcpServers, validateMcpServerNames } from './mcp-detect.js';
import { loadRunStats } from './cron/run-stats.js';
import { seedTagMap } from './cron/discord-sync.js';
import { loadCronTagMapStrict } from './cron/tag-map.js';
import { CronSyncCoordinator } from './cron/cron-sync-coordinator.js';
import { startCronTagMapWatcher } from './cron/cron-tag-map-watcher.js';
import { ensureForumTags, isSnowflake } from './discord/system-bootstrap.js';
import { parseConfig } from './config.js';
import { startWebhookServer } from './webhook/server.js';
import type { WebhookServer } from './webhook/server.js';
import { resolveModel, initTierOverrides } from './runtime/model-tiers.js';
import { resolveDisplayName } from './identity.js';
import { globalMetrics } from './observability/metrics.js';
import { MemorySampler } from './observability/memory-sampler.js';
import {
  setDataFilePath,
  drainInFlightReplies,
  hasInFlightForChannel,
} from './discord/inflight-replies.js';
import { isRunActiveInChannel } from './discord/forge-plan-registry.js';
import { writeShutdownContext, patchShutdownContext, readAndClearShutdownContext, formatStartupInjection } from './discord/shutdown-context.js';
import { getGitHash } from './version.js';
import { getLocalVersion, getLatestNpmVersion } from './npm-managed.js';
import { healCorruptedJsonStores, healStaleCronRecords, healInterruptedCronRuns } from './health/startup-healing.js';
import { validateDiscordToken } from './validate.js';
import { TaskStore } from './tasks/store.js';
import { migrateLegacyTaskDataFile, resolveTaskDataPath } from './tasks/path-defaults.js';
import { resolveCronTagBootstrapForumId, resolveSessionStorePath } from './index.paths.js';
import {
  collectActiveProviders,
  logRuntimeDebugConfig,
  registerRuntimeWithGlobalPolicies,
  resolveFastRuntime,
  resolveForgeRuntimes,
} from './index.runtime.js';
import { buildActionCategoriesEnabled, publishBootReport, runPostConnectStartupChecks } from './index.post-connect.js';
import { loadOverrides, saveOverrides, clearOverrides, resolveOverridesPath, type RuntimeOverrides } from './runtime-overrides.js';
import type { ModelRole } from './discord/actions-config.js';
import { parseGlobalSupervisorBail, type GlobalSupervisorAuditPayload } from './runtime/global-supervisor.js';
import type { StreamingPreviewMode } from './discord/output-utils.js';

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
initTierOverrides(process.env);

const token = cfg.token;
const allowUserIds = cfg.allowUserIds;
const allowBotIds = cfg.allowBotIds;
const botMessageMemoryWriteEnabled = cfg.botMessageMemoryWriteEnabled;
const allowChannelIds = cfg.allowChannelIds;
const restrictChannelIds = cfg.restrictChannelIds;

const primaryRuntimeName = cfg.primaryRuntime;
const fastRuntimeName = cfg.fastRuntime;
let runtimeModel = cfg.runtimeModel;
const runtimeTools = cfg.runtimeTools;
const runtimeTimeoutMs = cfg.runtimeTimeoutMs;

const dataDir = cfg.dataDir;
const overridesPath = resolveOverridesPath(dataDir, projectRoot);

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

// --- Resolve npm version info (fire early, await later before boot report) ---
const npmVersion = getLocalVersion();
const npmLatestVersionPromise = getLatestNpmVersion();

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
let cronTagMapWatcher: { stop(): void } | null = null;
let taskForumCountSync: ForumCountSync | undefined;
let cronForumCountSync: ForumCountSync | undefined;
let webhookServer: WebhookServer | null = null;
let savedCronExecCtx: import('./cron/executor.js').CronExecutorContext | null = null;
let voiceManager: VoiceConnectionManager | null = null;
let audioPipeline: AudioPipelineManager | null = null;
let voicePresenceHandler: VoicePresenceHandler | null = null;
let deferSchedulerRef: DeferScheduler<DeferActionRequest, ActionContext> | null = null;
let longRunWatchdog: LongRunWatchdog | null = null;
const memorySampler = new MemorySampler();
globalMetrics.setMemorySampler(memorySampler);
memorySampler.sample();
const memorySamplerInterval = setInterval(() => {
  memorySampler.sample();
}, 30_000);
memorySamplerInterval.unref?.();
let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  // Abort all active stream consumers so they stop spawning new pool processes.
  tryAbortAll();

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

  // Cancel watchdog timers before draining replies.
  longRunWatchdog?.dispose();

  // Cancel deferred timers first — before drain — so they cannot fire and produce
  // new in-flight replies during the drain window.
  if (deferSchedulerRef) {
    const cancelled = deferSchedulerRef.cancelAll();
    if (cancelled > 0) {
      log.info({ cancelled }, 'shutdown:deferred timers cancelled');
      try {
        await patchShutdownContext(pidLockDir, { cancelledDefers: cancelled });
      } catch (err) {
        log.warn({ err }, 'shutdown:failed to patch cancelledDefers');
      }
    }
  }
  // Clear the spawn registry so we can report how many agents were in flight.
  {
    const cancelled = cancelAllSpawns();
    if (cancelled > 0) {
      log.info({ cancelled }, 'shutdown:spawned agents cancelled');
      try {
        await patchShutdownContext(pidLockDir, { cancelledSpawns: cancelled });
      } catch (err) {
        log.warn({ err }, 'shutdown:failed to patch cancelledSpawns');
      }
    }
  }
  // Edit all in-progress Discord replies before killing subprocesses.
  await drainInFlightReplies({ timeoutMs: 3000, log });
  // Kill all CLI subprocesses so they release session locks before the new instance starts.
  killAllSubprocesses();
  // Best-effort: may not complete before SIGKILL on short shutdown windows.
  taskForumCountSync?.stop();
  cronForumCountSync?.stop();
  cronTagMapWatcher?.stop();
  cronScheduler?.stopAll();
  voicePresenceHandler?.destroy();
  await audioPipeline?.stopAll();
  voiceManager?.leaveAll();
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
const summaryMaxTokens = cfg.summaryMaxTokens;
const summaryTargetRatio = cfg.summaryTargetRatio;
const summaryDataDir = cfg.summaryDataDirOverride
  || (dataDir ? path.join(dataDir, 'memory', 'rolling') : path.join(__dirname, '..', 'data', 'memory', 'rolling'));
const summaryArchiveDir = cfg.summaryArchiveDirOverride
  || (dataDir ? path.join(dataDir, 'memory', 'summary-archive') : path.join(__dirname, '..', 'data', 'memory', 'summary-archive'));
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
const planForgeHeartbeatIntervalMs = cfg.planForgeHeartbeatIntervalMs;
const forgeCommandsEnabled = cfg.forgeCommandsEnabled;
const forgeMaxAuditRounds = cfg.forgeMaxAuditRounds;
const forgeDrafterModel = cfg.forgeDrafterModel;
const forgeAuditorModel = cfg.forgeAuditorModel;
const forgeTimeoutMs = cfg.forgeTimeoutMs;
const forgeProgressThrottleMs = cfg.forgeProgressThrottleMs;
const forgeAutoImplement = cfg.forgeAutoImplement;
const completionNotifyEnabled = cfg.completionNotifyEnabled;
const completionNotifyThresholdMs = cfg.completionNotifyThresholdMs;
const summaryToDurableEnabled = cfg.summaryToDurableEnabled;
const durableSupersessionShadow = cfg.durableSupersessionShadow;
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
const cronStatsPath = path.join(cronStatsDir, 'cron-run-stats.json');
const longRunStillRunningDelayMs = Math.max(1, completionNotifyThresholdMs);
const longRunWatchdogDataPath = path.join(pidLockDir, 'long-run-watchdog.json');
const emptyLongRunSweepResult = {
  interruptedRuns: 0,
  finalRetried: 0,
  finalPosted: 0,
  finalFailed: 0,
};
let longRunWatchdogClientRef: Awaited<ReturnType<typeof startDiscordBot>>['client'] | null = null;

async function postLongRunWatchdogNotice(run: Pick<LongRunWatchdogRun, 'runId' | 'channelId' | 'messageId'>, content: string): Promise<void> {
  const clientRef = longRunWatchdogClientRef;
  if (!clientRef) {
    throw new Error('Discord client unavailable');
  }

  const channel = clientRef.channels.cache.get(run.channelId)
    ?? await clientRef.channels.fetch(run.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`watchdog channel unavailable (${run.channelId})`);
  }

  const send = (channel as { send?: unknown }).send;
  if (typeof send !== 'function') {
    throw new Error(`watchdog channel is not sendable (${run.channelId})`);
  }

  const channelLike = channel as {
    send: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;
    messages?: {
      fetch?: (id: string) => Promise<unknown>;
    };
  };
  const fetchMessage = channelLike.messages?.fetch;
  if (typeof fetchMessage === 'function') {
    const source = await fetchMessage.call(channelLike.messages, run.messageId).catch(() => null);
    const reply = (source as { reply?: unknown } | null)?.reply;
    if (typeof reply === 'function') {
      await reply.call(source, { content, allowedMentions: NO_MENTIONS });
      return;
    }
  }

  await channelLike.send({ content, allowedMentions: NO_MENTIONS });
}

function buildLongRunFinalNotice(run: Pick<LongRunWatchdogRun, 'completion'>, source: 'complete' | 'startup-sweep'): string {
  const base = run.completion === 'succeeded'
    ? 'Run complete.'
    : run.completion === 'failed'
      ? 'Run ended with errors.'
      : 'Run interrupted by restart/shutdown.';
  return source === 'startup-sweep' ? `${base} (Recovered after restart.)` : base;
}

const messageCoordinatorWatchdog = completionNotifyEnabled
  ? (() => {
    const watchdog = new LongRunWatchdog({
      dataFilePath: longRunWatchdogDataPath,
      stillRunningDelayMs: longRunStillRunningDelayMs,
      postStillRunning: async (run) => {
        await postLongRunWatchdogNotice(run, 'Still running. I will post another update when this finishes.');
      },
      postFinal: async (run, meta) => {
        await postLongRunWatchdogNotice(run, buildLongRunFinalNotice(run, meta.source));
      },
      log,
    });
    longRunWatchdog = watchdog;
    return {
      start: watchdog.start.bind(watchdog),
      complete: watchdog.complete.bind(watchdog),
      // Startup sweep is intentionally run after Discord connect from index.ts.
      startupSweep: async () => ({ ...emptyLongRunSweepResult }),
    };
  })()
  : undefined;

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
  log.error(
    { workspaceCwd, reason: permProbe.reason },
    'PERMISSIONS.json is invalid — falling back to env/default tools.',
  );
} else {
  log.info({ workspaceCwd, tier: permProbe.permissions.tier }, 'workspace permissions loaded');
}

// --- Detect MCP servers (startup health visibility) ---
const mcpResult = await detectMcpServers(workspaceCwd);
if (mcpResult.status === 'missing') {
  log.debug({ workspaceCwd }, 'mcp: no .mcp.json found');
} else if (mcpResult.status === 'invalid') {
  log.warn({ workspaceCwd, reason: mcpResult.reason }, 'mcp: .mcp.json is invalid — MCP servers will not load');
} else {
  const serverNames = mcpResult.servers.map((s) => s.name);
  const claudeInUse = primaryRuntimeName === 'claude'
    || fastRuntimeName === 'claude'
    || cfg.forgeDrafterRuntime === 'claude'
    || cfg.forgeAuditorRuntime === 'claude';
  let msg = serverNames.length === 0
    ? 'mcp: .mcp.json found but no servers configured'
    : `mcp: ${serverNames.length} server${serverNames.length === 1 ? '' : 's'} configured: ${serverNames.join(', ')}`;
  if (serverNames.length > 0 && !claudeInUse) {
    msg += ' (MCP servers only active with Claude runtime)';
  }
  log.info(
    { servers: serverNames, count: serverNames.length, strictMcpConfig: cfg.strictMcpConfig },
    msg,
  );
}
if (mcpResult.status === 'found' && mcpResult.servers.length > 0) {
  for (const warning of validateMcpServerNames(mcpResult.servers)) {
    log.warn({}, warning);
  }
}

// --- Resolve bot display name ---
const botDisplayName = await resolveDisplayName({
  configName: cfg.botDisplayName,
  workspaceCwd,
  log,
});
log.info({ botDisplayName }, 'resolved bot display name');

// Resolve task data paths early for JSON healing (before scaffold state is parsed).
const tasksDataRoot = dataDir ?? path.join(__dirname, '..', 'data');
const tasksDataDir = path.join(tasksDataRoot, 'tasks');
const tasksTagMapDefaultPath =
  resolveTaskDataPath(tasksDataRoot, 'tag-map.json')
  ?? path.join(tasksDataDir, 'tag-map.json');
const tasksTagMapPath = cfg.tasksTagMapPathOverride || tasksTagMapDefaultPath;

// --- Load persisted scaffold state (forum IDs created on previous boots) ---
const scaffoldStatePath = path.join(pidLockDir, 'system-scaffold.json');

// --- JSON healing: back up any corrupted JSON stores before loaders read them ---
await healCorruptedJsonStores(
  [
    { path: scaffoldStatePath, label: 'system-scaffold' },
    { path: cronStatsPath, label: 'cron-run-stats' },
    { path: cronTagMapPath, label: 'cron-tag-map' },
    { path: tasksTagMapPath, label: 'tasks-tag-map' },
  ],
  log,
);

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
const tasksPersistPath =
  resolveTaskDataPath(tasksDataRoot, 'tasks.jsonl')
  ?? path.join(tasksDataDir, 'tasks.jsonl');
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
const streamPreviewMode: StreamingPreviewMode = cfg.streamPreviewRaw ? 'raw' : 'compact';
const multiTurn = cfg.multiTurn;
const multiTurnHangTimeoutMs = cfg.multiTurnHangTimeoutMs;
const multiTurnIdleTimeoutMs = cfg.multiTurnIdleTimeoutMs;
const multiTurnMaxProcesses = cfg.multiTurnMaxProcesses;
const streamStallTimeoutMs = cfg.streamStallTimeoutMs;
const progressStallTimeoutMs = cfg.progressStallTimeoutMs;
const streamStallWarningMs = cfg.streamStallWarningMs;
const debugStreamPreviewLines = cfg.debugStreamPreviewLines;
const maxConcurrentInvocations = cfg.maxConcurrentInvocations;
const globalSupervisorEnabled = cfg.globalSupervisorEnabled;
const globalSupervisorAuditStream = cfg.globalSupervisorAuditStream;
const globalSupervisorLimits = {
  maxCycles: cfg.globalSupervisorMaxCycles,
  maxRetries: cfg.globalSupervisorMaxRetries,
  maxEscalationLevel: cfg.globalSupervisorMaxEscalationLevel,
  maxTotalEvents: cfg.globalSupervisorMaxTotalEvents,
  maxWallTimeMs: cfg.globalSupervisorMaxWallTimeMs,
};
const sharedConcurrencyLimiter = createConcurrencyLimiter(maxConcurrentInvocations);

function isGlobalSupervisorAuditPayload(value: unknown): value is GlobalSupervisorAuditPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.source === 'global_supervisor'
    && (payload.phase === 'plan' || payload.phase === 'execute' || payload.phase === 'evaluate' || payload.phase === 'decide');
}

function parseGlobalSupervisorAuditLine(line: string): GlobalSupervisorAuditPayload | null {
  try {
    const parsed = JSON.parse(line);
    return isGlobalSupervisorAuditPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withSupervisorAuditLogs(runtimeName: string, runtime: RuntimeAdapter): RuntimeAdapter {
  return {
    ...runtime,
    async *invoke(params) {
      for await (const evt of runtime.invoke(params)) {
        if (evt.type === 'log_line') {
          const audit = parseGlobalSupervisorAuditLine(evt.line);
          if (audit) {
            log.info({ runtimeName, ...audit }, 'obs.supervisor.cycle');
            continue;
          }
        } else if (evt.type === 'error') {
          const bail = parseGlobalSupervisorBail(evt.message);
          if (bail) {
            log.warn({ runtimeName, ...bail }, 'obs.supervisor.bail');
          }
        }
        yield evt;
      }
    },
  };
}

const registerRuntime = (name: string, runtime: RuntimeAdapter): RuntimeAdapter => {
  const wrapped = registerRuntimeWithGlobalPolicies({
    name,
    runtimeRegistry,
    runtime,
    maxConcurrentInvocations,
    limiter: sharedConcurrencyLimiter,
    log,
    env: process.env,
    globalSupervisorEnabled,
    globalSupervisorAuditStream,
    globalSupervisorLimits,
  });
  const observed = withSupervisorAuditLogs(name, wrapped);
  runtimeRegistry.register(name, observed);
  return observed;
};

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
  return registerRuntime('claude', claudeRuntime);
};

if (cfg.openaiApiKey) {
  const openaiRuntimeRaw = createOpenAICompatRuntime({
    id: 'openai',
    baseUrl: cfg.openaiBaseUrl ?? 'https://api.openai.com/v1',
    apiKey: cfg.openaiApiKey,
    defaultModel: cfg.openaiModel,
    enableTools: cfg.openaiCompatToolsEnabled,
    enableHybridPipeline: cfg.openaiCompatHybridPipelineEnabled,
    log,
  });
  registerRuntime('openai', openaiRuntimeRaw);
}

if (cfg.openrouterApiKey) {
  const openrouterRuntimeRaw = createOpenAICompatRuntime({
    id: 'openrouter',
    baseUrl: cfg.openrouterBaseUrl ?? 'https://openrouter.ai/api/v1',
    apiKey: cfg.openrouterApiKey,
    defaultModel: cfg.openrouterModel,
    enableTools: cfg.openaiCompatToolsEnabled,
    enableHybridPipeline: cfg.openaiCompatHybridPipelineEnabled,
    log,
  });
  registerRuntime('openrouter', openrouterRuntimeRaw);
  log.info(
    { baseUrl: cfg.openrouterBaseUrl ?? 'https://openrouter.ai/api/v1', model: cfg.openrouterModel },
    'runtime:openrouter registered',
  );
}

// Register Codex CLI runtime.
const codexRuntimeRaw = createCodexCliRuntime({
  codexBin: cfg.codexBin,
  defaultModel: cfg.codexModel,
  dangerouslyBypassApprovalsAndSandbox: cfg.codexDangerouslyBypassApprovalsAndSandbox,
  disableSessions: cfg.codexDisableSessions,
  verbosePreview: cfg.codexVerbosePreview,
  itemTypeDebug: cfg.codexItemTypeDebug,
  appendSystemPrompt,
  log,
});
registerRuntime('codex', codexRuntimeRaw);
log.info(
  {
    codexBin: cfg.codexBin,
    model: cfg.codexModel,
    dangerouslyBypassApprovalsAndSandbox: cfg.codexDangerouslyBypassApprovalsAndSandbox,
    disableSessions: cfg.codexDisableSessions,
    verbosePreview: cfg.codexVerbosePreview,
    itemTypeDebug: cfg.codexItemTypeDebug,
  },
  'runtime:codex registered',
);

// Register Gemini runtime — prefer REST API when GEMINI_API_KEY is set (zero startup
// overhead), fall back to CLI adapter when it's not (uses OAuth or env-based auth).
if (cfg.geminiApiKey) {
  const geminiRestRaw = createGeminiRestRuntime({
    apiKey: cfg.geminiApiKey,
    defaultModel: cfg.geminiModel,
    log,
  });
  registerRuntime('gemini', geminiRestRaw);
  log.info(
    { adapter: 'rest', model: cfg.geminiModel },
    'runtime:gemini registered (REST API)',
  );
} else {
  const geminiCliRaw = createGeminiCliRuntime({
    geminiBin: cfg.geminiBin,
    defaultModel: cfg.geminiModel,
    log,
  });
  registerRuntime('gemini', geminiCliRaw);
  log.info(
    { adapter: 'cli', geminiBin: cfg.geminiBin, model: cfg.geminiModel },
    'runtime:gemini registered (CLI)',
  );
}

const claudeRequested = primaryRuntimeName === 'claude'
  || fastRuntimeName === 'claude'
  || cfg.forgeDrafterRuntime === 'claude'
  || cfg.forgeAuditorRuntime === 'claude';
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
const fastRuntime = resolveFastRuntime({
  primaryRuntimeName,
  primaryRuntime: limitedRuntime,
  fastRuntime: fastRuntimeName,
  runtimeRegistry,
  log,
});

runtimeModel = resolveModel(cfg.runtimeModel, runtime.id);
summaryModel = resolveModel(cfg.summaryModel, fastRuntime.id);
cronModel = resolveModel(cfg.cronModel, fastRuntime.id);
cronAutoTagModel = resolveModel(cfg.cronAutoTagModel, fastRuntime.id);
tasksAutoTagModel = resolveModel(cfg.tasksAutoTagModel, fastRuntime.id);
const voiceModel = resolveModel(cfg.voiceModel, runtime.id);
const cronExecModel = resolveModel(cfg.cronExecModel, runtime.id);
const voiceModelRef: { model: string; runtime?: RuntimeAdapter; runtimeName?: string } = { model: voiceModel };
const voiceRuntimeRef: { runtime: RuntimeAdapter; name: string } = { runtime: limitedRuntime, name: primaryRuntimeName };

/**
 * Resolve the voice runtime at invocation time.
 *
 * Priority:
 *  1. Explicit override on voiceModelRef (set by auto-wiring or runtime-overrides.json)
 *  2. The 'anthropic' adapter from the registry (zero cold-start, ideal for voice)
 *  3. The primary limited runtime (fallback)
 */
export function resolveVoiceRuntime(
  voiceRef: { runtime?: RuntimeAdapter },
  registry: RuntimeRegistry,
  fallback: RuntimeAdapter,
): RuntimeAdapter {
  if (voiceRef.runtime) return voiceRef.runtime;
  return registry.get('anthropic') ?? fallback;
}

// Register Anthropic REST adapter when ANTHROPIC_API_KEY is set (direct HTTP, zero cold-start).
// Used as the default voice runtime to eliminate CLI subprocess overhead.
if (cfg.anthropicApiKey) {
  const anthropicRestRaw = createAnthropicRestRuntime({
    apiKey: cfg.anthropicApiKey,
    defaultModel: 'claude-sonnet-4-6',
    log,
  });
  const anthropicRuntime = registerRuntime('anthropic', anthropicRestRaw);
  log.info({ adapter: 'rest', model: 'claude-sonnet-4-6' }, 'runtime:anthropic registered (Messages API)');

  // Auto-wire as voice runtime to eliminate CLI cold-start latency
  if (cfg.voiceEnabled) {
    voiceModelRef.runtime = anthropicRuntime;
    voiceModelRef.runtimeName = 'anthropic';
    // Re-resolve the voice model against the Anthropic adapter's tier mapping
    const reResolved = resolveModel(cfg.voiceModel, anthropicRuntime.id);
    voiceModelRef.model = reResolved || anthropicRuntime.defaultModel || voiceModelRef.model;
    voiceRuntimeRef.runtime = anthropicRuntime;
    voiceRuntimeRef.name = 'anthropic';
    log.info(
      { voiceRuntime: 'anthropic', voiceModel: voiceModelRef.model },
      'voice: auto-wired to Anthropic REST adapter (zero cold-start)',
    );
  }
}

// --- Load runtime-overrides.json (persistent overlay on top of .env defaults) ---
const overrides = await loadOverrides(overridesPath, (msg, data) => log.warn(data ?? {}, msg));
let currentOverridesState: RuntimeOverrides = {
  ...overrides,
  models: overrides.models ? { ...overrides.models } : undefined,
};
const overrideModels = overrides.models ?? {};

// Apply model overrides to live variables. 'fast' is applied before 'summary'/'cron' so
// that individual-role overrides win if both are present.
if (overrideModels['chat']) {
  runtimeModel = overrideModels['chat'];
  log.info({ runtimeModel }, 'runtime-overrides: chat model override applied');
}
if (overrideModels['voice']) {
  voiceModelRef.model = overrideModels['voice'];
  log.info({ voiceModel: overrideModels['voice'] }, 'runtime-overrides: voice model override applied');
}
if (overrideModels['fast']) {
  summaryModel = overrideModels['fast'];
  cronAutoTagModel = overrideModels['fast'];
  tasksAutoTagModel = overrideModels['fast'];
  log.info({ fastModel: overrideModels['fast'] }, 'runtime-overrides: fast model override applied');
}
if (overrideModels['summary']) {
  summaryModel = overrideModels['summary'];
  log.info({ summaryModel }, 'runtime-overrides: summary model override applied');
}
if (overrideModels['cron']) {
  cronAutoTagModel = overrideModels['cron'];
  log.info({ cronAutoTagModel }, 'runtime-overrides: cron model override applied');
}
if (overrides.voiceRuntime) {
  const voiceRt = runtimeRegistry.get(overrides.voiceRuntime);
  if (voiceRt) {
    voiceRuntimeRef.runtime = voiceRt;
    voiceRuntimeRef.name = overrides.voiceRuntime;
    voiceModelRef.runtime = voiceRt;
    voiceModelRef.runtimeName = overrides.voiceRuntime;
    if (!overrideModels['voice']) {
      // Re-resolve the voice model against the new runtime's tier mapping so tier names
      // like 'capable' or 'fast' map to the correct concrete model for this adapter.
      const reResolved = resolveModel(cfg.voiceModel, voiceRt.id);
      voiceModelRef.model = reResolved || voiceRt.defaultModel || voiceModelRef.model;
    }
    log.info({ voiceRuntime: overrides.voiceRuntime, voiceModel: voiceModelRef.model }, 'runtime-overrides: voice runtime override applied');
  } else {
    log.warn(
      { voiceRuntime: overrides.voiceRuntime, availableRuntimes: runtimeRegistry.list() },
      'runtime-overrides: voiceRuntime is not a registered runtime; ignoring',
    );
  }
}
if (overrides.ttsVoice) {
  log.info({ ttsVoice: overrides.ttsVoice }, 'runtime-overrides: ttsVoice override will be applied');
}

// Track which roles have active file-backed overrides (used by !models show).
const overrideSources: Partial<Record<ModelRole, boolean>> = {};
for (const role of Object.keys(overrideModels) as ModelRole[]) {
  overrideSources[role] = true;
}

// Persist callback: updates the overrides file for all model roles.
const persistOverride = (role: ModelRole, model: string): void => {
  if (!currentOverridesState.models) currentOverridesState.models = {};
  currentOverridesState.models[role] = model;
  saveOverrides(overridesPath, currentOverridesState).catch((err) =>
    log.warn({ err, role, model }, 'runtime-overrides: save failed'),
  );
};

// Clear callback: removes one or all role overrides from the file.
// When clearing all roles, ttsVoice is preserved so !voice set survives !models reset.
const clearOverride = (role?: ModelRole): void => {
  if (!role) {
    currentOverridesState = currentOverridesState.ttsVoice
      ? { ttsVoice: currentOverridesState.ttsVoice }
      : {};
    saveOverrides(overridesPath, currentOverridesState).catch((err) =>
      log.warn({ err }, 'runtime-overrides: clear failed'),
    );
  } else {
    if (currentOverridesState.models) {
      delete currentOverridesState.models[role];
      if (Object.keys(currentOverridesState.models).length === 0) {
        delete currentOverridesState.models;
      }
    }
    saveOverrides(overridesPath, currentOverridesState).catch((err) =>
      log.warn({ err, role }, 'runtime-overrides: clear role failed'),
    );
  }
};

log.info(
  { primaryRuntime: primaryRuntimeName, runtimeId: runtime.id, model: runtimeModel, fastRuntimeId: fastRuntime.id },
  'runtime:primary selected',
);

logRuntimeDebugConfig({
  enabled: cfg.debugRuntime,
  log,
  env: process.env,
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
});

const { drafterRuntime, auditorRuntime } = resolveForgeRuntimes({
  primaryRuntimeName,
  primaryRuntime: limitedRuntime,
  forgeDrafterRuntime: cfg.forgeDrafterRuntime,
  forgeAuditorRuntime: cfg.forgeAuditorRuntime,
  runtimeRegistry,
  log,
});

const activeProviders = collectActiveProviders({
  primaryRuntimeId: runtime.id,
  fastRuntime,
  forgeCommandsEnabled,
  drafterRuntime,
  auditorRuntime,
});

const sessionManager = new SessionManager(resolveSessionStorePath(dataDir, projectRoot));

// Mutable ref updated by the message handler; read by the !status command.
const statusLastMessageAt: { current: number | null } = { current: null };

const botParams = {
  token,
  allowUserIds,
  allowBotIds,
  botMessageMemoryWriteEnabled,
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
  fastRuntime,
  sessionManager,
  workspaceCwd,
  projectCwd: projectRoot,
  updateRestartCmd: process.env.DC_RESTART_CMD,
  serviceName: cfg.serviceName,
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
  discordActionsImagegen: cfg.discordActionsImagegen,
  discordActionsVoice: cfg.discordActionsVoice && cfg.voiceEnabled,
  discordActionsSpawn: cfg.discordActionsSpawn,
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
  imagegenCtx: undefined as ImagegenContext | undefined,
  spawnCtx: undefined as SpawnContext | undefined,
  voiceCtx: undefined as import('./discord/actions-voice.js').VoiceContext | undefined,
  voiceStatusCtx: undefined as import('./discord/actions-voice.js').VoiceContext | undefined,
  setTtsVoice: undefined as ((voice: string) => Promise<number>) | undefined,
  getTtsVoice: undefined as (() => string | undefined) | undefined,
  configCtx: undefined as import('./discord/actions-config.js').ConfigContext | undefined,
  deferOpts: undefined as ConfigureDeferredSchedulerOpts | undefined,
  messageHistoryBudget,
  summaryEnabled,
  summaryModel,
  summaryMaxChars,
  summaryEveryNTurns,
  summaryMaxTokens,
  summaryTargetRatio,
  summaryDataDir,
  summaryArchiveDir,
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
  planForgeHeartbeatIntervalMs,
  forgeCommandsEnabled,
  forgeMaxAuditRounds,
  forgeDrafterModel,
  forgeAuditorModel,
  forgeTimeoutMs,
  forgeProgressThrottleMs,
  forgeAutoImplement,
  completionNotifyEnabled,
  completionNotifyThresholdMs,
  longRunWatchdog: messageCoordinatorWatchdog,
  longRunStillRunningDelayMs,
  drafterRuntime,
  auditorRuntime,
  summaryToDurableEnabled,
  durableSupersessionShadow,
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
  streamPreviewMode,
  debugStreamPreviewLines,
  streamStallWarningMs,
  actionFollowupDepth,
  reactionHandlerEnabled,
  reactionRemoveHandlerEnabled,
  reactionMaxAgeMs,
  healthCommandsEnabled,
  healthVerboseAllowlist,
  voiceEnabled: cfg.voiceEnabled,
  voiceAutoJoin: cfg.voiceAutoJoin,
  voiceModelCtx: voiceModelRef,
  voiceSttProvider: cfg.voiceSttProvider,
  voiceTtsProvider: cfg.voiceTtsProvider,
  voiceHomeChannel: cfg.voiceHomeChannel,
  deepgramApiKey: cfg.deepgramApiKey,
  deepgramSttModel: cfg.deepgramSttModel,
  deepgramTtsVoice: cfg.deepgramTtsVoice,
  cartesiaApiKey: cfg.cartesiaApiKey,
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
  statusCommandContext: {
    startedAt: bootStartMs,
    lastMessageAt: statusLastMessageAt,
    discordToken: token,
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    openrouterApiKey: cfg.openrouterApiKey,
    openrouterBaseUrl: cfg.openrouterBaseUrl,
    paFilePaths: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md'].map((f) => ({
      label: f,
      path: path.join(workspaceCwd, f),
    })),
    apiCheckTimeoutMs: 5000,
    workspaceCwd,
    summaryDataDir,
    summaryArchiveDir,
    durableDataDir,
    durableMemoryEnabled,
    cronScheduler: null as CronScheduler | null,
    sharedTaskStore,
    activeProviders,
  },
};

// Apply forge-drafter and forge-auditor overrides — their source vars are const so botParams must be patched here.
if (overrideModels['forge-drafter']) {
  botParams.forgeDrafterModel = overrideModels['forge-drafter'];
  log.info({ forgeDrafterModel: overrideModels['forge-drafter'] }, 'runtime-overrides: forge-drafter model override applied');
}
if (overrideModels['forge-auditor']) {
  botParams.forgeAuditorModel = overrideModels['forge-auditor'];
  log.info({ forgeAuditorModel: overrideModels['forge-auditor'] }, 'runtime-overrides: forge-auditor model override applied');
}

let deferOpts: ConfigureDeferredSchedulerOpts | undefined;
if (discordActionsEnabled && cfg.discordActionsDefer) {
  deferOpts = {
    maxDelaySeconds: cfg.deferMaxDelaySeconds,
    maxConcurrent: cfg.deferMaxConcurrent,
    deferMaxDepth: cfg.deferMaxDepth,
    state: botParams,
    runtime,
    runtimeTools,
    runtimeTimeoutMs,
    workspaceCwd,
    discordChannelContext,
    appendSystemPrompt,
    useGroupDirCwd,
    botDisplayName,
    log,
  };
  const deferScheduler = configureDeferredScheduler(deferOpts);
  botParams.deferScheduler = deferScheduler;
  deferSchedulerRef = deferScheduler;
  botParams.deferOpts = deferOpts;
}

let client!: Awaited<ReturnType<typeof startDiscordBot>>['client'], status!: Awaited<ReturnType<typeof startDiscordBot>>['status'], system!: Awaited<ReturnType<typeof startDiscordBot>>['system'];
try {
  ({ client, status, system } = await startDiscordBot(botParams));
} catch (err) {
  const tokenResult = validateDiscordToken(token);
  log.error(
    { tokenFormat: tokenResult, error: err instanceof Error ? err.message : String(err) },
    'Discord login failed',
  );
  process.exit(1);
}
botStatus = status;
longRunWatchdogClientRef = client;
if (deferOpts) deferOpts.status = botStatus;

if (longRunWatchdog) {
  try {
    const sweepResult = await longRunWatchdog.startupSweep();
    if (sweepResult.interruptedRuns > 0 || sweepResult.finalRetried > 0 || sweepResult.finalFailed > 0) {
      log.info(sweepResult, 'long-run-watchdog: startup sweep complete');
    }
  } catch (err) {
    log.warn({ err }, 'long-run-watchdog: startup sweep failed');
  }
}

const { credentialCheckReport, credentialReport } = await runPostConnectStartupChecks({
  system,
  guildId,
  scaffoldStatePath,
  client,
  pidLockDir,
  sharedTaskStore,
  token: cfg.token,
  openaiApiKey: cfg.openaiApiKey,
  openaiBaseUrl: cfg.openaiBaseUrl,
  openrouterApiKey: cfg.openrouterApiKey,
  openrouterBaseUrl: cfg.openrouterBaseUrl,
  workspaceCwd,
  statusChannel,
  activeProviders,
  log,
});

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
    runtime: fastRuntime,
    resolveModel,
    metrics: globalMetrics,
    statusPoster: botStatus ?? undefined,
    hasInFlightForChannel: (channelId: string) =>
      hasInFlightForChannel(channelId) || isRunActiveInChannel(channelId),
    log,
    systemTasksForumId: system?.tasksForumId,
    store: sharedTaskStore,
  });
  taskCtx = tasksResult.taskCtx;
}

if (taskCtx) {
  const activeTaskCtx = taskCtx;
  // Attach status poster now that the bot is connected (may not have been available during pre-flight).
  if (!activeTaskCtx.statusPoster && botStatus) {
    activeTaskCtx.statusPoster = botStatus;
  }
  botParams.taskCtx = activeTaskCtx;
  botParams.discordActionsTasks = discordActionsTasks && tasksEnabled;
  botParams.healthConfigSnapshot.tasksActive = true;

  // Wire coordinator + sync triggers + startup sync
  const resolvedGuildId = guildId || system?.guildId || '';
  const guild = resolvedGuildId ? client.guilds.cache.get(resolvedGuildId) : undefined;
  if (guild) {
    // Create forum count sync for tasks.
    const tasksForumChannel = await resolveTasksForum(guild, activeTaskCtx.forumId);
    if (tasksForumChannel) {
      taskForumCountSync = new ForumCountSync(
        client,
        tasksForumChannel.id,
        async () => {
          return activeTaskCtx.store.list({ status: 'all' }).filter((b) => b.status !== 'closed').length;
        },
        log,
      );
      activeTaskCtx.forumCountSync = taskForumCountSync;
      taskForumCountSync.requestUpdate();
    }

    // Install forum guard before any async operations that touch the forum.
    initTasksForumGuard({
      client,
      forumId: activeTaskCtx.forumId,
      log,
      store: activeTaskCtx.store,
      tagMap: activeTaskCtx.tagMap,
    });

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
        await reloadTagMapInPlace(tasksTagMapPath, activeTaskCtx.tagMap);
      } catch (err) {
        log.warn({ err }, 'tasks:tag map reload failed');
      }
    }

    // Wire coordinator + sync triggers + startup sync (now uses correct tag map).
    await wireTaskSync(activeTaskCtx, { client, guild });
  } else {
    log.warn({ resolvedGuildId }, 'tasks:sync wiring skipped; guild not in cache');
  }

  log.info(
    {
      tasksCwd,
      tasksForum: activeTaskCtx.forumId,
      tagCount: Object.keys(activeTaskCtx.tagMap).length,
      autoTag: tasksAutoTag,
    },
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
      orchestratorFactory: (overrides) =>
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
          ...(overrides ?? {}),
        }),
      plansDir,
      workspaceCwd,
      taskStore: effectiveTaskStore,
      progressThrottleMs: forgeProgressThrottleMs,
      toolAwareStreaming,
      onProgress: async (msg) => {
        // Action-initiated forges log progress rather than posting to a channel.
        log.info({ msg }, 'forge:action:progress');
      },
      longRunWatchdog: longRunWatchdog ?? undefined,
      longRunStillRunningDelayMs,
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
      onTaskClosed: (taskId: string) => {
        try {
          botParams.taskCtx?.syncCoordinator?.sync()?.catch((err: unknown) => {
            log.warn({ err, taskId }, 'plan:onTaskClosed sync failed');
          });
        } catch (err) {
          log.warn({ err, taskId }, 'plan:onTaskClosed sync error');
        }
      },
      longRunWatchdog: longRunWatchdog ?? undefined,
      longRunStillRunningDelayMs,
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
      runtimeRegistry,
      runtimeName: primaryRuntimeName,
      voiceRuntimeName: voiceModelRef.runtimeName,
      // Env-default models — used by !models reset to revert live state.
      envDefaults: {
        chat: resolveModel(cfg.runtimeModel, runtime.id),
        fast: resolveModel(cfg.summaryModel, fastRuntime.id),
        summary: resolveModel(cfg.summaryModel, fastRuntime.id),
        'forge-drafter': cfg.forgeDrafterModel ?? '',
        'forge-auditor': cfg.forgeAuditorModel ?? '',
        cron: resolveModel(cfg.cronAutoTagModel, fastRuntime.id),
        'cron-exec': cronExecModel,
        voice: resolveModel(cfg.voiceModel, runtime.id),
      },
      overrideSources,
      persistOverride,
      clearOverride,
      persistVoiceRuntime: (runtimeName: string): void => {
        currentOverridesState.voiceRuntime = runtimeName;
        saveOverrides(overridesPath, currentOverridesState).catch((err) =>
          log.warn({ err, runtimeName }, 'runtime-overrides: voice runtime save failed'),
        );
      },
      clearVoiceRuntime: (): void => {
        delete currentOverridesState.voiceRuntime;
        saveOverrides(overridesPath, currentOverridesState).catch((err) =>
          log.warn({ err }, 'runtime-overrides: voice runtime clear failed'),
        );
      },
    };
    log.info('config:action context initialized');
  }

  if (cfg.discordActionsImagegen && (cfg.openaiApiKey || cfg.imagegenGeminiApiKey)) {
    botParams.imagegenCtx = {
      apiKey: cfg.openaiApiKey,
      baseUrl: cfg.openaiBaseUrl,
      geminiApiKey: cfg.imagegenGeminiApiKey,
      defaultModel: cfg.imagegenDefaultModel,
    };
    log.info('imagegen:action context initialized');
  }

  if (discordActionsEnabled && cfg.discordActionsSpawn) {
    const spawnLimiter = createConcurrencyLimiter(cfg.spawnMaxConcurrent);
    botParams.spawnCtx = {
      runtime: limitedRuntime,
      model: runtimeModel,
      runtimeTools,
      workspaceCwd,
      discordChannelContext,
      useGroupDirCwd,
      appendSystemPrompt,
      log,
      maxConcurrent: cfg.spawnMaxConcurrent,
      limiter: spawnLimiter ?? undefined,
    };
    log.info({ maxConcurrent: cfg.spawnMaxConcurrent }, 'spawn:action context initialized');
  }

  if (cfg.voiceEnabled) {
    const voiceLogChannelRef = cfg.voiceLogChannel ?? system?.voiceLogChannelId;
    const transcriptMirror = voiceLogChannelRef
      ? await TranscriptMirror.resolve(client, voiceLogChannelRef, log)
      : undefined;

    // Pick a representative userId for durable memory (personal bot — typically one user).
    const voiceDurableUserId = [...allowUserIds][0] as string | undefined;

    // Resolve voice home channel ID for action context.
    // If it's already a snowflake, use directly; otherwise resolve by name from guild cache.
    const voiceGuild = cfg.guildId ? client.guilds.cache.get(cfg.guildId) : undefined;
    let resolvedVoiceChannelId: string | undefined;
    if (cfg.voiceHomeChannel && voiceGuild) {
      if (voiceGuild.channels.cache.has(cfg.voiceHomeChannel)) {
        resolvedVoiceChannelId = cfg.voiceHomeChannel;
      } else {
        const byName = voiceGuild.channels.cache.find(c => c.name === cfg.voiceHomeChannel);
        resolvedVoiceChannelId = byName?.id;
      }
    }
    const voiceChannelContext = (voiceGuild && resolvedVoiceChannelId)
      ? resolveDiscordChannelContext({
          ctx: discordChannelContext,
          isDm: false,
          channelId: resolvedVoiceChannelId,
          threadParentId: null,
        })
      : undefined;

    // Build voice action flags — intersect voice-specific allowlist with env config.
    const voiceActionFlags = buildVoiceActionFlags({
      discordActionsMessaging,
      discordActionsTasks,
      tasksEnabled,
      taskCtxAvailable: Boolean(botParams.taskCtx),
      discordActionsMemory,
      durableMemoryEnabled,
      discordActionsVoice: cfg.discordActionsVoice && cfg.voiceEnabled,
    });
    const voiceActionsEnabled = discordActionsEnabled
      && voiceGuild != null
      && resolvedVoiceChannelId != null
      && Object.values(voiceActionFlags).some(v => v);

    const voiceActionFollowupDepth = 1;

    const voiceInvokeAi = async (text: string, signal: AbortSignal, history?: string): Promise<string> => {
      // Resolve model and runtime at invoke time so tier names (fast/capable) always resolve
      // correctly even after runtime mutation via !models set voice.
      const voiceRuntime = resolveVoiceRuntime(voiceModelRef, runtimeRegistry, limitedRuntime);
      const resolvedVoiceModel = resolveModel(voiceModelRef.model, voiceRuntime.id);

      // Build a lean voice prompt using identity extraction (~1KB) instead of
      // the full PA file set (~50KB). AGENTS.md, TOOLS.md, and .context/pa.md
      // are irrelevant to spoken-word interactions.
      const identity = await loadVoiceIdentity(workspaceCwd);

      const durableSection = voiceDurableUserId
        ? await buildDurableMemorySection({
            enabled: durableMemoryEnabled,
            durableDataDir,
            userId: voiceDurableUserId,
            durableInjectMaxChars,
            query: text,
            log,
          })
        : '';

      let actionSchemaSelection:
        | {
          includedCategories: string[];
          tierBuckets: { core: string[]; channelContextual: string[]; keywordTriggered: string[] };
          keywordHits: string[];
        }
        | null = null;
      const actionsSection = (() => {
        if (!voiceActionsEnabled) return '';
        const actionSelection = buildTieredDiscordActionsPromptSection(
          voiceActionFlags,
          botDisplayName,
          {
            channelName: voiceChannelContext?.channelName ?? cfg.voiceHomeChannel,
            channelContextPath: voiceChannelContext?.contextPath,
            isThread: false,
            userText: text,
          },
        );
        actionSchemaSelection = {
          includedCategories: actionSelection.includedCategories,
          tierBuckets: actionSelection.tierBuckets,
          keywordHits: actionSelection.keywordHits,
        };
        return actionSelection.prompt;
      })();

      const userTextWithHistory = history
        ? `Conversation history (recent voice exchanges):\n${history}\n\nCurrent user message:\n${text}`
        : text;

      const promptParts = {
        identity,
        durableMemory: durableSection,
        voiceSystemPrompt: cfg.voiceSystemPrompt,
        actionsSection,
        userText: userTextWithHistory,
      };
      const prompt = buildVoicePrompt(promptParts);
      const promptSectionEstimates = buildVoicePromptSectionEstimates(promptParts);
      log.info(
        {
          flow: 'voice',
          channelId: resolvedVoiceChannelId,
          sections: promptSectionEstimates.sections,
          totalChars: promptSectionEstimates.totalChars,
          totalEstTokens: promptSectionEstimates.totalEstTokens,
          includedCategories: actionSchemaSelection?.includedCategories ?? [],
          tierBuckets: actionSchemaSelection?.tierBuckets ?? { core: [], channelContextual: [], keywordTriggered: [] },
          keywordHits: actionSchemaSelection?.keywordHits ?? [],
        },
        'voice:prompt:section-estimates',
      );

      let currentPrompt = prompt;
      let responseText = '';

      for (let followUpDepth = 0; followUpDepth <= voiceActionFollowupDepth; followUpDepth++) {
        let result = '';
        let invokeHadError = false;
        try {
          for await (const evt of voiceRuntime.invoke({
            prompt: currentPrompt,
            model: resolvedVoiceModel,
            cwd: workspaceCwd,
            tools: [],
            signal: AbortSignal.any([signal, AbortSignal.timeout(runtimeTimeoutMs)]),
          })) {
            if (evt.type === 'text_delta') result += evt.text;
            if (evt.type === 'error') invokeHadError = true;
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') {
            if (signal.aborted) throw err; // Caller cancelled — propagate immediately
            log.warn('voice-responder: AI invocation timed out');
            invokeHadError = true;
          } else {
            throw err;
          }
        }

        // Action parsing and execution.
        if (voiceActionsEnabled && !invokeHadError && voiceGuild && resolvedVoiceChannelId) {
          const parsed = parseDiscordActions(result, voiceActionFlags);

          // sendFile deny-filter: voice is bot-originated (no user-attached file context).
          const actions = parsed.actions.filter(a => a.type !== 'sendFile');

          if (actions.length > 0) {
            const actCtx: ActionContext = {
              guild: voiceGuild,
              client,
              channelId: resolvedVoiceChannelId,
              messageId: '', // Empty — mirrors cron executor pattern; prevents sendMessage same-channel suppression.
              transport: new DiscordTransportClient(voiceGuild, client),
              confirmation: {
                mode: 'automated' as const,
              },
            };

            // Build memory context with real user ID for voice.
            const voiceMemoryCtx = botParams.memoryCtx && voiceDurableUserId ? {
              ...botParams.memoryCtx,
              userId: voiceDurableUserId,
              channelId: resolvedVoiceChannelId,
              guildId: cfg.guildId,
            } : undefined;

            const subs: SubsystemContexts = {
              taskCtx: botParams.taskCtx,
              memoryCtx: voiceMemoryCtx,
              voiceCtx: botParams.voiceCtx,
            };

            const actionResults = await executeDiscordActions(
              actions as Parameters<typeof executeDiscordActions>[0],
              actCtx,
              log,
              subs,
            );

            responseText = parsed.cleanText;

            // Follow-up check.
            if (followUpDepth < voiceActionFollowupDepth && shouldTriggerFollowUp(actions, actionResults)) {
              const followUpLines = buildAllResultLines(actionResults);
              const sanitizedFollowUp = sanitizeForVoice(followUpLines.join('\n'));
              currentPrompt = buildVoiceFollowUpPrompt({
                originalText: text,
                actionResults: sanitizedFollowUp,
              });
              continue;
            }

            break;
          }

          // No actions parsed — use clean text and exit loop.
          responseText = parsed.cleanText;
          break;
        }

        // No actions enabled or error occurred — return raw text.
        responseText = result;
        break;
      }

      const guarded = sanitizeVoiceReplyForSpeech(responseText);
      if (guarded.removedToolLines > 0 || guarded.trimmedDanglingTail) {
        log.warn(
          {
            removedToolLines: guarded.removedToolLines,
            trimmedDanglingTail: guarded.trimmedDanglingTail,
          },
          'voice: reply guarded before TTS',
        );
      }

      return guarded.text;
    };

    // Backfill callback: on voice-channel join, fetch recent voice-log messages
    // and parse the TranscriptMirror format into user/assistant turn pairs so the
    // ConversationBuffer starts with prior context instead of empty.
    let backfill: (() => Promise<Turn[]>) | undefined;
    if (voiceLogChannelRef) {
      const logRef = voiceLogChannelRef;
      backfill = async () => {
        try {
          // Resolve the voice-log channel by ID first, then by name
          let resolved = client.channels.cache.get(logRef)
            ?? await client.channels.fetch(logRef).catch(() => null)
            ?? undefined;
          if (!resolved) {
            for (const g of client.guilds.cache.values()) {
              const ch = g.channels.cache.find(c => c.isTextBased() && c.name === logRef);
              if (ch) { resolved = ch; break; }
            }
          }
          if (!resolved?.isTextBased() || resolved.isDMBased() || !('messages' in resolved)) return [];

          const messages = await resolved.messages.fetch({ limit: 50 });
          const chronological = [...messages.values()].reverse();

          const userRe = /^\*\*(.+?)\*\* \(voice\): ([\s\S]+)/;
          const botRe = /^\*\*(.+?)\*\* \(voice reply\): ([\s\S]+)/;
          const turns: Turn[] = [];
          let pendingUser: string | null = null;

          for (const msg of chronological) {
            const um = msg.content.match(userRe);
            const bm = msg.content.match(botRe);
            if (um) {
              pendingUser = um[2].trim();
            } else if (bm && pendingUser !== null) {
              turns.push({ user: pendingUser, assistant: bm[2].trim() });
              pendingUser = null;
            }
          }

          return turns;
        } catch (err) {
          log.warn({ err }, 'voice:backfill: failed to fetch conversation history');
          return [];
        }
      };
    }

    audioPipeline = new AudioPipelineManager({
      log,
      voiceConfig: {
        enabled: cfg.voiceEnabled,
        sttProvider: cfg.voiceSttProvider,
        ttsProvider: cfg.voiceTtsProvider,
        homeChannel: cfg.voiceHomeChannel,
        deepgramApiKey: cfg.deepgramApiKey,
        deepgramSttModel: cfg.deepgramSttModel,
        deepgramTtsVoice: overrides.ttsVoice ?? cfg.deepgramTtsVoice,
        deepgramTtsSpeed: cfg.deepgramTtsSpeed,
        cartesiaApiKey: cfg.cartesiaApiKey,
        openaiApiKey: cfg.openaiApiKey,
      },
      allowedUserIds: allowUserIds,
      createDecoder: opusDecoderFactory,
      invokeAi: voiceInvokeAi,
      runtime: voiceRuntimeRef.runtime.id,
      runtimeModel: voiceModelRef.model,
      runtimeCwd: workspaceCwd,
      runtimeTimeoutMs,
      transcriptMirror,
      botDisplayName,
      backfill,
      onTranscription: (guildId, result) => {
        if (result.isFinal && result.text.trim()) {
          log.info({ guildId, text: result.text, confidence: result.confidence }, 'voice:transcription');
        }
      },
    });

    voiceManager = new VoiceConnectionManager(log, {
      onReady: (guildId, connection) => {
        audioPipeline!.startPipeline(guildId, connection).catch((err) => {
          log.error({ guildId, err }, 'voice:pipeline:start failed');
        });
      },
      onDestroyed: (guildId) => {
        audioPipeline!.stopPipeline(guildId).catch((err) => {
          log.error({ guildId, err }, 'voice:pipeline:stop failed');
        });
      },
    });

    botParams.voiceStatusCtx = { voiceManager };

    botParams.setTtsVoice = async (voice: string) => {
      const count = await audioPipeline!.setTtsVoice(voice);
      botParams.deepgramTtsVoice = voice;
      currentOverridesState.ttsVoice = voice;
      saveOverrides(overridesPath, currentOverridesState).catch((err) =>
        log.warn({ err, voice }, 'runtime-overrides: ttsVoice save failed'),
      );
      return count;
    };
    botParams.getTtsVoice = () => audioPipeline!.ttsVoice;

    if (cfg.discordActionsVoice) {
      botParams.voiceCtx = { voiceManager };
      log.info('voice:action context initialized with audio pipeline');
    }

    if (cfg.voiceAutoJoin) {
      voicePresenceHandler = new VoicePresenceHandler({
        log,
        voiceManager,
        botUserId: client.user!.id,
        allowUserIds,
        guildId: cfg.guildId,
      });
      voicePresenceHandler.register(client);
      log.info('voice:presence auto-join handler registered');
    }
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

  const cronStats = await loadRunStats(cronStatsPath);

  // --- Cron record healing: remove stale stats records for deleted threads ---
  await healStaleCronRecords(cronStats, client, log);
  await healInterruptedCronRuns(cronStats, log);

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
    imagegen: Boolean(botParams.imagegenCtx), // Follows env flag (DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN + API key) — cron jobs may generate images if explicitly configured.
    voice: Boolean(botParams.voiceCtx), // Follows env flag (DISCOCLAW_DISCORD_ACTIONS_VOICE + VOICE_ENABLED) — cron jobs may use voice if configured.
    spawn: false, // Spawn is excluded from cron flows to prevent recursive agent spawning from scheduled jobs.
  };
  const cronRunControl = new CronRunControl();

  // Load cron tag map (strict, but fallback to empty on first run)
  const cronTagMap = await loadCronTagMapStrict(cronTagMapPath).catch((err) => {
    log.warn({ err, cronTagMapPath }, 'cron:tag-map strict load failed; starting with empty map');
    return {} as Record<string, string>;
  });

  const cronPendingThreadIds = new Set<string>();
  let cronExecCtx: import('./cron/executor.js').CronExecutorContext | null = null;

  cronScheduler = new CronScheduler((job) => {
    if (!cronExecCtx) {
      throw new Error('cron executor context not initialized');
    }
    return executeCronJob(job, cronExecCtx);
  }, log);

  const cronCtx: CronContext = {
    scheduler: cronScheduler,
    client,
    forumId: effectiveCronForum,
    tagMapPath: cronTagMapPath,
    tagMap: cronTagMap,
    statsStore: cronStats,
    runtime: fastRuntime,
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

  cronExecCtx = {
    client,
    runtime,
    model: runtimeModel,
    cronExecModel: cronExecModel,
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
    imagegenCtx: botParams.imagegenCtx,
    voiceCtx: botParams.voiceCtx,
    statsStore: cronStats,
    lockDir: cronLocksDir,
    runControl: cronRunControl,
    getSchedulerJob: (threadId: string) => cronScheduler!.getJob(threadId),
  };

  savedCronExecCtx = cronExecCtx;
  cronCtx.executorCtx = cronExecCtx;

  // Apply cron-exec model override now that cronExecCtx exists.
  if (overrideModels['cron-exec']) {
    cronExecCtx.cronExecModel = overrideModels['cron-exec'];
    log.info({ cronExecModel: overrideModels['cron-exec'] }, 'runtime-overrides: cron-exec model override applied');
  }

  botParams.cronCtx = cronCtx;
  botParams.statusCommandContext.cronScheduler = cronScheduler;
  botParams.discordActionsCrons = discordActionsCrons && cronEnabled;

  let cronForumResult: { forumId: string } = { forumId: '' };
  try {
    cronForumResult = await initCronForum({
      client,
      forumChannelNameOrId: effectiveCronForum,
      scheduler: cronScheduler,
      runtime: fastRuntime,
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
  const activeCronScheduler = cronScheduler;
  if (cronForumResult.forumId && activeCronScheduler) {
    cronForumCountSync = new ForumCountSync(
      client,
      cronForumResult.forumId,
      () => activeCronScheduler.listJobs().length,
      log,
    );
    cronCtx.forumCountSync = cronForumCountSync;
    cronForumCountSync.requestUpdate();
  }

  // Wire coordinator + watcher for cron tag-map hot-reload
  if (cronForumResult.forumId && activeCronScheduler) {
    const cronSyncCoordinator = new CronSyncCoordinator({
      client,
      forumId: cronForumResult.forumId,
      scheduler: activeCronScheduler,
      statsStore: cronStats,
      runtime: fastRuntime,
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
      const forumIdForTagBootstrap = resolveCronTagBootstrapForumId({
        resolvedForumId: cronForumResult.forumId,
        configuredForumRef: effectiveCronForum,
      });
      try {
        if (forumIdForTagBootstrap) {
          await ensureForumTags(guild, forumIdForTagBootstrap, cronTagMapPath, { log });
        } else {
          log.warn(
            { effectiveCronForum },
            'cron:forum tag bootstrap skipped; resolved forum ID unavailable',
          );
        }
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
  log.warn('DISCOCLAW_CRON_ENABLED=1 but no automations forum was resolved (set DISCORD_GUILD_ID or DISCOCLAW_CRON_FORUM); cron subsystem disabled');
}

// --- Wire spawn action flags + subsystems (late-bind after all contexts are initialized) ---
if (botParams.spawnCtx) {
  botParams.spawnCtx.actionFlags = {
    channels: discordActionsChannels,
    messaging: discordActionsMessaging,
    guild: discordActionsGuild,
    moderation: discordActionsModeration,
    polls: discordActionsPolls,
    tasks: Boolean(botParams.discordActionsTasks),
    crons: Boolean(botParams.discordActionsCrons),
    botProfile: Boolean(discordActionsBotProfile),
    forge: Boolean(botParams.discordActionsForge),
    plan: Boolean(botParams.discordActionsPlan),
    memory: false, // No user identity in spawn context.
    config: false, // Spawned agents should not change bot configuration.
    defer: false, // Spawned agents are fire-and-forget — no deferred scheduling.
    imagegen: Boolean(botParams.discordActionsImagegen),
    voice: Boolean(botParams.discordActionsVoice),
    spawn: false, // Prevent recursive spawn (also enforced by depth check).
  };
  botParams.spawnCtx.deferScheduler = botParams.deferScheduler;
  botParams.spawnCtx.subsystems = {
    taskCtx: botParams.taskCtx,
    cronCtx: botParams.cronCtx,
    forgeCtx: botParams.forgeCtx,
    planCtx: botParams.planCtx,
    configCtx: botParams.configCtx,
    imagegenCtx: botParams.imagegenCtx,
    voiceCtx: botParams.voiceCtx,
  };
  log.info('spawn:action flags and subsystems wired');
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

if (reactionHandlerEnabled) log.info({ reactionMaxAgeHours }, 'reaction:handler enabled');
if (reactionRemoveHandlerEnabled) log.info({ reactionMaxAgeHours }, 'reaction-remove:handler enabled');

log.info('Discord bot started');

const actionCategoriesEnabled = buildActionCategoriesEnabled({
  discordActionsChannels,
  discordActionsMessaging,
  discordActionsGuild,
  discordActionsModeration,
  discordActionsPolls,
  discordActionsTasks,
  tasksEnabled,
  discordActionsCrons,
  cronEnabled,
  discordActionsBotProfile,
  discordActionsForge,
  forgeCommandsEnabled,
  discordActionsPlan,
  planCommandsEnabled,
  discordActionsMemory,
  durableMemoryEnabled,
  discordActionsImagegen: cfg.discordActionsImagegen,
  discordActionsVoice: cfg.discordActionsVoice,
  voiceEnabled: cfg.voiceEnabled,
});
const npmLatestVersion = await npmLatestVersionPromise;
publishBootReport({
  botStatus,
  startupCtx,
  tasksEnabled,
  forumResolved: Boolean(taskCtx?.forumId),
  cronsEnabled: Boolean(cronEnabled && botParams.cronCtx),
  cronJobCount: cronScheduler?.listJobs().length,
  memoryEpisodicOn: summaryEnabled,
  memorySemanticOn: durableMemoryEnabled,
  memoryWorkingOn: shortTermMemoryEnabled,
  actionCategoriesEnabled,
  configWarnings: parsedConfig.warnings.length,
  permProbe,
  credentialReport,
  credentialCheckReport,
  runtimeModel,
  bootDurationMs: Date.now() - bootStartMs,
  buildVersion: gitHash ?? undefined,
  npmVersion,
  npmLatestVersion,
  log,
});
