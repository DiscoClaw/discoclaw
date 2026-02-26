import path from 'node:path';
import { parseAllowBotIds, parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';

export const KNOWN_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
export const DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS = 1800;
export const DEFAULT_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT = 5;

type ParseResult = {
  config: DiscoclawConfig;
  warnings: string[];
  infos: string[];
};

export type DiscoclawConfig = {
  token: string;
  allowUserIds: Set<string>;
  allowBotIds: Set<string>;
  botMessageMemoryWriteEnabled: boolean;
  allowChannelIds: Set<string>;
  restrictChannelIds: boolean;
  primaryRuntime: string;

  runtimeModel: string;
  runtimeTools: string[];
  runtimeTimeoutMs: number;

  dataDir?: string;
  contentDirOverride?: string;
  requireChannelContext: boolean;
  autoIndexChannelContext: boolean;
  autoJoinThreads: boolean;
  useRuntimeSessions: boolean;

  discordActionsEnabled: boolean;
  discordActionsChannels: boolean;
  discordActionsMessaging: boolean;
  discordActionsGuild: boolean;
  discordActionsModeration: boolean;
  discordActionsPolls: boolean;
  discordActionsTasks: boolean;
  discordActionsCrons: boolean;
  discordActionsBotProfile: boolean;
  discordActionsForge: boolean;
  discordActionsPlan: boolean;
  discordActionsMemory: boolean;
  discordActionsDefer: boolean;
  discordActionsImagegen: boolean;

  deferMaxDelaySeconds: number;
  deferMaxConcurrent: number;

  messageHistoryBudget: number;
  summaryEnabled: boolean;
  summaryModel: string;
  summaryMaxChars: number;
  summaryEveryNTurns: number;
  summaryDataDirOverride?: string;
  durableMemoryEnabled: boolean;
  durableDataDirOverride?: string;
  durableInjectMaxChars: number;
  durableMaxItems: number;
  memoryCommandsEnabled: boolean;
  planCommandsEnabled: boolean;
  planPhasesEnabled: boolean;
  planPhaseMaxContextFiles: number;
  planPhaseTimeoutMs: number;
  planPhaseMaxAuditFixAttempts: number;
  forgeCommandsEnabled: boolean;
  forgeMaxAuditRounds: number;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  forgeTimeoutMs: number;
  forgeProgressThrottleMs: number;
  forgeAutoImplement: boolean;

  completionNotifyEnabled: boolean;
  completionNotifyThresholdMs: number;

  // OpenAI-compat adapter config
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel: string;
  openaiCompatToolsEnabled: boolean;

  // Imagegen provider keys
  imagegenGeminiApiKey?: string;
  imagegenDefaultModel?: string;

  // Voice config
  voiceEnabled: boolean;
  voiceSttProvider: 'deepgram' | 'whisper';
  voiceTtsProvider: 'cartesia' | 'kokoro';
  voiceTranscriptChannel?: string;
  deepgramApiKey?: string;
  cartesiaApiKey?: string;

  forgeDrafterRuntime?: string;
  forgeAuditorRuntime?: string;

  // OpenRouter adapter config
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel: string;

  // Gemini CLI adapter config
  geminiBin: string;
  geminiModel: string;

  // Codex CLI adapter config
  codexBin: string;
  codexModel: string;
  codexDangerouslyBypassApprovalsAndSandbox: boolean;
  codexDisableSessions: boolean;
  summaryToDurableEnabled: boolean;
  shortTermMemoryEnabled: boolean;
  shortTermMaxEntries: number;
  shortTermMaxAgeHours: number;
  shortTermInjectMaxChars: number;
  shortTermDataDirOverride?: string;
  actionFollowupDepth: number;

  reactionHandlerEnabled: boolean;
  reactionRemoveHandlerEnabled: boolean;
  reactionMaxAgeHours: number;

  statusChannel?: string;
  guildId?: string;

  cronEnabled: boolean;
  cronForum?: string;
  cronModel: string;
  cronAutoTag: boolean;
  cronAutoTagModel: string;
  cronStatsDirOverride?: string;
  cronTagMapPathOverride?: string;

  workspaceCwdOverride?: string;
  groupsDirOverride?: string;
  useGroupDirCwd: boolean;

  webhookEnabled: boolean;
  webhookPort: number;
  webhookConfigPath?: string;

  tasksEnabled: boolean;
  tasksCwdOverride?: string;
  tasksForum?: string;
  tasksTagMapPathOverride?: string;
  tasksMentionUser?: string;
  tasksSidebar: boolean;
  tasksAutoTag: boolean;
  tasksAutoTagModel: string;
  tasksSyncSkipPhase5: boolean;
  tasksSyncFailureRetryEnabled: boolean;
  tasksSyncFailureRetryDelayMs: number;
  tasksSyncDeferredRetryDelayMs: number;
  tasksPrefix: string;

  runtimeFallbackModel?: string;
  runtimeMaxBudgetUsd?: number;
  appendSystemPrompt?: string;

  claudeBin: string;
  dangerouslySkipPermissions: boolean;
  outputFormat: 'text' | 'stream-json';
  echoStdio: boolean;
  verbose: boolean;
  claudeDebugFile?: string;
  strictMcpConfig: boolean;
  sessionScanning: boolean;
  toolAwareStreaming: boolean;
  multiTurn: boolean;
  multiTurnHangTimeoutMs: number;
  multiTurnIdleTimeoutMs: number;
  multiTurnMaxProcesses: number;
  streamStallTimeoutMs: number;
  progressStallTimeoutMs: number;
  streamStallWarningMs: number;
  maxConcurrentInvocations: number;
  debugRuntime: boolean;

  healthCommandsEnabled: boolean;
  healthVerboseAllowlist: Set<string>;

  botDisplayName?: string;
  botStatus?: 'online' | 'idle' | 'dnd' | 'invisible';
  botActivity?: string;
  botActivityType?: 'Playing' | 'Listening' | 'Watching' | 'Competing' | 'Custom';
  botAvatar?: string;

  serviceName: string;
};

function parseBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`${name} must be "0"/"1" or "true"/"false", got "${raw}"`);
}

function parseNonNegativeNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function parsePositiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

const DEFAULT_THIRTY_MINUTES_MS = 1_800_000;

function parseNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const n = parseNonNegativeNumber(env, name, defaultValue);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${n}"`);
  }
  return n;
}

function parsePositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const n = parsePositiveNumber(env, name, defaultValue);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${n}"`);
  }
  return n;
}

function parseTrimmedString(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function parseRuntimeName(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const raw = parseTrimmedString(env, name);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'claude_code') return 'claude';
  return normalized;
}

function parseEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  validValues: readonly T[],
  defaultValue?: T,
): T | undefined {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  const match = validValues.find((v) => v.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`${name} must be one of ${validValues.join('|')}, got "${raw}"`);
  }
  return match;
}

function parseAvatarPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const val = parseTrimmedString(env, name);
  if (val && !val.startsWith('http://') && !val.startsWith('https://') && !val.startsWith('/')) {
    throw new Error(`${name} must be an absolute file path or URL`);
  }
  return val;
}

function parseRuntimeTools(env: NodeJS.ProcessEnv, warnings: string[]): string[] {
  const raw = parseTrimmedString(env, 'RUNTIME_TOOLS');
  if (!raw) return ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

  const tools = raw
    .split(/[,\s]+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tools.length === 0) {
    throw new Error('RUNTIME_TOOLS was set but no tools were parsed');
  }

  const unknown = tools.filter((t) => !KNOWN_TOOLS.has(t));
  if (unknown.length > 0) {
    warnings.push(
      `RUNTIME_TOOLS includes unknown tools (${unknown.join(', ')}). ` +
      'Passing through as configured for runtime compatibility.',
    );
  }

  return tools;
}

export function parseConfig(env: NodeJS.ProcessEnv): ParseResult {
  const warnings: string[] = [];
  const infos: string[] = [];

  const token = parseTrimmedString(env, 'DISCORD_TOKEN');
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN');
  }

  const allowUserIdsRaw = env.DISCORD_ALLOW_USER_IDS;
  const allowUserIds = parseAllowUserIds(allowUserIdsRaw);
  if ((allowUserIdsRaw ?? '').trim().length > 0 && allowUserIds.size === 0) {
    warnings.push('DISCORD_ALLOW_USER_IDS was set but no valid IDs were parsed: bot will respond to nobody (fail closed)');
  } else if (allowUserIds.size === 0) {
    warnings.push('DISCORD_ALLOW_USER_IDS is empty: bot will respond to nobody (fail closed)');
  }

  const allowBotIdsRaw = env.DISCORD_ALLOW_BOT_IDS;
  const allowBotIds = parseAllowBotIds(allowBotIdsRaw);
  if ((allowBotIdsRaw ?? '').trim().length > 0 && allowBotIds.size === 0) {
    warnings.push('DISCORD_ALLOW_BOT_IDS was set but no valid IDs were parsed: trusted-bot allowlist is empty');
  }
  const botMessageMemoryWriteEnabled = parseBoolean(env, 'DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE', false);

  const allowChannelIdsRaw = env.DISCORD_CHANNEL_IDS;
  const restrictChannelIds = (allowChannelIdsRaw ?? '').trim().length > 0;
  const allowChannelIds = parseAllowChannelIds(allowChannelIdsRaw);
  if (restrictChannelIds && allowChannelIds.size === 0) {
    warnings.push('DISCORD_CHANNEL_IDS was set but no valid IDs were parsed: bot will respond to no guild channels (fail closed)');
  }

  const outputFormatRaw = parseTrimmedString(env, 'CLAUDE_OUTPUT_FORMAT');
  if (outputFormatRaw && outputFormatRaw !== 'text' && outputFormatRaw !== 'stream-json') {
    throw new Error(`CLAUDE_OUTPUT_FORMAT must be "text" or "stream-json", got "${outputFormatRaw}"`);
  }
  const outputFormat: 'text' | 'stream-json' = outputFormatRaw === 'stream-json' ? 'stream-json' : 'text';

  const rawVerbose = parseBoolean(env, 'CLAUDE_VERBOSE', false);
  const effectiveVerbose = rawVerbose && outputFormat !== 'text';
  if (rawVerbose && !effectiveVerbose) {
    warnings.push(
      'CLAUDE_VERBOSE=1 ignored: incompatible with CLAUDE_OUTPUT_FORMAT=text (verbose metadata would corrupt response text). ' +
      'Set CLAUDE_OUTPUT_FORMAT=stream-json to use verbose mode.',
    );
  }

  const healthVerboseAllowlistRaw = env.DISCOCLAW_HEALTH_VERBOSE_ALLOWLIST;
  const healthVerboseAllowlist = parseAllowUserIds(healthVerboseAllowlistRaw);
  if ((healthVerboseAllowlistRaw ?? '').trim().length > 0 && healthVerboseAllowlist.size === 0) {
    warnings.push('DISCOCLAW_HEALTH_VERBOSE_ALLOWLIST was set but no valid IDs were parsed; verbose health falls back to allowlisted users');
  }

  const discordActionsEnabled = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS', true);
  const discordActionsChannels = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_CHANNELS', true);
  const discordActionsMessaging = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MESSAGING', true);
  const discordActionsGuild = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_GUILD', true);
  const discordActionsModeration = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MODERATION', false);
  const discordActionsPolls = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_POLLS', true);
  const discordActionsTasks = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_TASKS', true);
  const discordActionsCrons = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_CRONS', true);
  const discordActionsBotProfile = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE', true);
  const discordActionsForge = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_FORGE', true);
  const discordActionsPlan = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_PLAN', true);
  const discordActionsMemory = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MEMORY', true);
  const discordActionsDefer = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_DEFER', true);
  const discordActionsImagegen = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN', false);
  const deferMaxDelaySeconds = parsePositiveNumber(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS',
    DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS,
  );
  const deferMaxConcurrent = parsePositiveInt(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT',
    DEFAULT_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT,
  );

  if (!discordActionsEnabled) {
    const enabledCategories = [
      { name: 'DISCOCLAW_DISCORD_ACTIONS_CHANNELS', enabled: discordActionsChannels },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_MESSAGING', enabled: discordActionsMessaging },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_GUILD', enabled: discordActionsGuild },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_MODERATION', enabled: discordActionsModeration },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_POLLS', enabled: discordActionsPolls },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_TASKS', enabled: discordActionsTasks },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_CRONS', enabled: discordActionsCrons },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE', enabled: discordActionsBotProfile },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_FORGE', enabled: discordActionsForge },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_PLAN', enabled: discordActionsPlan },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_MEMORY', enabled: discordActionsMemory },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_DEFER', enabled: discordActionsDefer },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN', enabled: discordActionsImagegen },
    ]
      .filter((entry) => (env[entry.name] ?? '').trim().length > 0 && entry.enabled)
      .map((entry) => entry.name);
    if (enabledCategories.length > 0) {
      infos.push(`DISCOCLAW_DISCORD_ACTIONS=0; category flags are ignored: ${enabledCategories.join(', ')}`);
    }
  }

  const cronEnabled = parseBoolean(env, 'DISCOCLAW_CRON_ENABLED', true);
  let cronForum = parseTrimmedString(env, 'DISCOCLAW_CRON_FORUM');
  if (cronForum && !/^\d{8,}$/.test(cronForum)) {
    warnings.push('DISCOCLAW_CRON_FORUM is not a valid snowflake; ignoring (system bootstrap will auto-create)');
    cronForum = undefined;
  }

  const webhookEnabled = parseBoolean(env, 'DISCOCLAW_WEBHOOK_ENABLED', false);
  const webhookPort = parsePositiveInt(env, 'DISCOCLAW_WEBHOOK_PORT', 9400);
  const webhookConfigPath = parseTrimmedString(env, 'DISCOCLAW_WEBHOOK_CONFIG');

  const tasksEnabled = parseBoolean(env, 'DISCOCLAW_TASKS_ENABLED', true);
  let tasksForum = parseTrimmedString(env, 'DISCOCLAW_TASKS_FORUM');
  if (tasksForum && !/^\d{8,}$/.test(tasksForum)) {
    warnings.push('DISCOCLAW_TASKS_FORUM is not a valid snowflake; ignoring (system bootstrap will auto-create)');
    tasksForum = undefined;
  }

  const primaryRuntime = parseRuntimeName(env, 'PRIMARY_RUNTIME') ?? 'claude';
  const forgeDrafterRuntime = parseRuntimeName(env, 'FORGE_DRAFTER_RUNTIME');
  const forgeAuditorRuntime = parseRuntimeName(env, 'FORGE_AUDITOR_RUNTIME');
  const openaiApiKey = parseTrimmedString(env, 'OPENAI_API_KEY');
  const openaiBaseUrl = parseTrimmedString(env, 'OPENAI_BASE_URL');
  const openaiModel = parseTrimmedString(env, 'OPENAI_MODEL') ?? 'gpt-4o';
  const openaiCompatToolsEnabled = parseBoolean(env, 'OPENAI_COMPAT_TOOLS_ENABLED', false);
  const imagegenGeminiApiKey = parseTrimmedString(env, 'IMAGEGEN_GEMINI_API_KEY');
  const imagegenDefaultModel = parseTrimmedString(env, 'IMAGEGEN_DEFAULT_MODEL');
  if (primaryRuntime === 'openai' && !openaiApiKey) {
    warnings.push('PRIMARY_RUNTIME=openai but OPENAI_API_KEY is not set; startup will fail unless another runtime is selected.');
  }
  if (forgeDrafterRuntime === 'openai' && !openaiApiKey) {
    warnings.push('FORGE_DRAFTER_RUNTIME=openai but OPENAI_API_KEY is not set; drafter will fall back to the primary runtime.');
  }
  if (forgeAuditorRuntime === 'openai' && !openaiApiKey) {
    warnings.push('FORGE_AUDITOR_RUNTIME=openai but OPENAI_API_KEY is not set; auditor will fall back to the primary runtime.');
  }
  if (discordActionsImagegen && !openaiApiKey && !imagegenGeminiApiKey) {
    warnings.push('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1 but neither OPENAI_API_KEY nor IMAGEGEN_GEMINI_API_KEY is set; imagegen will fail at runtime.');
  }
  if (imagegenDefaultModel) {
    if (imagegenDefaultModel.startsWith('imagen-') && !imagegenGeminiApiKey) {
      warnings.push(`IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires IMAGEGEN_GEMINI_API_KEY but it is not set; imagegen will fail at runtime.`);
    } else if ((imagegenDefaultModel.startsWith('dall-e-') || imagegenDefaultModel.startsWith('gpt-image-')) && !openaiApiKey) {
      warnings.push(`IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires OPENAI_API_KEY but it is not set; imagegen will fail at runtime.`);
    }
  }

  const voiceEnabled = parseBoolean(env, 'DISCOCLAW_VOICE_ENABLED', false);
  const voiceSttProvider = parseEnum(env, 'DISCOCLAW_STT_PROVIDER', ['deepgram', 'whisper'] as const, 'deepgram')!;
  const voiceTtsProvider = parseEnum(env, 'DISCOCLAW_TTS_PROVIDER', ['cartesia', 'kokoro'] as const, 'cartesia')!;
  const voiceTranscriptChannel = parseTrimmedString(env, 'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL');
  const deepgramApiKey = parseTrimmedString(env, 'DEEPGRAM_API_KEY');
  const cartesiaApiKey = parseTrimmedString(env, 'CARTESIA_API_KEY');
  if (voiceEnabled && voiceSttProvider === 'deepgram' && !deepgramApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with STT provider "deepgram" but DEEPGRAM_API_KEY is not set; voice STT will fail at runtime.');
  }
  if (voiceEnabled && voiceTtsProvider === 'cartesia' && !cartesiaApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with TTS provider "cartesia" but CARTESIA_API_KEY is not set; voice TTS will fail at runtime.');
  }

  const openrouterApiKey = parseTrimmedString(env, 'OPENROUTER_API_KEY');
  const openrouterBaseUrl = parseTrimmedString(env, 'OPENROUTER_BASE_URL');
  const openrouterModel = parseTrimmedString(env, 'OPENROUTER_MODEL') ?? 'anthropic/claude-sonnet-4';
  if (primaryRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('PRIMARY_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; startup will fail unless another runtime is selected.');
  }
  if (forgeDrafterRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('FORGE_DRAFTER_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; drafter will fall back to the primary runtime.');
  }
  if (forgeAuditorRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('FORGE_AUDITOR_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; auditor will fall back to the primary runtime.');
  }

  const fastModel = parseTrimmedString(env, 'DISCOCLAW_FAST_MODEL') ?? 'fast';

  const tasksCwdOverride = parseTrimmedString(env, 'DISCOCLAW_TASKS_CWD');
  const tasksTagMapPathOverride = parseTrimmedString(env, 'DISCOCLAW_TASKS_TAG_MAP');
  const tasksMentionUser = parseTrimmedString(env, 'DISCOCLAW_TASKS_MENTION_USER');
  const tasksSidebar = parseBoolean(env, 'DISCOCLAW_TASKS_SIDEBAR', true);
  const tasksAutoTag = parseBoolean(env, 'DISCOCLAW_TASKS_AUTO_TAG', true);
  const tasksAutoTagModel = parseTrimmedString(env, 'DISCOCLAW_TASKS_AUTO_TAG_MODEL') ?? fastModel;
  const tasksSyncSkipPhase5 = parseBoolean(env, 'DISCOCLAW_TASKS_SYNC_SKIP_PHASE5', false);
  const tasksSyncFailureRetryEnabled = parseBoolean(env, 'DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED', true);
  const tasksSyncFailureRetryDelayMs = parsePositiveInt(env, 'DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS', 30_000);
  const tasksSyncDeferredRetryDelayMs = parsePositiveInt(env, 'DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS', 30_000);
  const tasksPrefix = parseTrimmedString(env, 'DISCOCLAW_TASKS_PREFIX') ?? 'ws';

  return {
    config: {
      token,
      allowUserIds,
      allowBotIds,
      botMessageMemoryWriteEnabled,
      allowChannelIds,
      restrictChannelIds,
      primaryRuntime,

      runtimeModel: parseTrimmedString(env, 'RUNTIME_MODEL') ?? 'capable',
      runtimeTools: parseRuntimeTools(env, warnings),
      runtimeTimeoutMs: parsePositiveNumber(env, 'RUNTIME_TIMEOUT_MS', DEFAULT_THIRTY_MINUTES_MS),
      runtimeFallbackModel: parseTrimmedString(env, 'RUNTIME_FALLBACK_MODEL'),
      runtimeMaxBudgetUsd: (() => {
        const raw = parseTrimmedString(env, 'RUNTIME_MAX_BUDGET_USD');
        if (raw == null) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`RUNTIME_MAX_BUDGET_USD must be a positive number, got "${raw}"`);
        }
        return n;
      })(),
      appendSystemPrompt: (() => {
        const raw = parseTrimmedString(env, 'CLAUDE_APPEND_SYSTEM_PROMPT');
        if (raw == null) return undefined;
        if (raw.length > 4000) {
          throw new Error(`CLAUDE_APPEND_SYSTEM_PROMPT exceeds 4000 char limit (got ${raw.length})`);
        }
        return raw;
      })(),

      dataDir: parseTrimmedString(env, 'DISCOCLAW_DATA_DIR'),
      contentDirOverride: parseTrimmedString(env, 'DISCOCLAW_CONTENT_DIR'),
      requireChannelContext: parseBoolean(env, 'DISCORD_REQUIRE_CHANNEL_CONTEXT', true),
      autoIndexChannelContext: parseBoolean(env, 'DISCORD_AUTO_INDEX_CHANNEL_CONTEXT', true),
      autoJoinThreads: parseBoolean(env, 'DISCORD_AUTO_JOIN_THREADS', true),
      useRuntimeSessions: parseBoolean(env, 'DISCOCLAW_RUNTIME_SESSIONS', true),

      discordActionsEnabled,
      discordActionsChannels,
      discordActionsMessaging,
      discordActionsGuild,
      discordActionsModeration,
      discordActionsPolls,
      discordActionsTasks,
      discordActionsCrons,
      discordActionsBotProfile,
      discordActionsForge,
      discordActionsPlan,
      discordActionsMemory,
      discordActionsDefer,
      discordActionsImagegen,

      deferMaxDelaySeconds,
      deferMaxConcurrent,

      messageHistoryBudget: parseNonNegativeInt(env, 'DISCOCLAW_MESSAGE_HISTORY_BUDGET', 3000),
      summaryEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_ENABLED', true),
      summaryModel: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_MODEL') ?? fastModel,
      summaryMaxChars: parseNonNegativeInt(env, 'DISCOCLAW_SUMMARY_MAX_CHARS', 2000),
      summaryEveryNTurns: parsePositiveInt(env, 'DISCOCLAW_SUMMARY_EVERY_N_TURNS', 5),
      summaryDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_DATA_DIR'),
      durableMemoryEnabled: parseBoolean(env, 'DISCOCLAW_DURABLE_MEMORY_ENABLED', true),
      durableDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_DURABLE_DATA_DIR'),
      durableInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_DURABLE_INJECT_MAX_CHARS', 2000),
      durableMaxItems: parsePositiveInt(env, 'DISCOCLAW_DURABLE_MAX_ITEMS', 200),
      memoryCommandsEnabled: parseBoolean(env, 'DISCOCLAW_MEMORY_COMMANDS_ENABLED', true),
      planCommandsEnabled: parseBoolean(env, 'DISCOCLAW_PLAN_COMMANDS_ENABLED', true),
      planPhasesEnabled: parseBoolean(env, 'PLAN_PHASES_ENABLED', true),
      planPhaseMaxContextFiles: parsePositiveInt(env, 'PLAN_PHASE_MAX_CONTEXT_FILES', 5),
      planPhaseTimeoutMs: parsePositiveNumber(env, 'PLAN_PHASE_TIMEOUT_MS', DEFAULT_THIRTY_MINUTES_MS),
      planPhaseMaxAuditFixAttempts: parseNonNegativeInt(env, 'PLAN_PHASE_AUDIT_FIX_MAX', 3),
      forgeCommandsEnabled: parseBoolean(env, 'DISCOCLAW_FORGE_COMMANDS_ENABLED', true),
      forgeMaxAuditRounds: parsePositiveInt(env, 'FORGE_MAX_AUDIT_ROUNDS', 5),
      forgeDrafterModel: parseTrimmedString(env, 'FORGE_DRAFTER_MODEL'),
      forgeAuditorModel: parseTrimmedString(env, 'FORGE_AUDITOR_MODEL'),
      forgeTimeoutMs: parsePositiveNumber(env, 'FORGE_TIMEOUT_MS', DEFAULT_THIRTY_MINUTES_MS),
      forgeProgressThrottleMs: parseNonNegativeInt(env, 'FORGE_PROGRESS_THROTTLE_MS', 3000),
      forgeAutoImplement: parseBoolean(env, 'FORGE_AUTO_IMPLEMENT', true),

      completionNotifyEnabled: parseBoolean(env, 'DISCOCLAW_COMPLETION_NOTIFY', true),
      completionNotifyThresholdMs: parseNonNegativeInt(env, 'DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS', 30000),

      openaiApiKey,
      openaiBaseUrl,
      openaiModel,
      openaiCompatToolsEnabled,
      imagegenGeminiApiKey,
      imagegenDefaultModel,

      voiceEnabled,
      voiceSttProvider,
      voiceTtsProvider,
      voiceTranscriptChannel,
      deepgramApiKey,
      cartesiaApiKey,

      forgeDrafterRuntime,
      forgeAuditorRuntime,

      openrouterApiKey,
      openrouterBaseUrl,
      openrouterModel,

      geminiBin: parseTrimmedString(env, 'GEMINI_BIN') ?? 'gemini',
      geminiModel: parseTrimmedString(env, 'GEMINI_MODEL') ?? 'gemini-2.5-pro',

      codexBin: parseTrimmedString(env, 'CODEX_BIN') ?? 'codex',
      codexModel: parseTrimmedString(env, 'CODEX_MODEL') ?? 'gpt-5.3-codex',
      codexDangerouslyBypassApprovalsAndSandbox: parseBoolean(env, 'CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX', false),
      codexDisableSessions: parseBoolean(env, 'CODEX_DISABLE_SESSIONS', false),

      summaryToDurableEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED', true),
      shortTermMemoryEnabled: parseBoolean(env, 'DISCOCLAW_SHORTTERM_MEMORY_ENABLED', true),
      shortTermMaxEntries: parsePositiveInt(env, 'DISCOCLAW_SHORTTERM_MAX_ENTRIES', 20),
      shortTermMaxAgeHours: parsePositiveNumber(env, 'DISCOCLAW_SHORTTERM_MAX_AGE_HOURS', 6),
      shortTermInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS', 1000),
      shortTermDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_SHORTTERM_DATA_DIR'),
      actionFollowupDepth: parseNonNegativeInt(env, 'DISCOCLAW_ACTION_FOLLOWUP_DEPTH', 3),

      reactionHandlerEnabled: parseBoolean(env, 'DISCOCLAW_REACTION_HANDLER', true),
      reactionRemoveHandlerEnabled: parseBoolean(env, 'DISCOCLAW_REACTION_REMOVE_HANDLER', false),
      reactionMaxAgeHours: parseNonNegativeNumber(env, 'DISCOCLAW_REACTION_MAX_AGE_HOURS', 24),

      statusChannel: parseTrimmedString(env, 'DISCOCLAW_STATUS_CHANNEL'),
      guildId: parseTrimmedString(env, 'DISCORD_GUILD_ID'),

      cronEnabled,
      cronForum,
      cronModel: parseTrimmedString(env, 'DISCOCLAW_CRON_MODEL') ?? fastModel,
      cronAutoTag: parseBoolean(env, 'DISCOCLAW_CRON_AUTO_TAG', true),
      cronAutoTagModel: parseTrimmedString(env, 'DISCOCLAW_CRON_AUTO_TAG_MODEL') ?? fastModel,
      cronStatsDirOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_STATS_DIR'),
      cronTagMapPathOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_TAG_MAP'),

      workspaceCwdOverride: parseTrimmedString(env, 'WORKSPACE_CWD'),
      groupsDirOverride: parseTrimmedString(env, 'GROUPS_DIR'),
      useGroupDirCwd: parseBoolean(env, 'USE_GROUP_DIR_CWD', false),

      webhookEnabled,
      webhookPort,
      webhookConfigPath,

      tasksEnabled,
      tasksCwdOverride,
      tasksForum,
      tasksTagMapPathOverride,
      tasksMentionUser,
      tasksSidebar,
      tasksAutoTag,
      tasksAutoTagModel,
      tasksSyncSkipPhase5,
      tasksSyncFailureRetryEnabled,
      tasksSyncFailureRetryDelayMs,
      tasksSyncDeferredRetryDelayMs,
      tasksPrefix,

      claudeBin: parseTrimmedString(env, 'CLAUDE_BIN') ?? 'claude',
      dangerouslySkipPermissions: parseBoolean(env, 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS', false),
      outputFormat,
      echoStdio: parseBoolean(env, 'CLAUDE_ECHO_STDIO', false),
      verbose: effectiveVerbose,
      claudeDebugFile: parseTrimmedString(env, 'CLAUDE_DEBUG_FILE'),
      strictMcpConfig: parseBoolean(env, 'CLAUDE_STRICT_MCP_CONFIG', true),
      sessionScanning: parseBoolean(env, 'DISCOCLAW_SESSION_SCANNING', true),
      toolAwareStreaming: parseBoolean(env, 'DISCOCLAW_TOOL_AWARE_STREAMING', true),
      multiTurn: parseBoolean(env, 'DISCOCLAW_MULTI_TURN', true),
      multiTurnHangTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS', 60000),
      multiTurnIdleTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS', 300000),
      multiTurnMaxProcesses: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_MAX_PROCESSES', 5),
      streamStallTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_TIMEOUT_MS', 600000),
      progressStallTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS', 300000),
      streamStallWarningMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_WARNING_MS', 300000),
      maxConcurrentInvocations: parseNonNegativeInt(env, 'DISCOCLAW_MAX_CONCURRENT_INVOCATIONS', 0),
      debugRuntime: parseBoolean(env, 'DISCOCLAW_DEBUG_RUNTIME', false),

      healthCommandsEnabled: parseBoolean(env, 'DISCOCLAW_HEALTH_COMMANDS_ENABLED', true),
      healthVerboseAllowlist,

      botDisplayName: parseTrimmedString(env, 'DISCOCLAW_BOT_NAME'),
      botStatus: parseEnum(env, 'DISCOCLAW_BOT_STATUS', ['online', 'idle', 'dnd', 'invisible'] as const),
      botActivity: parseTrimmedString(env, 'DISCOCLAW_BOT_ACTIVITY'),
      botActivityType: parseEnum(env, 'DISCOCLAW_BOT_ACTIVITY_TYPE', ['Playing', 'Listening', 'Watching', 'Competing', 'Custom'] as const, 'Playing'),
      botAvatar: parseAvatarPath(env, 'DISCOCLAW_BOT_AVATAR'),

      serviceName: parseTrimmedString(env, 'DISCOCLAW_SERVICE_NAME') ?? 'discoclaw',
    },
    warnings,
    infos,
  };
}
