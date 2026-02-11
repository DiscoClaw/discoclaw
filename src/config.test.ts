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
});
