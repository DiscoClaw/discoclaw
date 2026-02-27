import { describe, expect, it } from 'vitest';
import {
  parseConfig,
  DEFAULT_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT,
  DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS,
} from './config.js';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'token',
    DISCORD_ALLOW_USER_IDS: '123',
    // Provide valid snowflakes for forums that are enabled by default.
    DISCOCLAW_CRON_FORUM: '1000000000000000001',
    DISCOCLAW_TASKS_FORUM: '1000000000000000002',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('parses required fields and defaults', () => {
    const { config, warnings, infos } = parseConfig(env());
    expect(config.token).toBe('token');
    expect(config.allowUserIds.has('123')).toBe(true);
    expect(config.allowBotIds).toEqual(new Set());
    expect(config.botMessageMemoryWriteEnabled).toBe(false);
    expect(config.primaryRuntime).toBe('claude');
    expect(config.runtimeModel).toBe('capable');
    expect(config.summaryModel).toBe('fast');
    expect(config.cronModel).toBe('fast');
    expect(config.cronAutoTagModel).toBe('fast');
    expect(config.cronExecModel).toBe('capable');
    expect(config.tasksAutoTagModel).toBe('fast');
    expect(config.tasksSyncFailureRetryEnabled).toBe(true);
    expect(config.tasksSyncFailureRetryDelayMs).toBe(30_000);
    expect(config.tasksSyncDeferredRetryDelayMs).toBe(30_000);
    expect(config.outputFormat).toBe('text');
    expect(config.serviceName).toBe('discoclaw');
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(false);
  });

  // --- allowBotIds ---
  it('defaults allowBotIds to empty set', () => {
    const { config } = parseConfig(env());
    expect(config.allowBotIds).toEqual(new Set());
  });

  it('parses DISCORD_ALLOW_BOT_IDS as a set of snowflakes', () => {
    const { config } = parseConfig(env({ DISCORD_ALLOW_BOT_IDS: '111, 222 333' }));
    expect(config.allowBotIds).toEqual(new Set(['111', '222', '333']));
  });

  it('drops non-numeric tokens from DISCORD_ALLOW_BOT_IDS', () => {
    const { config } = parseConfig(env({ DISCORD_ALLOW_BOT_IDS: 'mybot 999' }));
    expect(config.allowBotIds).toEqual(new Set(['999']));
  });

  it('returns empty set for allowBotIds when DISCORD_ALLOW_BOT_IDS is undefined', () => {
    const { config } = parseConfig(env({ DISCORD_ALLOW_BOT_IDS: undefined }));
    expect(config.allowBotIds).toEqual(new Set());
  });

  // --- botMessageMemoryWriteEnabled ---
  it('defaults botMessageMemoryWriteEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.botMessageMemoryWriteEnabled).toBe(false);
  });

  it('sets botMessageMemoryWriteEnabled to true when DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE=true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE: 'true' }));
    expect(config.botMessageMemoryWriteEnabled).toBe(true);
  });

  it('sets botMessageMemoryWriteEnabled to true when DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE=1', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE: '1' }));
    expect(config.botMessageMemoryWriteEnabled).toBe(true);
  });

  it('leaves botMessageMemoryWriteEnabled false when DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE=false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE: 'false' }));
    expect(config.botMessageMemoryWriteEnabled).toBe(false);
  });

  it('emits a warning when DISCORD_ALLOW_BOT_IDS is set but yields no valid IDs', () => {
    const { warnings } = parseConfig(env({ DISCORD_ALLOW_BOT_IDS: 'not-a-snowflake' }));
    expect(warnings.some((w) => w.includes('DISCORD_ALLOW_BOT_IDS was set but no valid IDs were parsed'))).toBe(true);
  });

  it('throws on invalid boolean values', () => {
    expect(() => parseConfig(env({ DISCOCLAW_SUMMARY_ENABLED: 'yes' })))
      .toThrow(/DISCOCLAW_SUMMARY_ENABLED must be "0"\/"1" or "true"\/"false"/);
  });

  it('parses true/false booleans', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SUMMARY_ENABLED: 'false', DISCOCLAW_CRON_ENABLED: 'true' }));
    expect(config.summaryEnabled).toBe(false);
    expect(config.cronEnabled).toBe(true);
  });

  it('throws on invalid numeric values', () => {
    expect(() => parseConfig(env({ RUNTIME_TIMEOUT_MS: '-1' })))
      .toThrow(/RUNTIME_TIMEOUT_MS must be a positive number/);
  });

  it('warns (does not throw) on unknown runtime tools', () => {
    const { config, warnings } = parseConfig(env({ RUNTIME_TOOLS: 'Read,InvalidTool' }));
    expect(config.runtimeTools).toEqual(['Read', 'InvalidTool']);
    expect(warnings.some((w) => w.includes('RUNTIME_TOOLS includes unknown tools'))).toBe(true);
  });

  it('warns when DISCORD_CHANNEL_IDS has no valid IDs', () => {
    const { warnings } = parseConfig(env({ DISCORD_CHANNEL_IDS: 'abc def' }));
    expect(warnings.some((w) => w.includes('DISCORD_CHANNEL_IDS was set but no valid IDs'))).toBe(true);
  });

  it('parses PRIMARY_RUNTIME and normalizes claude_code alias', () => {
    const { config } = parseConfig(env({ PRIMARY_RUNTIME: 'claude_code' }));
    expect(config.primaryRuntime).toBe('claude');
  });

  it('warns when PRIMARY_RUNTIME=openai without OPENAI_API_KEY', () => {
    const { warnings } = parseConfig(env({ PRIMARY_RUNTIME: 'openai', OPENAI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('PRIMARY_RUNTIME=openai'))).toBe(true);
  });

  it('does not warn about action category flags when master actions are enabled', () => {
    const { warnings, infos } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS: '1' }));
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(false);
  });

  it('defaults discordActionsDefer settings', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsDefer).toBe(true);
    expect(config.deferMaxDelaySeconds).toBe(DEFAULT_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS);
    expect(config.deferMaxConcurrent).toBe(DEFAULT_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT);
  });

  it('parses defer config overrides', () => {
    const { config } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS_DEFER: '1',
      DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS: '900',
      DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT: '2',
    }));
    expect(config.discordActionsDefer).toBe(true);
    expect(config.deferMaxDelaySeconds).toBe(900);
    expect(config.deferMaxConcurrent).toBe(2);
  });

  it('reports ignored action category flags as info-level advisories', () => {
    const { warnings, infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_MESSAGING: '1',
    }));
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(true);
  });

  it('reports ignored defer category flag when master actions off', () => {
    const { infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_DEFER: '1',
    }));
    expect(infos.some((i) => i.includes('DISCOCLAW_DISCORD_ACTIONS_DEFER'))).toBe(true);
  });

  it('parses DISCOCLAW_BOT_NAME when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_NAME: 'Weston' }));
    expect(config.botDisplayName).toBe('Weston');
  });

  it('returns undefined for botDisplayName when DISCOCLAW_BOT_NAME is unset', () => {
    const { config } = parseConfig(env());
    expect(config.botDisplayName).toBeUndefined();
  });

  it('returns undefined for botDisplayName when DISCOCLAW_BOT_NAME is whitespace-only', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_NAME: '   ' }));
    expect(config.botDisplayName).toBeUndefined();
  });

  // --- Bot profile: status ---
  it('parses valid bot status values', () => {
    for (const status of ['online', 'idle', 'dnd', 'invisible'] as const) {
      const { config } = parseConfig(env({ DISCOCLAW_BOT_STATUS: status }));
      expect(config.botStatus).toBe(status);
    }
  });

  it('parses bot status case-insensitively', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_STATUS: 'DND' }));
    expect(config.botStatus).toBe('dnd');
  });

  it('throws on invalid bot status', () => {
    expect(() => parseConfig(env({ DISCOCLAW_BOT_STATUS: 'away' })))
      .toThrow(/DISCOCLAW_BOT_STATUS must be one of online\|idle\|dnd\|invisible/);
  });

  it('returns undefined for botStatus when unset', () => {
    const { config } = parseConfig(env());
    expect(config.botStatus).toBeUndefined();
  });

  // --- Bot profile: activity type ---
  it('defaults botActivityType to Playing', () => {
    const { config } = parseConfig(env());
    expect(config.botActivityType).toBe('Playing');
  });

  it('parses activity type case-insensitively', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_ACTIVITY_TYPE: 'listening' }));
    expect(config.botActivityType).toBe('Listening');
  });

  it('throws on invalid activity type', () => {
    expect(() => parseConfig(env({ DISCOCLAW_BOT_ACTIVITY_TYPE: 'Streaming' })))
      .toThrow(/DISCOCLAW_BOT_ACTIVITY_TYPE must be one of Playing\|Listening\|Watching\|Competing\|Custom/);
  });

  // --- Bot profile: avatar ---
  it('accepts absolute file path for botAvatar', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_AVATAR: '/home/user/avatar.png' }));
    expect(config.botAvatar).toBe('/home/user/avatar.png');
  });

  it('accepts https URL for botAvatar', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_AVATAR: 'https://example.com/avatar.png' }));
    expect(config.botAvatar).toBe('https://example.com/avatar.png');
  });

  it('accepts http URL for botAvatar', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BOT_AVATAR: 'http://example.com/avatar.png' }));
    expect(config.botAvatar).toBe('http://example.com/avatar.png');
  });

  it('rejects relative path for botAvatar', () => {
    expect(() => parseConfig(env({ DISCOCLAW_BOT_AVATAR: 'images/avatar.png' })))
      .toThrow('DISCOCLAW_BOT_AVATAR must be an absolute file path or URL');
  });

  it('returns undefined for botAvatar when unset', () => {
    const { config } = parseConfig(env());
    expect(config.botAvatar).toBeUndefined();
  });

  // --- Bot profile: action flag ---
  it('defaults discordActionsBotProfile to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsBotProfile).toBe(true);
  });

  it('defaults discordActionsPlan to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsPlan).toBe(true);
  });

  it('defaults discordActionsEnabled to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsEnabled).toBe(true);
  });

  it('defaults discordActionsMessaging to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsMessaging).toBe(true);
  });

  it('defaults discordActionsGuild to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsGuild).toBe(true);
  });

  it('defaults discordActionsPolls to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsPolls).toBe(true);
  });

  it('defaults discordActionsMemory to true', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsMemory).toBe(true);
  });

  it('defaults discordActionsImagegen to false', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsImagegen).toBe(false);
  });

  it('enables discordActionsImagegen when DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1', () => {
    const { config } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '1' }));
    expect(config.discordActionsImagegen).toBe(true);
  });

  it('reports ignored imagegen category flag when master actions off', () => {
    const { infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '1',
    }));
    expect(infos.some((i) => i.includes('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN'))).toBe(true);
  });

  it('warns when discordActionsImagegen is enabled but neither key is set', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '1', OPENAI_API_KEY: undefined, IMAGEGEN_GEMINI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1'))).toBe(true);
  });

  it('does not warn about imagegen key when OPENAI_API_KEY is set', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '1', OPENAI_API_KEY: 'sk-test', IMAGEGEN_GEMINI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1'))).toBe(false);
  });

  it('does not warn about imagegen key when IMAGEGEN_GEMINI_API_KEY is set', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '1', OPENAI_API_KEY: undefined, IMAGEGEN_GEMINI_API_KEY: 'gemini-key' }));
    expect(warnings.some((w) => w.includes('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1'))).toBe(false);
  });

  it('does not warn about imagegen key when discordActionsImagegen is disabled', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN: '0', OPENAI_API_KEY: undefined, IMAGEGEN_GEMINI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1'))).toBe(false);
  });

  it('parses IMAGEGEN_GEMINI_API_KEY when set', () => {
    const { config } = parseConfig(env({ IMAGEGEN_GEMINI_API_KEY: 'gemini-key' }));
    expect(config.imagegenGeminiApiKey).toBe('gemini-key');
  });

  it('returns undefined for imagegenGeminiApiKey when unset', () => {
    const { config } = parseConfig(env());
    expect(config.imagegenGeminiApiKey).toBeUndefined();
  });

  it('parses IMAGEGEN_DEFAULT_MODEL when set', () => {
    const { config } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'imagen-4.0-generate-002', IMAGEGEN_GEMINI_API_KEY: 'gemini-key' }));
    expect(config.imagegenDefaultModel).toBe('imagen-4.0-generate-002');
  });

  it('returns undefined for imagegenDefaultModel when unset', () => {
    const { config } = parseConfig(env());
    expect(config.imagegenDefaultModel).toBeUndefined();
  });

  it('warns when IMAGEGEN_DEFAULT_MODEL is an imagen-* model but IMAGEGEN_GEMINI_API_KEY is unset', () => {
    const { warnings } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'imagen-4.0-generate-002', IMAGEGEN_GEMINI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('IMAGEGEN_DEFAULT_MODEL') && w.includes('IMAGEGEN_GEMINI_API_KEY'))).toBe(true);
  });

  it('warns when IMAGEGEN_DEFAULT_MODEL is a dall-e-* model but OPENAI_API_KEY is unset', () => {
    const { warnings } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'dall-e-3', OPENAI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('IMAGEGEN_DEFAULT_MODEL') && w.includes('OPENAI_API_KEY'))).toBe(true);
  });

  it('warns when IMAGEGEN_DEFAULT_MODEL is a gpt-image-* model but OPENAI_API_KEY is unset', () => {
    const { warnings } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'gpt-image-1', OPENAI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('IMAGEGEN_DEFAULT_MODEL') && w.includes('OPENAI_API_KEY'))).toBe(true);
  });

  it('does not warn about IMAGEGEN_DEFAULT_MODEL when imagen-* and IMAGEGEN_GEMINI_API_KEY is set', () => {
    const { warnings } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'imagen-4.0-generate-002', IMAGEGEN_GEMINI_API_KEY: 'gemini-key' }));
    expect(warnings.some((w) => w.includes('IMAGEGEN_DEFAULT_MODEL'))).toBe(false);
  });

  it('does not warn about IMAGEGEN_DEFAULT_MODEL when dall-e-* and OPENAI_API_KEY is set', () => {
    const { warnings } = parseConfig(env({ IMAGEGEN_DEFAULT_MODEL: 'dall-e-3', OPENAI_API_KEY: 'sk-test' }));
    expect(warnings.some((w) => w.includes('IMAGEGEN_DEFAULT_MODEL'))).toBe(false);
  });

  it('defaults sessionScanning to true', () => {
    const { config } = parseConfig(env());
    expect(config.sessionScanning).toBe(true);
  });

  it('defaults toolAwareStreaming to true', () => {
    const { config } = parseConfig(env());
    expect(config.toolAwareStreaming).toBe(true);
  });

  it('defaults cronAutoTag to true', () => {
    const { config } = parseConfig(env());
    expect(config.cronAutoTag).toBe(true);
  });

  it('defaults autoJoinThreads to true', () => {
    const { config } = parseConfig(env());
    expect(config.autoJoinThreads).toBe(true);
  });

  it('reports ignored bot profile action flag when master actions off', () => {
    const { infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE: '1',
    }));
    expect(infos.some((i) => i.includes('DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE'))).toBe(true);
  });

  // --- FORGE_DRAFTER_RUNTIME ---
  it('returns undefined for forgeDrafterRuntime when unset', () => {
    const { config } = parseConfig(env());
    expect(config.forgeDrafterRuntime).toBeUndefined();
  });

  it('parses FORGE_DRAFTER_RUNTIME=openai', () => {
    const { config } = parseConfig(env({ FORGE_DRAFTER_RUNTIME: 'openai', OPENAI_API_KEY: 'sk-test' }));
    expect(config.forgeDrafterRuntime).toBe('openai');
  });

  it('normalizes FORGE_DRAFTER_RUNTIME claude_code to claude', () => {
    const { config } = parseConfig(env({ FORGE_DRAFTER_RUNTIME: 'claude_code' }));
    expect(config.forgeDrafterRuntime).toBe('claude');
  });

  it('warns when FORGE_DRAFTER_RUNTIME=openai without OPENAI_API_KEY', () => {
    const { warnings } = parseConfig(env({ FORGE_DRAFTER_RUNTIME: 'openai', OPENAI_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('FORGE_DRAFTER_RUNTIME=openai'))).toBe(true);
  });

  // --- OpenRouter adapter ---
  it('parses OPENROUTER_API_KEY when set', () => {
    const { config } = parseConfig(env({ OPENROUTER_API_KEY: 'sk-or-test' }));
    expect(config.openrouterApiKey).toBe('sk-or-test');
  });

  it('defaults openrouterModel to "anthropic/claude-sonnet-4"', () => {
    const { config } = parseConfig(env());
    expect(config.openrouterModel).toBe('anthropic/claude-sonnet-4');
  });

  it('warns when PRIMARY_RUNTIME=openrouter without OPENROUTER_API_KEY', () => {
    const { warnings } = parseConfig(env({ PRIMARY_RUNTIME: 'openrouter', OPENROUTER_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('PRIMARY_RUNTIME=openrouter'))).toBe(true);
  });

  it('warns when FORGE_DRAFTER_RUNTIME=openrouter without OPENROUTER_API_KEY', () => {
    const { warnings } = parseConfig(env({ FORGE_DRAFTER_RUNTIME: 'openrouter', OPENROUTER_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('FORGE_DRAFTER_RUNTIME=openrouter'))).toBe(true);
  });

  it('warns when FORGE_AUDITOR_RUNTIME=openrouter without OPENROUTER_API_KEY', () => {
    const { warnings } = parseConfig(env({ FORGE_AUDITOR_RUNTIME: 'openrouter', OPENROUTER_API_KEY: undefined }));
    expect(warnings.some((w) => w.includes('FORGE_AUDITOR_RUNTIME=openrouter'))).toBe(true);
  });

  // --- Forge auto-implement ---
  it('defaults forgeAutoImplement to true', () => {
    const { config } = parseConfig(env());
    expect(config.forgeAutoImplement).toBe(true);
  });

  it('parses FORGE_AUTO_IMPLEMENT=0 as false', () => {
    const { config } = parseConfig(env({ FORGE_AUTO_IMPLEMENT: '0' }));
    expect(config.forgeAutoImplement).toBe(false);
  });

  it('parses FORGE_AUTO_IMPLEMENT=true as true', () => {
    const { config } = parseConfig(env({ FORGE_AUTO_IMPLEMENT: 'true' }));
    expect(config.forgeAutoImplement).toBe(true);
  });

  // --- Summary-to-durable ---
  it('defaults summaryToDurableEnabled to true', () => {
    const { config } = parseConfig(env());
    expect(config.summaryToDurableEnabled).toBe(true);
  });

  it('parses DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED: '1' }));
    expect(config.summaryToDurableEnabled).toBe(true);
  });

  // --- Short-term memory ---
  it('defaults shortTermMemoryEnabled to true', () => {
    const { config } = parseConfig(env());
    expect(config.shortTermMemoryEnabled).toBe(true);
  });

  it('parses short-term memory config fields', () => {
    const { config } = parseConfig(env({
      DISCOCLAW_SHORTTERM_MEMORY_ENABLED: '1',
      DISCOCLAW_SHORTTERM_MAX_ENTRIES: '10',
      DISCOCLAW_SHORTTERM_MAX_AGE_HOURS: '12',
      DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS: '500',
    }));
    expect(config.shortTermMemoryEnabled).toBe(true);
    expect(config.shortTermMaxEntries).toBe(10);
    expect(config.shortTermMaxAgeHours).toBe(12);
    expect(config.shortTermInjectMaxChars).toBe(500);
  });

  it('parses DISCOCLAW_SHORTTERM_MEMORY_ENABLED=0 as false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SHORTTERM_MEMORY_ENABLED: '0' }));
    expect(config.shortTermMemoryEnabled).toBe(false);
  });

  it('uses default values for short-term memory fields', () => {
    const { config } = parseConfig(env());
    expect(config.shortTermMaxEntries).toBe(20);
    expect(config.shortTermMaxAgeHours).toBe(6);
    expect(config.shortTermInjectMaxChars).toBe(1000);
  });

  // --- Tasks enabled ---
  it('defaults tasksEnabled to true', () => {
    const { config } = parseConfig(env());
    expect(config.tasksEnabled).toBe(true);
  });

  // --- Tasks sidebar ---
  it('defaults tasksSidebar to true', () => {
    const { config } = parseConfig(env());
    expect(config.tasksSidebar).toBe(true);
  });

  it('parses DISCOCLAW_TASKS_SIDEBAR=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TASKS_SIDEBAR: '1' }));
    expect(config.tasksSidebar).toBe(true);
  });

  // --- Fallback model ---
  it('parses RUNTIME_FALLBACK_MODEL when set', () => {
    const { config } = parseConfig(env({ RUNTIME_FALLBACK_MODEL: 'sonnet' }));
    expect(config.runtimeFallbackModel).toBe('sonnet');
  });

  it('returns undefined for runtimeFallbackModel when unset', () => {
    const { config } = parseConfig(env());
    expect(config.runtimeFallbackModel).toBeUndefined();
  });

  // --- Max budget USD ---
  it('parses RUNTIME_MAX_BUDGET_USD positive number', () => {
    const { config } = parseConfig(env({ RUNTIME_MAX_BUDGET_USD: '5.00' }));
    expect(config.runtimeMaxBudgetUsd).toBe(5);
  });

  it('returns undefined for runtimeMaxBudgetUsd when unset', () => {
    const { config } = parseConfig(env());
    expect(config.runtimeMaxBudgetUsd).toBeUndefined();
  });

  it('throws on RUNTIME_MAX_BUDGET_USD=0', () => {
    expect(() => parseConfig(env({ RUNTIME_MAX_BUDGET_USD: '0' })))
      .toThrow(/RUNTIME_MAX_BUDGET_USD must be a positive number/);
  });

  it('throws on RUNTIME_MAX_BUDGET_USD negative', () => {
    expect(() => parseConfig(env({ RUNTIME_MAX_BUDGET_USD: '-1' })))
      .toThrow(/RUNTIME_MAX_BUDGET_USD must be a positive number/);
  });

  it('throws on RUNTIME_MAX_BUDGET_USD non-numeric', () => {
    expect(() => parseConfig(env({ RUNTIME_MAX_BUDGET_USD: 'abc' })))
      .toThrow(/RUNTIME_MAX_BUDGET_USD must be a positive number/);
  });

  // --- Append system prompt ---
  it('parses CLAUDE_APPEND_SYSTEM_PROMPT when set', () => {
    const { config } = parseConfig(env({ CLAUDE_APPEND_SYSTEM_PROMPT: 'You are Weston.' }));
    expect(config.appendSystemPrompt).toBe('You are Weston.');
  });

  it('returns undefined for appendSystemPrompt when unset', () => {
    const { config } = parseConfig(env());
    expect(config.appendSystemPrompt).toBeUndefined();
  });

  it('throws when CLAUDE_APPEND_SYSTEM_PROMPT exceeds 4000 chars', () => {
    expect(() => parseConfig(env({ CLAUDE_APPEND_SYSTEM_PROMPT: 'x'.repeat(4001) })))
      .toThrow(/CLAUDE_APPEND_SYSTEM_PROMPT exceeds 4000 char limit/);
  });

  it('accepts CLAUDE_APPEND_SYSTEM_PROMPT at exactly 4000 chars', () => {
    const { config } = parseConfig(env({ CLAUDE_APPEND_SYSTEM_PROMPT: 'x'.repeat(4000) }));
    expect(config.appendSystemPrompt).toHaveLength(4000);
  });

  // --- Default tools include Glob, Grep, Write ---
  it('default RUNTIME_TOOLS includes Glob, Grep, Write', () => {
    const { config } = parseConfig(env());
    expect(config.runtimeTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
  });

  // --- Reaction remove handler ---
  it('defaults reactionRemoveHandlerEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.reactionRemoveHandlerEnabled).toBe(false);
  });

  it('parses DISCOCLAW_REACTION_REMOVE_HANDLER=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_REACTION_REMOVE_HANDLER: '1' }));
    expect(config.reactionRemoveHandlerEnabled).toBe(true);
  });

  // --- Gemini CLI adapter ---
  it('defaults geminiBin to "gemini"', () => {
    const { config } = parseConfig(env());
    expect(config.geminiBin).toBe('gemini');
  });

  it('parses GEMINI_BIN when set', () => {
    const { config } = parseConfig(env({ GEMINI_BIN: '/usr/local/bin/gemini' }));
    expect(config.geminiBin).toBe('/usr/local/bin/gemini');
  });

  it('defaults geminiModel to "gemini-2.5-pro"', () => {
    const { config } = parseConfig(env());
    expect(config.geminiModel).toBe('gemini-2.5-pro');
  });

  it('parses GEMINI_MODEL when set', () => {
    const { config } = parseConfig(env({ GEMINI_MODEL: 'gemini-2.0-flash' }));
    expect(config.geminiModel).toBe('gemini-2.0-flash');
  });

  it('does not warn when PRIMARY_RUNTIME=gemini (no preflight-checkable auth)', () => {
    const { warnings } = parseConfig(env({ PRIMARY_RUNTIME: 'gemini' }));
    expect(warnings.some((w) => w.includes('gemini'))).toBe(false);
  });

  // --- Codex dangerous bypass ---
  it('defaults codexDangerouslyBypassApprovalsAndSandbox to false', () => {
    const { config } = parseConfig(env());
    expect(config.codexDangerouslyBypassApprovalsAndSandbox).toBe(false);
  });

  it('parses CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX=1 as true', () => {
    const { config } = parseConfig(env({ CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX: '1' }));
    expect(config.codexDangerouslyBypassApprovalsAndSandbox).toBe(true);
  });

  it('defaults codexDisableSessions to false', () => {
    const { config } = parseConfig(env());
    expect(config.codexDisableSessions).toBe(false);
  });

  it('parses CODEX_DISABLE_SESSIONS=1 as true', () => {
    const { config } = parseConfig(env({ CODEX_DISABLE_SESSIONS: '1' }));
    expect(config.codexDisableSessions).toBe(true);
  });

  // --- Forum ID validation (auto-create when missing, warn on invalid) ---
  it('allows missing cronForum when cronEnabled (bootstrap will auto-create)', () => {
    const { config } = parseConfig(env({ DISCOCLAW_CRON_ENABLED: '1', DISCOCLAW_CRON_FORUM: undefined }));
    expect(config.cronEnabled).toBe(true);
    expect(config.cronForum).toBeUndefined();
  });

  it('warns and clears cronForum when not a snowflake', () => {
    const { config, warnings } = parseConfig(env({ DISCOCLAW_CRON_ENABLED: '1', DISCOCLAW_CRON_FORUM: 'crons' }));
    expect(config.cronForum).toBeUndefined();
    expect(warnings.some(w => w.includes('DISCOCLAW_CRON_FORUM is not a valid snowflake'))).toBe(true);
  });

  it('accepts valid snowflake for cronForum when cronEnabled=true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_CRON_ENABLED: '1', DISCOCLAW_CRON_FORUM: '1000000000000000002' }));
    expect(config.cronForum).toBe('1000000000000000002');
    expect(config.cronEnabled).toBe(true);
  });

  it('does not validate cronForum when cronEnabled=false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_CRON_ENABLED: '0' }));
    expect(config.cronEnabled).toBe(false);
  });

  it('DISCOCLAW_CRON_EXEC_MODEL overrides cronExecModel default', () => {
    const { config } = parseConfig(env({ DISCOCLAW_CRON_EXEC_MODEL: 'fast' }));
    expect(config.cronExecModel).toBe('fast');
  });

  it('allows missing tasksForum when tasksEnabled (bootstrap will auto-create)', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TASKS_ENABLED: '1', DISCOCLAW_TASKS_FORUM: undefined }));
    expect(config.tasksEnabled).toBe(true);
    expect(config.tasksForum).toBeUndefined();
  });

  it('warns and clears tasksForum when not a snowflake', () => {
    const { config, warnings } = parseConfig(env({ DISCOCLAW_TASKS_ENABLED: '1', DISCOCLAW_TASKS_FORUM: 'tasks' }));
    expect(config.tasksForum).toBeUndefined();
    expect(warnings.some(w => w.includes('DISCOCLAW_TASKS_FORUM is not a valid snowflake'))).toBe(true);
  });

  it('accepts valid snowflake for tasksForum when tasksEnabled=true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TASKS_ENABLED: '1', DISCOCLAW_TASKS_FORUM: '1000000000000000002' }));
    expect(config.tasksForum).toBe('1000000000000000002');
    expect(config.tasksEnabled).toBe(true);
  });

  it('does not validate tasksForum when tasksEnabled=false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TASKS_ENABLED: '0' }));
    expect(config.tasksEnabled).toBe(false);
  });

  it('parses DISCOCLAW_TASKS_* vars', () => {
    const { config } = parseConfig(env({
      DISCOCLAW_TASKS_ENABLED: '0',
      DISCOCLAW_TASKS_FORUM: '1000000000000000009',
      DISCOCLAW_TASKS_CWD: '/tmp/tasks',
      DISCOCLAW_TASKS_TAG_MAP: '/tmp/tasks/tag-map.json',
      DISCOCLAW_TASKS_MENTION_USER: '123456789012345678',
      DISCOCLAW_TASKS_SIDEBAR: '1',
      DISCOCLAW_TASKS_AUTO_TAG: '0',
      DISCOCLAW_TASKS_AUTO_TAG_MODEL: 'fast',
      DISCOCLAW_TASKS_PREFIX: 'dev',
      DISCOCLAW_TASKS_SYNC_SKIP_PHASE5: '1',
      DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED: '0',
      DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS: '12000',
      DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS: '18000',
    }));

    expect(config.tasksEnabled).toBe(false);
    expect(config.tasksForum).toBe('1000000000000000009');
    expect(config.tasksCwdOverride).toBe('/tmp/tasks');
    expect(config.tasksTagMapPathOverride).toBe('/tmp/tasks/tag-map.json');
    expect(config.tasksMentionUser).toBe('123456789012345678');
    expect(config.tasksSidebar).toBe(true);
    expect(config.tasksAutoTag).toBe(false);
    expect(config.tasksAutoTagModel).toBe('fast');
    expect(config.tasksPrefix).toBe('dev');
    expect(config.tasksSyncSkipPhase5).toBe(true);
    expect(config.tasksSyncFailureRetryEnabled).toBe(false);
    expect(config.tasksSyncFailureRetryDelayMs).toBe(12000);
    expect(config.tasksSyncDeferredRetryDelayMs).toBe(18000);
  });

  it('rejects non-positive task sync retry delay values', () => {
    expect(() => parseConfig(env({ DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS: '0' })))
      .toThrow(/DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS must be a positive number/);
    expect(() => parseConfig(env({ DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS: '-1' })))
      .toThrow(/DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS must be a positive number/);
  });

  // --- Verbose CLI flag ---
  it('CLAUDE_VERBOSE defaults to false', () => {
    const { config } = parseConfig(env());
    expect(config.verbose).toBe(false);
  });

  it('CLAUDE_VERBOSE=1 sets verbose to true with stream-json', () => {
    const { config } = parseConfig(env({ CLAUDE_VERBOSE: '1', CLAUDE_OUTPUT_FORMAT: 'stream-json' }));
    expect(config.verbose).toBe(true);
  });

  it('CLAUDE_VERBOSE=1 is auto-disabled when outputFormat=text', () => {
    const { config, warnings } = parseConfig(env({ CLAUDE_VERBOSE: '1', CLAUDE_OUTPUT_FORMAT: 'text' }));
    expect(config.verbose).toBe(false);
    expect(warnings).toContainEqual(
      expect.stringContaining('CLAUDE_VERBOSE=1 ignored'),
    );
  });

  it('CLAUDE_VERBOSE=1 is allowed when outputFormat=stream-json', () => {
    const { config, warnings } = parseConfig(env({ CLAUDE_VERBOSE: '1', CLAUDE_OUTPUT_FORMAT: 'stream-json' }));
    expect(config.verbose).toBe(true);
    expect(warnings).not.toContainEqual(
      expect.stringContaining('CLAUDE_VERBOSE=1 ignored'),
    );
  });

  it('CLAUDE_VERBOSE=1 is auto-disabled when outputFormat defaults to text', () => {
    const { config, warnings } = parseConfig(env({ CLAUDE_VERBOSE: '1' }));
    // outputFormat defaults to 'text', so verbose should be auto-disabled
    expect(config.verbose).toBe(false);
    expect(warnings).toContainEqual(
      expect.stringContaining('CLAUDE_VERBOSE=1 ignored'),
    );
  });

  // --- Stream stall detection ---
  it('defaults streamStallTimeoutMs to 600000', () => {
    const { config } = parseConfig(env());
    expect(config.streamStallTimeoutMs).toBe(600000);
  });

  it('defaults streamStallWarningMs to 300000', () => {
    const { config } = parseConfig(env());
    expect(config.streamStallWarningMs).toBe(300000);
  });

  it('parses custom streamStallTimeoutMs', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STREAM_STALL_TIMEOUT_MS: '30000' }));
    expect(config.streamStallTimeoutMs).toBe(30000);
  });

  it('parses custom streamStallWarningMs', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STREAM_STALL_WARNING_MS: '15000' }));
    expect(config.streamStallWarningMs).toBe(15000);
  });

  it('accepts 0 for streamStallTimeoutMs (disables feature)', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STREAM_STALL_TIMEOUT_MS: '0' }));
    expect(config.streamStallTimeoutMs).toBe(0);
  });

  it('accepts 0 for streamStallWarningMs (disables feature)', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STREAM_STALL_WARNING_MS: '0' }));
    expect(config.streamStallWarningMs).toBe(0);
  });

  // --- Progress stall detection ---
  it('defaults progressStallTimeoutMs to 300000', () => {
    const { config } = parseConfig(env());
    expect(config.progressStallTimeoutMs).toBe(300000);
  });

  it('parses custom progressStallTimeoutMs', () => {
    const { config } = parseConfig(env({ DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS: '60000' }));
    expect(config.progressStallTimeoutMs).toBe(60000);
  });

  it('accepts 0 for progressStallTimeoutMs (disables feature)', () => {
    const { config } = parseConfig(env({ DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS: '0' }));
    expect(config.progressStallTimeoutMs).toBe(0);
  });

  // --- Webhook ---
  it('defaults webhookEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.webhookEnabled).toBe(false);
  });

  it('parses DISCOCLAW_WEBHOOK_ENABLED=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_WEBHOOK_ENABLED: '1' }));
    expect(config.webhookEnabled).toBe(true);
  });

  it('defaults webhookPort to 9400', () => {
    const { config } = parseConfig(env());
    expect(config.webhookPort).toBe(9400);
  });

  it('parses DISCOCLAW_WEBHOOK_PORT when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_WEBHOOK_PORT: '8765' }));
    expect(config.webhookPort).toBe(8765);
  });

  it('throws on DISCOCLAW_WEBHOOK_PORT=0 (non-positive)', () => {
    expect(() => parseConfig(env({ DISCOCLAW_WEBHOOK_PORT: '0' })))
      .toThrow(/DISCOCLAW_WEBHOOK_PORT must be a positive number/);
  });

  it('throws on DISCOCLAW_WEBHOOK_PORT=-1 (negative)', () => {
    expect(() => parseConfig(env({ DISCOCLAW_WEBHOOK_PORT: '-1' })))
      .toThrow(/DISCOCLAW_WEBHOOK_PORT must be a positive number/);
  });

  it('throws on DISCOCLAW_WEBHOOK_PORT=3000.5 (non-integer)', () => {
    expect(() => parseConfig(env({ DISCOCLAW_WEBHOOK_PORT: '3000.5' })))
      .toThrow(/DISCOCLAW_WEBHOOK_PORT must be an integer/);
  });

  it('returns undefined for webhookConfigPath when DISCOCLAW_WEBHOOK_CONFIG is unset', () => {
    const { config } = parseConfig(env());
    expect(config.webhookConfigPath).toBeUndefined();
  });

  it('parses DISCOCLAW_WEBHOOK_CONFIG when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_WEBHOOK_CONFIG: '/etc/discoclaw/webhooks.json' }));
    expect(config.webhookConfigPath).toBe('/etc/discoclaw/webhooks.json');
  });

  // --- serviceName ---
  it('defaults serviceName to "discoclaw"', () => {
    const { config } = parseConfig(env());
    expect(config.serviceName).toBe('discoclaw');
  });

  it('parses DISCOCLAW_SERVICE_NAME when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SERVICE_NAME: 'discoclaw-dev' }));
    expect(config.serviceName).toBe('discoclaw-dev');
  });

  it('returns default serviceName when DISCOCLAW_SERVICE_NAME is whitespace-only', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SERVICE_NAME: '   ' }));
    expect(config.serviceName).toBe('discoclaw');
  });

  // --- Voice config ---
  it('defaults voiceEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.voiceEnabled).toBe(false);
  });

  it('parses DISCOCLAW_VOICE_ENABLED=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '1', DEEPGRAM_API_KEY: 'dg-key', CARTESIA_API_KEY: 'ca-key' }));
    expect(config.voiceEnabled).toBe(true);
  });

  it('defaults voiceSttProvider to "deepgram"', () => {
    const { config } = parseConfig(env());
    expect(config.voiceSttProvider).toBe('deepgram');
  });

  it('parses DISCOCLAW_STT_PROVIDER=whisper', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STT_PROVIDER: 'whisper' }));
    expect(config.voiceSttProvider).toBe('whisper');
  });

  it('parses STT provider case-insensitively', () => {
    const { config } = parseConfig(env({ DISCOCLAW_STT_PROVIDER: 'Deepgram' }));
    expect(config.voiceSttProvider).toBe('deepgram');
  });

  it('throws on invalid STT provider', () => {
    expect(() => parseConfig(env({ DISCOCLAW_STT_PROVIDER: 'invalid' })))
      .toThrow(/DISCOCLAW_STT_PROVIDER must be one of deepgram\|whisper/);
  });

  it('defaults voiceTtsProvider to "cartesia"', () => {
    const { config } = parseConfig(env());
    expect(config.voiceTtsProvider).toBe('cartesia');
  });

  it('parses DISCOCLAW_TTS_PROVIDER=kokoro', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TTS_PROVIDER: 'kokoro' }));
    expect(config.voiceTtsProvider).toBe('kokoro');
  });

  it('parses TTS provider case-insensitively', () => {
    const { config } = parseConfig(env({ DISCOCLAW_TTS_PROVIDER: 'Cartesia' }));
    expect(config.voiceTtsProvider).toBe('cartesia');
  });

  it('throws on invalid TTS provider', () => {
    expect(() => parseConfig(env({ DISCOCLAW_TTS_PROVIDER: 'elevenlabs' })))
      .toThrow(/DISCOCLAW_TTS_PROVIDER must be one of cartesia\|deepgram\|kokoro\|openai/);
  });

  it('parses DISCOCLAW_VOICE_HOME_CHANNEL when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_HOME_CHANNEL: 'voice-log' }));
    expect(config.voiceHomeChannel).toBe('voice-log');
  });

  it('falls back to DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL with deprecation warning', () => {
    const { config, warnings } = parseConfig(env({ DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL: 'legacy-ch' }));
    expect(config.voiceHomeChannel).toBe('legacy-ch');
    expect(warnings).toContain('DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL is deprecated; use DISCOCLAW_VOICE_HOME_CHANNEL instead.');
  });

  it('prefers DISCOCLAW_VOICE_HOME_CHANNEL over legacy TRANSCRIPT_CHANNEL', () => {
    const { config, warnings } = parseConfig(env({
      DISCOCLAW_VOICE_HOME_CHANNEL: 'new-ch',
      DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL: 'old-ch',
    }));
    expect(config.voiceHomeChannel).toBe('new-ch');
    expect(warnings).not.toContain('DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL is deprecated; use DISCOCLAW_VOICE_HOME_CHANNEL instead.');
  });

  it('returns undefined for voiceHomeChannel when unset', () => {
    const { config } = parseConfig(env());
    expect(config.voiceHomeChannel).toBeUndefined();
  });

  it('parses DISCOCLAW_VOICE_LOG_CHANNEL when set', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_LOG_CHANNEL: 'voice-log' }));
    expect(config.voiceLogChannel).toBe('voice-log');
  });

  it('returns undefined for voiceLogChannel when unset', () => {
    const { config } = parseConfig(env());
    expect(config.voiceLogChannel).toBeUndefined();
  });

  it('parses DEEPGRAM_API_KEY when set', () => {
    const { config } = parseConfig(env({ DEEPGRAM_API_KEY: 'dg-key' }));
    expect(config.deepgramApiKey).toBe('dg-key');
  });

  it('returns undefined for deepgramApiKey when unset', () => {
    const { config } = parseConfig(env());
    expect(config.deepgramApiKey).toBeUndefined();
  });

  it('parses CARTESIA_API_KEY when set', () => {
    const { config } = parseConfig(env({ CARTESIA_API_KEY: 'ca-key' }));
    expect(config.cartesiaApiKey).toBe('ca-key');
  });

  it('returns undefined for cartesiaApiKey when unset', () => {
    const { config } = parseConfig(env());
    expect(config.cartesiaApiKey).toBeUndefined();
  });

  it('warns when voice enabled with deepgram STT but DEEPGRAM_API_KEY missing', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '1', CARTESIA_API_KEY: 'ca-key' }));
    expect(warnings.some((w) => w.includes('DEEPGRAM_API_KEY'))).toBe(true);
  });

  it('does not warn about DEEPGRAM_API_KEY when voice disabled', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '0' }));
    expect(warnings.some((w) => w.includes('DEEPGRAM_API_KEY'))).toBe(false);
  });

  it('does not warn about DEEPGRAM_API_KEY when STT provider is whisper', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '1', DISCOCLAW_STT_PROVIDER: 'whisper', CARTESIA_API_KEY: 'ca-key' }));
    expect(warnings.some((w) => w.includes('DEEPGRAM_API_KEY'))).toBe(false);
  });

  // --- voiceAutoJoin ---
  it('defaults voiceAutoJoin to false', () => {
    const { config } = parseConfig(env());
    expect(config.voiceAutoJoin).toBe(false);
  });

  it('parses DISCOCLAW_VOICE_AUTO_JOIN=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_AUTO_JOIN: '1' }));
    expect(config.voiceAutoJoin).toBe(true);
  });

  it('parses DISCOCLAW_VOICE_AUTO_JOIN=true as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_AUTO_JOIN: 'true' }));
    expect(config.voiceAutoJoin).toBe(true);
  });

  it('parses DISCOCLAW_VOICE_AUTO_JOIN=0 as false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_VOICE_AUTO_JOIN: '0' }));
    expect(config.voiceAutoJoin).toBe(false);
  });

  it('warns when voice enabled with cartesia TTS but CARTESIA_API_KEY missing', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '1', DEEPGRAM_API_KEY: 'dg-key' }));
    expect(warnings.some((w) => w.includes('CARTESIA_API_KEY'))).toBe(true);
  });

  it('does not warn about CARTESIA_API_KEY when voice disabled', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '0' }));
    expect(warnings.some((w) => w.includes('CARTESIA_API_KEY'))).toBe(false);
  });

  it('does not warn about CARTESIA_API_KEY when TTS provider is kokoro', () => {
    const { warnings } = parseConfig(env({ DISCOCLAW_VOICE_ENABLED: '1', DISCOCLAW_TTS_PROVIDER: 'kokoro', DEEPGRAM_API_KEY: 'dg-key' }));
    expect(warnings.some((w) => w.includes('CARTESIA_API_KEY'))).toBe(false);
  });
});
