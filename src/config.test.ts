import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'token',
    DISCORD_ALLOW_USER_IDS: '123',
    // Provide valid snowflakes for forums that are enabled by default.
    DISCOCLAW_CRON_FORUM: '1000000000000000001',
    DISCOCLAW_BEADS_FORUM: '1000000000000000002',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('parses required fields and defaults', () => {
    const { config, warnings, infos } = parseConfig(env());
    expect(config.token).toBe('token');
    expect(config.allowUserIds.has('123')).toBe(true);
    expect(config.runtimeModel).toBe('opus');
    expect(config.outputFormat).toBe('text');
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(false);
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

  it('does not warn about action category flags when master actions are enabled', () => {
    const { warnings, infos } = parseConfig(env({ DISCOCLAW_DISCORD_ACTIONS: '1' }));
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(false);
  });

  it('reports ignored action category flags as info-level advisories', () => {
    const { warnings, infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_MESSAGING: '1',
    }));
    expect(warnings.some((w) => w.includes('category flags are ignored'))).toBe(false);
    expect(infos.some((i) => i.includes('category flags are ignored'))).toBe(true);
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
  it('defaults discordActionsBotProfile to false', () => {
    const { config } = parseConfig(env());
    expect(config.discordActionsBotProfile).toBe(false);
  });

  it('reports ignored bot profile action flag when master actions off', () => {
    const { infos } = parseConfig(env({
      DISCOCLAW_DISCORD_ACTIONS: '0',
      DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE: '1',
    }));
    expect(infos.some((i) => i.includes('DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE'))).toBe(true);
  });

  // --- Summary-to-durable ---
  it('defaults summaryToDurableEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.summaryToDurableEnabled).toBe(false);
  });

  it('parses DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED: '1' }));
    expect(config.summaryToDurableEnabled).toBe(true);
  });

  // --- Short-term memory ---
  it('defaults shortTermMemoryEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.shortTermMemoryEnabled).toBe(false);
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

  it('uses default values for short-term memory fields', () => {
    const { config } = parseConfig(env());
    expect(config.shortTermMaxEntries).toBe(20);
    expect(config.shortTermMaxAgeHours).toBe(6);
    expect(config.shortTermInjectMaxChars).toBe(1000);
  });

  // --- Beads enabled ---
  it('defaults beadsEnabled to true', () => {
    const { config } = parseConfig(env());
    expect(config.beadsEnabled).toBe(true);
  });

  // --- Beads sidebar ---
  it('defaults beadsSidebar to false', () => {
    const { config } = parseConfig(env());
    expect(config.beadsSidebar).toBe(false);
  });

  it('parses DISCOCLAW_BEADS_SIDEBAR=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BEADS_SIDEBAR: '1' }));
    expect(config.beadsSidebar).toBe(true);
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

  // --- Forum ID validation (snowflake required when subsystem enabled) ---
  it('throws when cronEnabled=true and cronForum is missing', () => {
    expect(() => parseConfig(env({ DISCOCLAW_CRON_ENABLED: '1', DISCOCLAW_CRON_FORUM: undefined })))
      .toThrow('DISCOCLAW_CRON_FORUM must be a Discord channel ID (snowflake) when crons are enabled');
  });

  it('throws when cronEnabled=true and cronForum is not a snowflake', () => {
    expect(() => parseConfig(env({ DISCOCLAW_CRON_ENABLED: '1', DISCOCLAW_CRON_FORUM: 'crons' })))
      .toThrow('DISCOCLAW_CRON_FORUM must be a Discord channel ID (snowflake) when crons are enabled');
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

  it('throws when beadsEnabled=true and beadsForum is missing', () => {
    expect(() => parseConfig(env({ DISCOCLAW_BEADS_ENABLED: '1', DISCOCLAW_BEADS_FORUM: undefined })))
      .toThrow('DISCOCLAW_BEADS_FORUM must be a Discord channel ID (snowflake) when beads are enabled');
  });

  it('throws when beadsEnabled=true and beadsForum is not a snowflake', () => {
    expect(() => parseConfig(env({ DISCOCLAW_BEADS_ENABLED: '1', DISCOCLAW_BEADS_FORUM: 'beads' })))
      .toThrow('DISCOCLAW_BEADS_FORUM must be a Discord channel ID (snowflake) when beads are enabled');
  });

  it('accepts valid snowflake for beadsForum when beadsEnabled=true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BEADS_ENABLED: '1', DISCOCLAW_BEADS_FORUM: '1000000000000000002' }));
    expect(config.beadsForum).toBe('1000000000000000002');
    expect(config.beadsEnabled).toBe(true);
  });

  it('does not validate beadsForum when beadsEnabled=false', () => {
    const { config } = parseConfig(env({ DISCOCLAW_BEADS_ENABLED: '0' }));
    expect(config.beadsEnabled).toBe(false);
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
  it('defaults streamStallTimeoutMs to 120000', () => {
    const { config } = parseConfig(env());
    expect(config.streamStallTimeoutMs).toBe(120000);
  });

  it('defaults streamStallWarningMs to 60000', () => {
    const { config } = parseConfig(env());
    expect(config.streamStallWarningMs).toBe(60000);
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
});
