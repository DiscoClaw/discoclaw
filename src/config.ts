import { parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';

export const KNOWN_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);

type ParseResult = {
  config: DiscoclawConfig;
  warnings: string[];
  infos: string[];
};

export type DiscoclawConfig = {
  token: string;
  allowUserIds: Set<string>;
  allowChannelIds: Set<string>;
  restrictChannelIds: boolean;

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
  discordActionsBeads: boolean;
  discordActionsCrons: boolean;
  discordActionsBotProfile: boolean;

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
  forgeCommandsEnabled: boolean;
  forgeMaxAuditRounds: number;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  forgeTimeoutMs: number;
  forgeProgressThrottleMs: number;
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

  beadsEnabled: boolean;
  beadsCwdOverride?: string;
  beadsForum?: string;
  beadsTagMapPathOverride?: string;
  beadsMentionUser?: string;
  beadsSidebar: boolean;
  beadsAutoTag: boolean;
  beadsAutoTagModel: string;

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

  const discordActionsEnabled = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS', false);
  const discordActionsChannels = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_CHANNELS', true);
  const discordActionsMessaging = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MESSAGING', false);
  const discordActionsGuild = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_GUILD', false);
  const discordActionsModeration = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_MODERATION', false);
  const discordActionsPolls = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_POLLS', false);
  const discordActionsBeads = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_BEADS', false);
  const discordActionsCrons = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_CRONS', true);
  const discordActionsBotProfile = parseBoolean(env, 'DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE', false);

  if (!discordActionsEnabled) {
    const enabledCategories = [
      { name: 'DISCOCLAW_DISCORD_ACTIONS_CHANNELS', enabled: discordActionsChannels },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_MESSAGING', enabled: discordActionsMessaging },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_GUILD', enabled: discordActionsGuild },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_MODERATION', enabled: discordActionsModeration },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_POLLS', enabled: discordActionsPolls },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_BEADS', enabled: discordActionsBeads },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_CRONS', enabled: discordActionsCrons },
      { name: 'DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE', enabled: discordActionsBotProfile },
    ]
      .filter((entry) => (env[entry.name] ?? '').trim().length > 0 && entry.enabled)
      .map((entry) => entry.name);
    if (enabledCategories.length > 0) {
      infos.push(`DISCOCLAW_DISCORD_ACTIONS=0; category flags are ignored: ${enabledCategories.join(', ')}`);
    }
  }

  const cronEnabled = parseBoolean(env, 'DISCOCLAW_CRON_ENABLED', true);
  const cronForum = parseTrimmedString(env, 'DISCOCLAW_CRON_FORUM');
  if (cronEnabled && (!cronForum || !/^\d{8,}$/.test(cronForum))) {
    throw new Error('DISCOCLAW_CRON_FORUM must be a Discord channel ID (snowflake) when crons are enabled');
  }

  const beadsEnabled = parseBoolean(env, 'DISCOCLAW_BEADS_ENABLED', true);
  const beadsForum = parseTrimmedString(env, 'DISCOCLAW_BEADS_FORUM');
  if (beadsEnabled && (!beadsForum || !/^\d{8,}$/.test(beadsForum))) {
    throw new Error('DISCOCLAW_BEADS_FORUM must be a Discord channel ID (snowflake) when beads are enabled');
  }

  return {
    config: {
      token,
      allowUserIds,
      allowChannelIds,
      restrictChannelIds,

      runtimeModel: parseTrimmedString(env, 'RUNTIME_MODEL') ?? 'opus',
      runtimeTools: parseRuntimeTools(env, warnings),
      runtimeTimeoutMs: parsePositiveNumber(env, 'RUNTIME_TIMEOUT_MS', 30 * 60_000),
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
      autoJoinThreads: parseBoolean(env, 'DISCORD_AUTO_JOIN_THREADS', false),
      useRuntimeSessions: parseBoolean(env, 'DISCOCLAW_RUNTIME_SESSIONS', true),

      discordActionsEnabled,
      discordActionsChannels,
      discordActionsMessaging,
      discordActionsGuild,
      discordActionsModeration,
      discordActionsPolls,
      discordActionsBeads,
      discordActionsCrons,
      discordActionsBotProfile,

      messageHistoryBudget: parseNonNegativeInt(env, 'DISCOCLAW_MESSAGE_HISTORY_BUDGET', 3000),
      summaryEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_ENABLED', true),
      summaryModel: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_MODEL') ?? 'haiku',
      summaryMaxChars: parseNonNegativeInt(env, 'DISCOCLAW_SUMMARY_MAX_CHARS', 2000),
      summaryEveryNTurns: parsePositiveInt(env, 'DISCOCLAW_SUMMARY_EVERY_N_TURNS', 5),
      summaryDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_SUMMARY_DATA_DIR'),
      durableMemoryEnabled: parseBoolean(env, 'DISCOCLAW_DURABLE_MEMORY_ENABLED', true),
      durableDataDirOverride: parseTrimmedString(env, 'DISCOCLAW_DURABLE_DATA_DIR'),
      durableInjectMaxChars: parsePositiveInt(env, 'DISCOCLAW_DURABLE_INJECT_MAX_CHARS', 2000),
      durableMaxItems: parsePositiveInt(env, 'DISCOCLAW_DURABLE_MAX_ITEMS', 200),
      memoryCommandsEnabled: parseBoolean(env, 'DISCOCLAW_MEMORY_COMMANDS_ENABLED', true),
      planCommandsEnabled: parseBoolean(env, 'DISCOCLAW_PLAN_COMMANDS_ENABLED', true),
      forgeCommandsEnabled: parseBoolean(env, 'DISCOCLAW_FORGE_COMMANDS_ENABLED', true),
      forgeMaxAuditRounds: parsePositiveInt(env, 'FORGE_MAX_AUDIT_ROUNDS', 5),
      forgeDrafterModel: parseTrimmedString(env, 'FORGE_DRAFTER_MODEL'),
      forgeAuditorModel: parseTrimmedString(env, 'FORGE_AUDITOR_MODEL'),
      forgeTimeoutMs: parsePositiveNumber(env, 'FORGE_TIMEOUT_MS', 5 * 60_000),
      forgeProgressThrottleMs: parseNonNegativeInt(env, 'FORGE_PROGRESS_THROTTLE_MS', 3000),
      summaryToDurableEnabled: parseBoolean(env, 'DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED', false),
      shortTermMemoryEnabled: parseBoolean(env, 'DISCOCLAW_SHORTTERM_MEMORY_ENABLED', false),
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
      cronModel: parseTrimmedString(env, 'DISCOCLAW_CRON_MODEL') ?? 'haiku',
      cronAutoTag: parseBoolean(env, 'DISCOCLAW_CRON_AUTO_TAG', false),
      cronAutoTagModel: parseTrimmedString(env, 'DISCOCLAW_CRON_AUTO_TAG_MODEL') ?? 'haiku',
      cronStatsDirOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_STATS_DIR'),
      cronTagMapPathOverride: parseTrimmedString(env, 'DISCOCLAW_CRON_TAG_MAP'),

      workspaceCwdOverride: parseTrimmedString(env, 'WORKSPACE_CWD'),
      groupsDirOverride: parseTrimmedString(env, 'GROUPS_DIR'),
      useGroupDirCwd: parseBoolean(env, 'USE_GROUP_DIR_CWD', false),

      beadsEnabled,
      beadsCwdOverride: parseTrimmedString(env, 'DISCOCLAW_BEADS_CWD'),
      beadsForum,
      beadsTagMapPathOverride: parseTrimmedString(env, 'DISCOCLAW_BEADS_TAG_MAP'),
      beadsMentionUser: parseTrimmedString(env, 'DISCOCLAW_BEADS_MENTION_USER'),
      beadsSidebar: parseBoolean(env, 'DISCOCLAW_BEADS_SIDEBAR', false),
      beadsAutoTag: parseBoolean(env, 'DISCOCLAW_BEADS_AUTO_TAG', true),
      beadsAutoTagModel: parseTrimmedString(env, 'DISCOCLAW_BEADS_AUTO_TAG_MODEL') ?? 'haiku',

      claudeBin: parseTrimmedString(env, 'CLAUDE_BIN') ?? 'claude',
      dangerouslySkipPermissions: parseBoolean(env, 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS', false),
      outputFormat,
      echoStdio: parseBoolean(env, 'CLAUDE_ECHO_STDIO', false),
      verbose: effectiveVerbose,
      claudeDebugFile: parseTrimmedString(env, 'CLAUDE_DEBUG_FILE'),
      strictMcpConfig: parseBoolean(env, 'CLAUDE_STRICT_MCP_CONFIG', true),
      sessionScanning: parseBoolean(env, 'DISCOCLAW_SESSION_SCANNING', false),
      toolAwareStreaming: parseBoolean(env, 'DISCOCLAW_TOOL_AWARE_STREAMING', false),
      multiTurn: parseBoolean(env, 'DISCOCLAW_MULTI_TURN', true),
      multiTurnHangTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS', 60000),
      multiTurnIdleTimeoutMs: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS', 300000),
      multiTurnMaxProcesses: parsePositiveInt(env, 'DISCOCLAW_MULTI_TURN_MAX_PROCESSES', 5),
      streamStallTimeoutMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_TIMEOUT_MS', 120000),
      streamStallWarningMs: parseNonNegativeInt(env, 'DISCOCLAW_STREAM_STALL_WARNING_MS', 60000),
      maxConcurrentInvocations: parseNonNegativeInt(env, 'DISCOCLAW_MAX_CONCURRENT_INVOCATIONS', 0),
      debugRuntime: parseBoolean(env, 'DISCOCLAW_DEBUG_RUNTIME', false),

      healthCommandsEnabled: parseBoolean(env, 'DISCOCLAW_HEALTH_COMMANDS_ENABLED', true),
      healthVerboseAllowlist,

      botDisplayName: parseTrimmedString(env, 'DISCOCLAW_BOT_NAME'),
      botStatus: parseEnum(env, 'DISCOCLAW_BOT_STATUS', ['online', 'idle', 'dnd', 'invisible'] as const),
      botActivity: parseTrimmedString(env, 'DISCOCLAW_BOT_ACTIVITY'),
      botActivityType: parseEnum(env, 'DISCOCLAW_BOT_ACTIVITY_TYPE', ['Playing', 'Listening', 'Watching', 'Competing', 'Custom'] as const, 'Playing'),
      botAvatar: parseAvatarPath(env, 'DISCOCLAW_BOT_AVATAR'),
    },
    warnings,
    infos,
  };
}
