import path from 'node:path';
import { isAllowlisted, parseAllowBotIds, parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';
import { parseDashboardTrustedHosts } from './dashboard/options.js';
import { OPENROUTER_DEFAULT_MODEL } from './runtime/model-tiers.js';
import {
  canonicalizeRuntimePathName,
  listCanonicalRuntimeNames,
  parseRuntimeNameForPlacement,
  type RuntimePathPlacement,
} from './runtime/runtime-path-contract.js';

export const KNOWN_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Pipeline', 'Step',
]);
export const DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS = 1800;
export const DEFAULT_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT = 5;
export const DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DEPTH = 4;
export const DEFAULT_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS = 60;
export const DEFAULT_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS = 86400;
export const DEFAULT_DISCORD_ACTIONS_LOOP_MAX_CONCURRENT = 5;

type ParseResult = {
  config: DiscoclawConfig;
  warnings: string[];
  infos: string[];
};

type OpenRouterProviderPercentiles = Partial<Record<'p50' | 'p75' | 'p90' | 'p99', number>>;
type OpenRouterProviderSortMetric = 'price' | 'throughput' | 'latency';
type OpenRouterProviderSort = OpenRouterProviderSortMetric | {
  by: OpenRouterProviderSortMetric;
  partition?: 'model' | 'none';
};
type OpenRouterProviderMaxPrice = Partial<Record<'prompt' | 'completion' | 'image' | 'request', number>>;

export type OpenRouterProviderPreferences = {
  order?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
  enforceDistillableText?: boolean;
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: OpenRouterProviderSort;
  preferredMinThroughput?: number | OpenRouterProviderPercentiles;
  preferredMaxLatency?: number | OpenRouterProviderPercentiles;
  maxPrice?: OpenRouterProviderMaxPrice;
};

export type DiscoclawConfig = {
  token: string;
  allowUserIds: Set<string>;
  allowBotIds: Set<string>;
  botMessageMemoryWriteEnabled: boolean;
  allowChannelIds: Set<string>;
  restrictChannelIds: boolean;
  primaryRuntime: string;
  fastRuntime?: string;

  runtimeModel: string;
  planRunModel?: string;
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
  discordActionsLoop: boolean;
  discordActionsImagegen: boolean;
  discordActionsVoice: boolean;
  discordActionsSpawn: boolean;
  discordActionsArchive: boolean;
  canvasEnabled: boolean;
  canvasPort: number;
  canvasArtifactDir?: string;
  canvasMaxArtifacts: number;
  canvasPendingLaunchTtlSeconds: number;
  canvasWriteBridgeEnabled: boolean;
  canvasExportDir?: string;
  canvasExportMaxBytes: number;
  discordClientId?: string;
  discordActivityClientSecret?: string;

  deferMaxDelaySeconds: number;
  deferMaxDepth: number;
  spawnMaxConcurrent: number;
  deferMaxConcurrent: number;
  loopMinIntervalSeconds: number;
  loopMaxIntervalSeconds: number;
  loopMaxConcurrent: number;

  messageHistoryBudget: number;
  messageHistoryFetchLimit: number;
  messageHistoryMaxAgeMs: number;
  summaryEnabled: boolean;
  summaryModel: string;
  summaryMaxChars: number;
  summaryEveryNTurns: number;
  summaryMaxTokens: number;
  summaryTargetRatio: number;
  summaryDataDirOverride?: string;
  summaryArchiveDirOverride?: string;
  capsuleTtlMs: number;
  durableMemoryEnabled: boolean;
  durableDataDirOverride?: string;
  durableInjectMaxChars: number;
  durableMaxItems: number;
  durableSupersessionShadow: boolean;
  memoryConsolidationThreshold: number;
  memoryConsolidationModel: string;
  memoryCommandsEnabled: boolean;
  planCommandsEnabled: boolean;
  planPhasesEnabled: boolean;
  planPhaseMaxContextFiles: number;
  planPhaseTimeoutMs: number;
  planPhaseMaxAuditFixAttempts: number;
  planForgeHeartbeatIntervalMs: number;
  forgeCommandsEnabled: boolean;
  forgeMaxAuditRounds: number;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  forgeTimeoutMs: number;
  forgeProgressThrottleMs: number;
  forgeAutoImplement: boolean;

  completionNotifyEnabled: boolean;
  completionNotifyThresholdMs: number;
  actionFollowupTimeoutMs: number;

  // OpenAI-compat adapter config
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel: string;
  openaiCompatToolsEnabled: boolean;
  openaiCompatHybridPipelineEnabled: boolean;

  // Imagegen provider keys
  imagegenGeminiApiKey?: string;
  imagegenDefaultModel?: string;

  // Anthropic Messages API (direct HTTP — used for voice to avoid CLI cold-start)
  anthropicApiKey?: string;

  // Voice config
  voiceEnabled: boolean;
  voiceAutoJoin: boolean;
  voiceModel: string;
  voiceSystemPrompt?: string;
  voiceSttProvider: 'deepgram' | 'whisper' | 'openai';
  voiceTtsProvider: 'cartesia' | 'deepgram' | 'kokoro' | 'openai';
  voiceHomeChannel?: string;
  voiceLogChannel?: string;
  deepgramApiKey?: string;
  deepgramSttModel: string;
  deepgramTtsVoice: string;
  deepgramTtsSpeed?: number;
  cartesiaApiKey?: string;

  forgeDrafterRuntime?: string;
  forgeAuditorRuntime?: string;

  // OpenRouter adapter config
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel: string;
  openrouterProviderPreferences?: OpenRouterProviderPreferences;

  // Gemini adapter config
  geminiApiKey?: string;
  geminiModel: string;

  // Codex CLI adapter config
  codexBin: string;
  codexModel: string;
  codexDangerouslyBypassApprovalsAndSandbox: boolean;
  codexDisableSessions: boolean;
  codexVerbosePreview: boolean;
  codexItemTypeDebug: boolean;

  // Cold-storage config
  coldStorageEnabled: boolean;
  coldStorageProvider: 'openai' | 'openai-compat';
  coldStorageApiKey?: string;
  coldStorageModel?: string;
  coldStorageDimensions: number;
  coldStorageBaseUrl?: string;
  coldStorageDbPath?: string;
  coldStorageChannelFilter: string[];
  coldStorageInjectMaxChars: number;
  coldStorageSearchLimit: number;
  coldStorageHydeEnabled: boolean;
  coldStorageHydeModel?: string;

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
  cronExecModel: string;
  cronStatsDirOverride?: string;
  cronTagMapPathOverride?: string;

  workspaceCwdOverride?: string;
  groupsDirOverride?: string;
  useGroupDirCwd: boolean;

  webhookEnabled: boolean;
  webhookPort: number;
  webhookConfigPath?: string;
  dashboardEnabled: boolean;
  dashboardPort: number;
  dashboardTrustedHosts: Set<string>;

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
  globalSupervisorEnabled: boolean;
  globalSupervisorAuditStream: 'stdout' | 'stderr';
  globalSupervisorMaxCycles: number;
  globalSupervisorMaxRetries: number;
  globalSupervisorMaxEscalationLevel: number;
  globalSupervisorMaxTotalEvents: number;
  globalSupervisorMaxWallTimeMs: number;
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
  streamPreviewRaw: boolean;
  multiTurn: boolean;
  multiTurnHangTimeoutMs: number;
  multiTurnIdleTimeoutMs: number;
  multiTurnMaxProcesses: number;
  streamStallTimeoutMs: number;
  progressStallTimeoutMs: number;
  streamStallWarningMs: number;
  maxConcurrentInvocations: number;
  debugRuntime: boolean;
  debugStreamPreviewLines: boolean;

  healthCommandsEnabled: boolean;
  healthVerboseAllowlist: Set<string>;

  botDisplayName?: string;
  botStatus?: 'online' | 'idle' | 'dnd' | 'invisible';
  botActivity?: string;
  botActivityType?: 'Playing' | 'Listening' | 'Watching' | 'Competing' | 'Custom';
  botAvatar?: string;

  serviceName: string;
};

/**
 * Check whether a Discord user is authorized for config-mutating actions.
 * Uses the DISCORD_ALLOW_USER_IDS allowlist as the sole authorization source.
 * Fails closed: returns false when the allowlist is empty.
 */
export function isAuthorizedUser(config: DiscoclawConfig, userId: string): boolean {
  return isAllowlisted(config.allowUserIds, userId);
}

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
const DEFAULT_PLAN_FORGE_HEARTBEAT_INTERVAL_MS = 45_000;

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

function parseZeroToOneExclusive(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(`${name} must be a number between 0 and 1 (exclusive), got "${raw}"`);
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
  placement: RuntimePathPlacement,
): string | undefined {
  const raw = parseTrimmedString(env, name);
  if (!raw) return undefined;

  const canonicalName = parseRuntimeNameForPlacement(raw, placement);
  if (canonicalName) return canonicalName;

  const supportedRuntimeNames = listCanonicalRuntimeNames(placement).join('|');
  const knownRuntimeName = canonicalizeRuntimePathName(raw);
  if (knownRuntimeName) {
    throw new Error(
      `${name} does not support runtime "${raw}". Supported values: ${supportedRuntimeNames}`,
    );
  }

  throw new Error(`${name} must be one of ${supportedRuntimeNames}, got "${raw}"`);
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
  if (!raw) return Array.from(KNOWN_TOOLS);

  const tools = raw
    .split(/[,\s]+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tools.length === 0) {
    throw new Error('RUNTIME_TOOLS was set but no tools were parsed');
  }

  const explicitHybridLabels = tools.filter((t) => t.startsWith('pipeline.') || t.startsWith('step.'));
  if (explicitHybridLabels.length > 0) {
    warnings.push(
      `RUNTIME_TOOLS includes explicit hybrid tool labels (${explicitHybridLabels.join(', ')}). ` +
      'Use category allowlisting (Pipeline/Step); explicit labels are ignored.',
    );
  }

  const filteredTools = tools.filter((t) => !t.startsWith('pipeline.') && !t.startsWith('step.'));
  const unknown = filteredTools.filter((t) => !KNOWN_TOOLS.has(t));
  if (unknown.length > 0) {
    warnings.push(
      `RUNTIME_TOOLS includes unknown tools (${unknown.join(', ')}). ` +
      'Passing through as configured for runtime compatibility.',
    );
  }

  return filteredTools;
}

function parseOpenRouterProviderPreferences(
  env: NodeJS.ProcessEnv,
  name: string,
): OpenRouterProviderPreferences | undefined {
  const raw = parseTrimmedString(env, name);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`${name} must be valid JSON${detail}`);
  }

  const ensureObject = (value: unknown, path: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} must be a JSON object`);
    }
    return value as Record<string, unknown>;
  };

  const ensureBoolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') {
      throw new Error(`${path} must be a boolean`);
    }
    return value;
  };

  const ensureEnum = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T => {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw new Error(`${path} must be one of ${allowed.join('|')}`);
    }
    return value as T;
  };

  const ensureNonNegativeNumber = (value: unknown, path: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${path} must be a non-negative number`);
    }
    return value;
  };

  const ensureStringArray = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array of non-empty strings`);
    }
    return value.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new Error(`${path}[${index}] must be a non-empty string`);
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        throw new Error(`${path}[${index}] must be a non-empty string`);
      }
      return trimmed;
    });
  };

  const pickAliasedValue = (
    input: Record<string, unknown>,
    path: string,
    aliases: readonly string[],
  ): unknown => {
    const present = aliases.filter((alias) => Object.hasOwn(input, alias));
    if (present.length > 1) {
      throw new Error(`${path} must not specify multiple aliases (${present.join(', ')})`);
    }
    return present.length === 1 ? input[present[0]] : undefined;
  };

  const ensurePercentiles = (value: unknown, path: string): number | OpenRouterProviderPercentiles => {
    if (typeof value === 'number') return ensureNonNegativeNumber(value, path);

    const objectValue = ensureObject(value, path);
    const allowedKeys = new Set(['p50', 'p75', 'p90', 'p99']);
    for (const key of Object.keys(objectValue)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${path} includes unsupported key "${key}"`);
      }
    }

    const result: OpenRouterProviderPercentiles = {};
    let found = false;
    for (const key of ['p50', 'p75', 'p90', 'p99'] as const) {
      if (objectValue[key] === undefined) continue;
      result[key] = ensureNonNegativeNumber(objectValue[key], `${path}.${key}`);
      found = true;
    }
    if (!found) {
      throw new Error(`${path} must include at least one percentile key`);
    }
    return result;
  };

  const objectValue = ensureObject(parsed, name);
  const allowedKeys = new Set([
    'order',
    'allowFallbacks',
    'allow_fallbacks',
    'requireParameters',
    'require_parameters',
    'dataCollection',
    'data_collection',
    'zdr',
    'enforceDistillableText',
    'enforce_distillable_text',
    'only',
    'ignore',
    'quantizations',
    'sort',
    'preferredMinThroughput',
    'preferred_min_throughput',
    'preferredMaxLatency',
    'preferred_max_latency',
    'maxPrice',
    'max_price',
  ]);
  for (const key of Object.keys(objectValue)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${name} includes unsupported key "${key}"`);
    }
  }

  const order = pickAliasedValue(objectValue, `${name}.order`, ['order']);
  const allowFallbacks = pickAliasedValue(objectValue, `${name}.allowFallbacks`, ['allowFallbacks', 'allow_fallbacks']);
  const requireParameters = pickAliasedValue(objectValue, `${name}.requireParameters`, ['requireParameters', 'require_parameters']);
  const dataCollection = pickAliasedValue(objectValue, `${name}.dataCollection`, ['dataCollection', 'data_collection']);
  const zdr = pickAliasedValue(objectValue, `${name}.zdr`, ['zdr']);
  const enforceDistillableText = pickAliasedValue(
    objectValue,
    `${name}.enforceDistillableText`,
    ['enforceDistillableText', 'enforce_distillable_text'],
  );
  const only = pickAliasedValue(objectValue, `${name}.only`, ['only']);
  const ignore = pickAliasedValue(objectValue, `${name}.ignore`, ['ignore']);
  const quantizations = pickAliasedValue(objectValue, `${name}.quantizations`, ['quantizations']);
  const sort = pickAliasedValue(objectValue, `${name}.sort`, ['sort']);
  const preferredMinThroughput = pickAliasedValue(
    objectValue,
    `${name}.preferredMinThroughput`,
    ['preferredMinThroughput', 'preferred_min_throughput'],
  );
  const preferredMaxLatency = pickAliasedValue(
    objectValue,
    `${name}.preferredMaxLatency`,
    ['preferredMaxLatency', 'preferred_max_latency'],
  );
  const maxPrice = pickAliasedValue(objectValue, `${name}.maxPrice`, ['maxPrice', 'max_price']);

  const result: OpenRouterProviderPreferences = {};
  if (order !== undefined) result.order = ensureStringArray(order, `${name}.order`);
  if (allowFallbacks !== undefined) result.allowFallbacks = ensureBoolean(allowFallbacks, `${name}.allowFallbacks`);
  if (requireParameters !== undefined) result.requireParameters = ensureBoolean(requireParameters, `${name}.requireParameters`);
  if (dataCollection !== undefined) {
    result.dataCollection = ensureEnum(dataCollection, `${name}.dataCollection`, ['allow', 'deny'] as const);
  }
  if (zdr !== undefined) result.zdr = ensureBoolean(zdr, `${name}.zdr`);
  if (enforceDistillableText !== undefined) {
    result.enforceDistillableText = ensureBoolean(
      enforceDistillableText,
      `${name}.enforceDistillableText`,
    );
  }
  if (only !== undefined) result.only = ensureStringArray(only, `${name}.only`);
  if (ignore !== undefined) result.ignore = ensureStringArray(ignore, `${name}.ignore`);
  if (quantizations !== undefined) result.quantizations = ensureStringArray(quantizations, `${name}.quantizations`);
  if (sort !== undefined) {
    if (typeof sort === 'string') {
      result.sort = ensureEnum(sort, `${name}.sort`, ['price', 'throughput', 'latency'] as const);
    } else {
      const sortObject = ensureObject(sort, `${name}.sort`);
      const sortAllowedKeys = new Set(['by', 'partition']);
      for (const key of Object.keys(sortObject)) {
        if (!sortAllowedKeys.has(key)) {
          throw new Error(`${name}.sort includes unsupported key "${key}"`);
        }
      }
      result.sort = {
        by: ensureEnum(sortObject.by, `${name}.sort.by`, ['price', 'throughput', 'latency'] as const),
        ...(sortObject.partition === undefined
          ? {}
          : { partition: ensureEnum(sortObject.partition, `${name}.sort.partition`, ['model', 'none'] as const) }),
      };
    }
  }
  if (preferredMinThroughput !== undefined) {
    result.preferredMinThroughput = ensurePercentiles(
      preferredMinThroughput,
      `${name}.preferredMinThroughput`,
    );
  }
  if (preferredMaxLatency !== undefined) {
    result.preferredMaxLatency = ensurePercentiles(
      preferredMaxLatency,
      `${name}.preferredMaxLatency`,
    );
  }
  if (maxPrice !== undefined) {
    const maxPriceObject = ensureObject(maxPrice, `${name}.maxPrice`);
    const priceAllowedKeys = new Set(['prompt', 'completion', 'image', 'request']);
    for (const key of Object.keys(maxPriceObject)) {
      if (!priceAllowedKeys.has(key)) {
        throw new Error(`${name}.maxPrice includes unsupported key "${key}"`);
      }
    }
    const normalized: OpenRouterProviderMaxPrice = {};
    for (const key of ['prompt', 'completion', 'image', 'request'] as const) {
      if (maxPriceObject[key] === undefined) continue;
      normalized[key] = ensureNonNegativeNumber(maxPriceObject[key], `${name}.maxPrice.${key}`);
    }
    if (Object.keys(normalized).length === 0) {
      throw new Error(`${name}.maxPrice must include at least one pricing key`);
    }
    result.maxPrice = normalized;
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`${name} must include at least one supported preference`);
  }
  return result;
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
  const discordActionsForge = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_FORGE', false);
  const discordActionsPlan = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_PLAN', false);
  const discordActionsMemory = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MEMORY', true);
  const discordActionsDefer = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_DEFER', true);
  const discordActionsLoop = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_LOOP', true);
  const discordActionsImagegen = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN', false);
  const discordActionsVoice = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_VOICE', false);
  const discordActionsSpawn = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_SPAWN', true);
  const discordActionsArchive = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_ARCHIVE', false);
  const canvasEnabled = parseBoolean(env, 'DISCOCLAW_CANVAS_ENABLED', false);
  const canvasPort = parsePositiveInt(env, 'DISCOCLAW_CANVAS_PORT', 9402);
  const canvasArtifactDir = parseTrimmedString(env, 'DISCOCLAW_CANVAS_ARTIFACT_DIR');
  const canvasMaxArtifacts = parsePositiveInt(env, 'DISCOCLAW_CANVAS_MAX_ARTIFACTS', 1000);
  const canvasPendingLaunchTtlSeconds = parsePositiveInt(env, 'DISCOCLAW_CANVAS_PENDING_LAUNCH_TTL_SECONDS', 120);
  const canvasWriteBridgeEnabled = parseBoolean(env, 'DISCOCLAW_CANVAS_WRITE_BRIDGE_ENABLED', true);
  const canvasExportDir = parseTrimmedString(env, 'DISCOCLAW_CANVAS_EXPORT_DIR');
  const canvasExportMaxBytes = parsePositiveInt(env, 'DISCOCLAW_CANVAS_EXPORT_MAX_BYTES', 5_242_880);
  const discordClientId = parseTrimmedString(env, 'DISCORD_CLIENT_ID');
  const discordActivityClientSecret = parseTrimmedString(env, 'DISCORD_ACTIVITY_CLIENT_SECRET');
  const spawnMaxConcurrent = parsePositiveInt(env, 'DISCOCLAW_DISCORD_ACTIONS_SPAWN_MAX_CONCURRENT', 4);
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
  const deferMaxDepth = parsePositiveInt(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH',
    DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DEPTH,
  );
  const loopMinIntervalSeconds = parsePositiveInt(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS',
    DEFAULT_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS,
  );
  const loopMaxIntervalSeconds = parsePositiveInt(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS',
    DEFAULT_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS,
  );
  const loopMaxConcurrent = parsePositiveInt(
    env,
    'DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_CONCURRENT',
    DEFAULT_DISCORD_ACTIONS_LOOP_MAX_CONCURRENT,
  );
  if (loopMinIntervalSeconds > loopMaxIntervalSeconds) {
    throw new Error(
      'DISCOCLAW_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS cannot exceed DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS',
    );
  }

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
      { name: 'DISCOCLAW_DISCORD_ACTIONS_LOOP', enabled: discordActionsLoop },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN', enabled: discordActionsImagegen },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_VOICE', enabled: discordActionsVoice },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_SPAWN', enabled: discordActionsSpawn },
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
  const dashboardEnabled = parseBoolean(env, 'DISCOCLAW_DASHBOARD_ENABLED', true);
  const dashboardPort = parsePositiveInt(env, 'DISCOCLAW_DASHBOARD_PORT', 9401);
  const dashboardTrustedHosts = parseDashboardTrustedHosts(env);

  const tasksEnabled = parseBoolean(env, 'DISCOCLAW_TASKS_ENABLED', true);
  let tasksForum = parseTrimmedString(env, 'DISCOCLAW_TASKS_FORUM');
  if (tasksForum && !/^\d{8,}$/.test(tasksForum)) {
    warnings.push('DISCOCLAW_TASKS_FORUM is not a valid snowflake; ignoring (system bootstrap will auto-create)');
    tasksForum = undefined;
  }

  const primaryRuntime = parseRuntimeName(env, 'PRIMARY_RUNTIME', 'startup:PRIMARY_RUNTIME') ?? 'claude-cli';
  const fastRuntime = parseRuntimeName(env, 'DISCOCLAW_FAST_RUNTIME', 'startup:DISCOCLAW_FAST_RUNTIME');
  if (fastRuntime) {
    warnings.push(
      "DISCOCLAW_FAST_RUNTIME is deprecated — use '!models set fast <model>' instead. " +
      'The env var still works for initial startup but is ignored by !models reset.',
    );
  }
  const forgeDrafterRuntime = parseRuntimeName(env, 'FORGE_DRAFTER_RUNTIME', 'startup:FORGE_DRAFTER_RUNTIME');
  const forgeAuditorRuntime = parseRuntimeName(env, 'FORGE_AUDITOR_RUNTIME', 'startup:FORGE_AUDITOR_RUNTIME');
  const openaiApiKey = parseTrimmedString(env, 'OPENAI_API_KEY');
  const openaiBaseUrl = parseTrimmedString(env, 'OPENAI_BASE_URL');
  const openaiModel = parseTrimmedString(env, 'OPENAI_MODEL') ?? 'gpt-4o';
  const openaiCompatToolsEnabled = parseBoolean(env, 'OPENAI_COMPAT_TOOLS_ENABLED', false);
  const openaiCompatHybridPipelineEnabled = parseBoolean(env, 'OPENAI_COMPAT_HYBRID_PIPELINE_ENABLED', false);
  const geminiApiKey = parseTrimmedString(env, 'GEMINI_API_KEY');
  const imagegenGeminiApiKey = parseTrimmedString(env, 'IMAGEGEN_GEMINI_API_KEY');
  const imagegenDefaultModel = parseTrimmedString(env, 'IMAGEGEN_DEFAULT_MODEL');
  if (primaryRuntime === 'openai' && !openaiApiKey) {
    warnings.push('PRIMARY_RUNTIME=openai but OPENAI_API_KEY is not set; startup will fail unless another runtime is selected.');
  }
  if (fastRuntime === 'openai' && !openaiApiKey) {
    warnings.push('DISCOCLAW_FAST_RUNTIME=openai but OPENAI_API_KEY is not set; fast-tier invocations will fall back to PRIMARY_RUNTIME.');
  }
  if (forgeDrafterRuntime === 'openai' && !openaiApiKey) {
    warnings.push('FORGE_DRAFTER_RUNTIME=openai but OPENAI_API_KEY is not set; drafter will fall back to the primary runtime.');
  }
  if (forgeAuditorRuntime === 'openai' && !openaiApiKey) {
    warnings.push('FORGE_AUDITOR_RUNTIME=openai but OPENAI_API_KEY is not set; auditor will fall back to the primary runtime.');
  }
  if (primaryRuntime === 'gemini-api' && !geminiApiKey) {
    warnings.push('PRIMARY_RUNTIME=gemini-api but GEMINI_API_KEY is not set; startup will fail unless another runtime is selected.');
  }
  if (fastRuntime === 'gemini-api' && !geminiApiKey) {
    warnings.push('DISCOCLAW_FAST_RUNTIME=gemini-api but GEMINI_API_KEY is not set; fast-tier invocations will fall back to PRIMARY_RUNTIME.');
  }
  if (forgeDrafterRuntime === 'gemini-api' && !geminiApiKey) {
    warnings.push('FORGE_DRAFTER_RUNTIME=gemini-api but GEMINI_API_KEY is not set; drafter will fall back to the primary runtime.');
  }
  if (forgeAuditorRuntime === 'gemini-api' && !geminiApiKey) {
    warnings.push('FORGE_AUDITOR_RUNTIME=gemini-api but GEMINI_API_KEY is not set; auditor will fall back to the primary runtime.');
  }
  if (discordActionsImagegen && !openaiApiKey && !imagegenGeminiApiKey) {
    warnings.push('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1 but neither OPENAI_API_KEY nor IMAGEGEN_GEMINI_API_KEY is set; imagegen will fail at runtime.');
  }
  if (imagegenDefaultModel) {
    if ((imagegenDefaultModel.startsWith('imagen-') || imagegenDefaultModel.startsWith('gemini-')) && !imagegenGeminiApiKey) {
      warnings.push(`IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires IMAGEGEN_GEMINI_API_KEY but it is not set; imagegen will fail at runtime.`);
    } else if ((imagegenDefaultModel.startsWith('dall-e-') || imagegenDefaultModel.startsWith('gpt-image-')) && !openaiApiKey) {
      warnings.push(`IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires OPENAI_API_KEY but it is not set; imagegen will fail at runtime.`);
    }
  }

  const anthropicApiKey = parseTrimmedString(env, 'ANTHROPIC_API_KEY');

  const voiceEnabled = parseBoolean(env, 'DISCOCLAW_VOICE_ENABLED', false);
  const voiceAutoJoin = parseBoolean(env, 'DISCOCLAW_VOICE_AUTO_JOIN', false);
  const voiceSttProvider = parseEnum(env, 'DISCOCLAW_STT_PROVIDER', ['deepgram', 'whisper', 'openai'] as const, 'deepgram')!;
  const voiceTtsProvider = parseEnum(env, 'DISCOCLAW_TTS_PROVIDER', ['cartesia', 'deepgram', 'kokoro', 'openai'] as const, 'cartesia')!;
  let voiceHomeChannel = parseTrimmedString(env, 'DISCOCLAW_VOICE_HOME_CHANNEL');
  if (!voiceHomeChannel) {
    const legacy = parseTrimmedString(env, 'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL');
    if (legacy) {
      voiceHomeChannel = legacy;
      warnings.push(
        'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL is deprecated; use DISCOCLAW_VOICE_HOME_CHANNEL instead.',
      );
    }
  }
  const voiceLogChannel = parseTrimmedString(env, 'DISCOCLAW_VOICE_LOG_CHANNEL');
  const deepgramApiKey = parseTrimmedString(env, 'DEEPGRAM_API_KEY');
  const deepgramSttModel = parseTrimmedString(env, 'DEEPGRAM_STT_MODEL') ?? 'nova-3-general';
  const deepgramTtsVoice = parseTrimmedString(env, 'DEEPGRAM_TTS_VOICE') ?? 'aura-2-asteria-en';
  const deepgramTtsSpeed = (() => {
    const raw = parseTrimmedString(env, 'DEEPGRAM_TTS_SPEED');
    if (raw == null) return 1.3;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0.5 || n > 1.5) {
      throw new Error(`DEEPGRAM_TTS_SPEED must be a number between 0.5 and 1.5, got "${raw}"`);
    }
    return n;
  })();
  const cartesiaApiKey = parseTrimmedString(env, 'CARTESIA_API_KEY');
  const voiceModelRaw = parseTrimmedString(env, 'DISCOCLAW_VOICE_MODEL');
  const voiceSystemPrompt = (() => {
    const raw = parseTrimmedString(env, 'DISCOCLAW_VOICE_SYSTEM_PROMPT');
    if (raw == null) return undefined;
    if (raw.length > 4000) {
      throw new Error(`DISCOCLAW_VOICE_SYSTEM_PROMPT exceeds 4000 char limit (got ${raw.length})`);
    }
    return raw;
  })();

  if (voiceEnabled && voiceSttProvider === 'deepgram' && !deepgramApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with STT provider "deepgram" but DEEPGRAM_API_KEY is not set; voice STT will fail at runtime.');
  }
  if (voiceEnabled && voiceSttProvider === 'openai' && !openaiApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with STT provider "openai" but OPENAI_API_KEY is not set; voice STT will fail at runtime.');
  }
  if (voiceEnabled && voiceTtsProvider === 'cartesia' && !cartesiaApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with TTS provider "cartesia" but CARTESIA_API_KEY is not set; voice TTS will fail at runtime.');
  }
  if (voiceEnabled && voiceTtsProvider === 'deepgram' && !deepgramApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with TTS provider "deepgram" but DEEPGRAM_API_KEY is not set; voice TTS will fail at runtime.');
  }
  if (voiceEnabled && voiceTtsProvider === 'openai' && !openaiApiKey) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 with TTS provider "openai" but OPENAI_API_KEY is not set; voice TTS will fail at runtime.');
  }
  if (voiceEnabled && !voiceHomeChannel) {
    warnings.push('DISCOCLAW_VOICE_ENABLED=1 but DISCOCLAW_VOICE_HOME_CHANNEL is not set; voice actions will be disabled (no target channel for action execution).');
  }

  const coldStorageEnabled = parseBoolean(env, 'DISCOCLAW_COLD_STORAGE_ENABLED', false);
  const coldStorageApiKey = parseTrimmedString(env, 'COLD_STORAGE_API_KEY') ?? openaiApiKey;
  const coldStorageProvider = parseEnum(env, 'COLD_STORAGE_PROVIDER', ['openai', 'openai-compat'] as const, 'openai')!;
  if (coldStorageEnabled && !coldStorageApiKey) {
    warnings.push('DISCOCLAW_COLD_STORAGE_ENABLED=1 but neither COLD_STORAGE_API_KEY nor OPENAI_API_KEY is set; cold storage will fail at runtime.');
  }
  if (coldStorageEnabled && coldStorageProvider === 'openai-compat') {
    if (!parseTrimmedString(env, 'COLD_STORAGE_BASE_URL')) {
      warnings.push('DISCOCLAW_COLD_STORAGE_ENABLED=1 with provider "openai-compat" but COLD_STORAGE_BASE_URL is not set; cold storage will fail at runtime.');
    }
    if (!parseTrimmedString(env, 'COLD_STORAGE_MODEL')) {
      warnings.push('DISCOCLAW_COLD_STORAGE_ENABLED=1 with provider "openai-compat" but COLD_STORAGE_MODEL is not set; cold storage will fail at runtime.');
    }
    if (!parseTrimmedString(env, 'COLD_STORAGE_DIMENSIONS')) {
      warnings.push('DISCOCLAW_COLD_STORAGE_ENABLED=1 with provider "openai-compat" but COLD_STORAGE_DIMENSIONS is not set; cold storage will fail at runtime.');
    }
  }

  const openrouterApiKey = parseTrimmedString(env, 'OPENROUTER_API_KEY');
  const openrouterBaseUrl = parseTrimmedString(env, 'OPENROUTER_BASE_URL');
  const openrouterModel = parseTrimmedString(env, 'OPENROUTER_MODEL') ?? OPENROUTER_DEFAULT_MODEL;
  const openrouterProviderPreferences = parseOpenRouterProviderPreferences(env, 'OPENROUTER_PROVIDER_PREFERENCES');
  if (primaryRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('PRIMARY_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; startup will fail unless another runtime is selected.');
  }
  if (fastRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('DISCOCLAW_FAST_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; fast-tier invocations will fall back to PRIMARY_RUNTIME.');
  }
  if (forgeDrafterRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('FORGE_DRAFTER_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; drafter will fall back to the primary runtime.');
  }
  if (forgeAuditorRuntime === 'openrouter' && !openrouterApiKey) {
    warnings.push('FORGE_AUDITOR_RUNTIME=openrouter but OPENROUTER_API_KEY is not set; auditor will fall back to the primary runtime.');
  }

  const fastModel = parseTrimmedString(env, 'DISCOCLAW_FAST_MODEL') ?? 'fast';
  const runtimeModel = parseTrimmedString(env, 'RUNTIME_MODEL') ?? 'capable';
  const planRunModel = parseTrimmedString(env, 'DISCOCLAW_PLAN_RUN_MODEL') ?? 'capable';
  const voiceModel = voiceModelRaw ?? runtimeModel;

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
      fastRuntime,

      runtimeModel,
      planRunModel,
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
      globalSupervisorEnabled: parseBoolean(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED', false),
      globalSupervisorAuditStream: parseEnum(
        env,
        'DISCOCLAW_GLOBAL_SUPERVISOR_AUDIT_STREAM',
        ['stdout', 'stderr'] as const,
        'stderr',
      )!,
      globalSupervisorMaxCycles: parsePositiveInt(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_CYCLES', 3),
      globalSupervisorMaxRetries: parseNonNegativeInt(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_RETRIES', 2),
      globalSupervisorMaxEscalationLevel: parseNonNegativeInt(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_ESCALATION_LEVEL', 2),
      globalSupervisorMaxTotalEvents: parsePositiveInt(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_TOTAL_EVENTS', 5_000),
      globalSupervisorMaxWallTimeMs: parseNonNegativeInt(env, 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_WALL_TIME_MS', 0),
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
      discordActionsLoop,
      discordActionsImagegen,
      discordActionsVoice,
      discordActionsSpawn,
      discordActionsArchive,
      canvasEnabled,
      canvasPort,
      canvasArtifactDir,
      canvasMaxArtifacts,
      canvasPendingLaunchTtlSeconds,
      canvasWriteBridgeEnabled,
      canvasExportDir,
      canvasExportMaxBytes,
      discordClientId,
      discordActivityClientSecret,

      deferMaxDelaySeconds,
      deferMaxDepth,
      deferMaxConcurrent,
      spawnMaxConcurrent,
      loopMinIntervalSeconds,
      loopMaxIntervalSeconds,
      loopMaxConcurrent,

      messageHistoryBudget: parseNonNegativeInt(env, 'DISCOCLAW_MESSAGE_HISTORY_BUDGET', 3000),
      messageHistoryFetchLimit: parsePositiveInt(env, 'DISCOCLAW_MESSAGE_HISTORY_FETCH_LIMIT', 10),
      messageHistoryMaxAgeMs: parsePositiveInt(env, 'DISCOCLAW_MESSAGE_HISTORY_MAX_AGE_HOURS', 48) * 3_600_000,
      summaryEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_ENABLED', true),
      summaryModel: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_MODEL') ?? fastModel,
      summaryMaxChars: parseNonNegativeInt(env, 'DISCOCLAW_SUMMARY_MAX_CHARS', 2000),
      summaryEveryNTurns: parsePositiveInt(env, 'DISCOCLAW_SUMMARY_EVERY_N_TURNS', 5),
      summaryMaxTokens: parsePositiveInt(env, 'DISCOCLAW_SUMMARY_MAX_TOKENS', 1500),
      summaryTargetRatio: parseZeroToOneExclusive(env, 'DISCOCLAW_SUMMARY_TARGET_RATIO', 0.65),
      summaryDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_DATA_DIR'),
      summaryArchiveDirOverride: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_ARCHIVE_DIR'),
      capsuleTtlMs: parseNonNegativeInt(env, 'DISCOCLAW_CAPSULE_TTL_MS', 7_200_000),
      durableMemoryEnabled: parseBoolean(env, 'DISCOCLAW_DURABLE_MEMORY_ENABLED', true),
      durableDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_DURABLE_DATA_DIR'),
      durableInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_DURABLE_INJECT_MAX_CHARS', 2000),
      durableMaxItems: parsePositiveInt(env, 'DISCOCLAW_DURABLE_MAX_ITEMS', 200),
      durableSupersessionShadow: parseBoolean(env, 'DISCOCLAW_DURABLE_SUPERSESSION_SHADOW', false),
      memoryConsolidationThreshold: parsePositiveInt(env, 'DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD', 50),
      memoryConsolidationModel: parseTrimmedString(env, 'DISCOCLAW_MEMORY_CONSOLIDATION_MODEL') ?? fastModel,
      memoryCommandsEnabled: parseBoolean(env, 'DISCOCLAW_MEMORY_COMMANDS_ENABLED', true),
      planCommandsEnabled: parseBoolean(env, 'DISCOCLAW_PLAN_COMMANDS_ENABLED', false),
      planPhasesEnabled: parseBoolean(
        env,
        'PLAN_PHASES_ENABLED',
        parseBoolean(env, 'DISCOCLAW_PLAN_COMMANDS_ENABLED', false),
      ),
      planPhaseMaxContextFiles: parsePositiveInt(env, 'PLAN_PHASE_MAX_CONTEXT_FILES', 5),
      planPhaseTimeoutMs: parsePositiveNumber(env, 'PLAN_PHASE_TIMEOUT_MS', DEFAULT_THIRTY_MINUTES_MS),
      planPhaseMaxAuditFixAttempts: parseNonNegativeInt(env, 'PLAN_PHASE_AUDIT_FIX_MAX', 3),
      planForgeHeartbeatIntervalMs: parseNonNegativeInt(
        env,
        'PLAN_FORGE_HEARTBEAT_INTERVAL_MS',
        DEFAULT_PLAN_FORGE_HEARTBEAT_INTERVAL_MS,
      ),
      forgeCommandsEnabled: parseBoolean(env, 'DISCOCLAW_FORGE_COMMANDS_ENABLED', false),
      forgeMaxAuditRounds: parsePositiveInt(env, 'FORGE_MAX_AUDIT_ROUNDS', 5),
      forgeDrafterModel: parseTrimmedString(env, 'FORGE_DRAFTER_MODEL'),
      forgeAuditorModel: parseTrimmedString(env, 'FORGE_AUDITOR_MODEL'),
      forgeTimeoutMs: parsePositiveNumber(env, 'FORGE_TIMEOUT_MS', DEFAULT_THIRTY_MINUTES_MS),
      forgeProgressThrottleMs: parseNonNegativeInt(env, 'FORGE_PROGRESS_THROTTLE_MS', 3000),
      forgeAutoImplement: parseBoolean(
        env,
        'FORGE_AUTO_IMPLEMENT',
        parseBoolean(env, 'DISCOCLAW_FORGE_COMMANDS_ENABLED', false),
      ),

      completionNotifyEnabled: parseBoolean(env, 'DISCOCLAW_COMPLETION_NOTIFY', true),
      completionNotifyThresholdMs: parseNonNegativeInt(env, 'DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS', 30000),
      actionFollowupTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_ACTION_FOLLOWUP_TIMEOUT_MS', 30000),

      openaiApiKey,
      openaiBaseUrl,
      openaiModel,
      openaiCompatToolsEnabled,
      openaiCompatHybridPipelineEnabled,
      imagegenGeminiApiKey,
      imagegenDefaultModel,

      anthropicApiKey,

      voiceEnabled,
      voiceAutoJoin,
      voiceModel,
      voiceSystemPrompt,
      voiceSttProvider,
      voiceTtsProvider,
      voiceHomeChannel,
      voiceLogChannel,
      deepgramApiKey,
      deepgramSttModel,
      deepgramTtsVoice,
      deepgramTtsSpeed,
      cartesiaApiKey,

      forgeDrafterRuntime,
      forgeAuditorRuntime,

      openrouterApiKey,
      openrouterBaseUrl,
      openrouterModel,
      openrouterProviderPreferences,

      geminiApiKey,
      geminiModel: parseTrimmedString(env, 'GEMINI_MODEL') ?? 'gemini-2.5-pro',

      codexBin: parseTrimmedString(env, 'CODEX_BIN') ?? 'codex',
      codexModel: parseTrimmedString(env, 'CODEX_MODEL') ?? 'gpt-5.4',
      codexDangerouslyBypassApprovalsAndSandbox: parseBoolean(env, 'CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX', false),
      codexDisableSessions: parseBoolean(env, 'CODEX_DISABLE_SESSIONS', false),
      codexVerbosePreview: parseBoolean(env, 'DISCOCLAW_CODEX_VERBOSE_PREVIEW', false),
      codexItemTypeDebug: parseBoolean(env, 'DISCOCLAW_CODEX_ITEM_TYPE_DEBUG', false),

      coldStorageEnabled,
      coldStorageProvider,
      coldStorageApiKey,
      coldStorageModel: parseTrimmedString(env, 'COLD_STORAGE_MODEL'),
      coldStorageDimensions: (() => {
        const raw = parseTrimmedString(env, 'COLD_STORAGE_DIMENSIONS');
        if (raw == null) return 1536;
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          throw new Error(`COLD_STORAGE_DIMENSIONS must be a positive integer, got "${raw}"`);
        }
        return n;
      })(),
      coldStorageBaseUrl: parseTrimmedString(env, 'COLD_STORAGE_BASE_URL'),
      coldStorageDbPath: parseTrimmedString(env, 'COLD_STORAGE_DB_PATH'),
      coldStorageChannelFilter: (() => {
        const raw = parseTrimmedString(env, 'COLD_STORAGE_CHANNEL_FILTER');
        if (!raw) return [];
        return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      })(),
      coldStorageInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_COLD_STORAGE_INJECT_MAX_CHARS', 1500),
      coldStorageSearchLimit: parsePositiveInt(env, 'DISCOCLAW_COLD_STORAGE_SEARCH_LIMIT', 10),
      coldStorageHydeEnabled: parseBoolean(env, 'DISCOCLAW_COLD_STORAGE_HYDE_ENABLED', true),
      coldStorageHydeModel: parseTrimmedString(env, 'COLD_STORAGE_HYDE_MODEL'),

      summaryToDurableEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED', true),
      shortTermMemoryEnabled: parseBoolean(env, 'DISCOCLAW_SHORTTERM_MEMORY_ENABLED', true),
      shortTermMaxEntries: parsePositiveInt(env, 'DISCOCLAW_SHORTTERM_MAX_ENTRIES', 20),
      shortTermMaxAgeHours: parsePositiveNumber(env, 'DISCOCLAW_SHORTTERM_MAX_AGE_HOURS', 6),
      shortTermInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS', 1000),
      shortTermDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_SHORTTERM_DATA_DIR'),
      actionFollowupDepth: parseNonNegativeInt(env, 'DISCOCLAW_ACTION_FOLLOWUP_DEPTH', 2),

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
      cronExecModel: parseTrimmedString(env, 'DISCOCLAW_CRON_EXEC_MODEL') ?? 'capable',
      cronStatsDirOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_STATS_DIR'),
      cronTagMapPathOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_TAG_MAP'),

      workspaceCwdOverride: parseTrimmedString(env, 'WORKSPACE_CWD'),
      groupsDirOverride: parseTrimmedString(env, 'GROUPS_DIR'),
      useGroupDirCwd: parseBoolean(env, 'USE_GROUP_DIR_CWD', false),

      webhookEnabled,
      webhookPort,
      webhookConfigPath,
      dashboardEnabled,
      dashboardPort,
      dashboardTrustedHosts,

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
      streamPreviewRaw: parseBoolean(env, 'DISCOCLAW_STREAM_PREVIEW_RAW', false),
      multiTurn: parseBoolean(env, 'DISCOCLAW_MULTI_TURN', true),
      multiTurnHangTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS', 60000),
      multiTurnIdleTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS', 300000),
      multiTurnMaxProcesses: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_MAX_PROCESSES', 5),
      streamStallTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_TIMEOUT_MS', 1800000),
      progressStallTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS', 1800000),
      streamStallWarningMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_WARNING_MS', 300000),
      maxConcurrentInvocations: parseNonNegativeInt(env, 'DISCOCLAW_MAX_CONCURRENT_INVOCATIONS', 0),
      debugRuntime: parseBoolean(env, 'DISCOCLAW_DEBUG_RUNTIME', false),
      debugStreamPreviewLines: parseBoolean(env, 'DISCOCLAW_DEBUG_STREAM_PREVIEW_LINES', false),

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
