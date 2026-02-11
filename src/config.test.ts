import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'token',
    DISCORD_ALLOW_USER_IDS: '123',
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

  // --- Reaction remove handler ---
  it('defaults reactionRemoveHandlerEnabled to false', () => {
    const { config } = parseConfig(env());
    expect(config.reactionRemoveHandlerEnabled).toBe(false);
  });

  it('parses DISCOCLAW_REACTION_REMOVE_HANDLER=1 as true', () => {
    const { config } = parseConfig(env({ DISCOCLAW_REACTION_REMOVE_HANDLER: '1' }));
    expect(config.reactionRemoveHandlerEnabled).toBe(true);
  });
});
