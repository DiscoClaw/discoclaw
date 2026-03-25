import { describe, expect, it, vi } from 'vitest';
import type { DoctorContext } from '../../health/config-doctor.js';
import {
  buildSettingsGetResponse,
  buildSettingsPostResponse,
  validateSettingUpdate,
} from './settings.js';

function makeDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    cwd: '/repo',
    workspaceCwd: '/repo/workspace',
    installMode: 'source',
    env: {},
    explicitEnvKeys: new Set<string>(),
    configPaths: {
      cwd: '/repo',
      env: '/repo/.env',
      dataDir: '/repo/data',
      models: '/repo/data/models.json',
      runtimeOverrides: '/repo/data/runtime-overrides.json',
    },
    defaultDataDir: '/repo/data',
    models: {},
    modelsFile: { exists: false, values: {} },
    runtimeOverrides: {},
    runtimeOverridesFile: {
      exists: false,
      unknownKeys: [],
      raw: {},
      values: {},
    },
    envDefaults: {
      chat: 'capable',
      fast: 'fast',
      summary: 'fast',
      cron: 'fast',
      'cron-exec': 'capable',
      voice: 'capable',
      'forge-drafter': 'capable',
      'forge-auditor': 'deep',
    },
    ...overrides,
  };
}

describe('buildSettingsGetResponse', () => {
  it('returns grouped categories with env values', () => {
    const env: NodeJS.ProcessEnv = {
      DISCOCLAW_CRON_ENABLED: 'false',
      DISCOCLAW_MULTI_TURN: '1',
    };
    const response = buildSettingsGetResponse(env);
    expect(response.ok).toBe(true);
    expect(response.categories).toBeDefined();

    const coreFeatures = response.categories['Core Features'];
    expect(coreFeatures).toBeDefined();
    const cronSetting = coreFeatures.find((s) => s.key === 'DISCOCLAW_CRON_ENABLED');
    expect(cronSetting).toEqual({
      key: 'DISCOCLAW_CRON_ENABLED',
      label: 'Cron scheduler',
      type: 'boolean',
      default: true,
      value: 'false',
    });

    const behavior = response.categories['Behavior'];
    expect(behavior).toBeDefined();
    const multiTurn = behavior.find((s) => s.key === 'DISCOCLAW_MULTI_TURN');
    expect(multiTurn?.value).toBe('1');
  });

  it('returns undefined value for unset keys', () => {
    const response = buildSettingsGetResponse({});
    const coreFeatures = response.categories['Core Features'];
    const cronSetting = coreFeatures.find((s) => s.key === 'DISCOCLAW_CRON_ENABLED');
    expect(cronSetting?.value).toBeUndefined();
  });
});

describe('validateSettingUpdate', () => {
  it('accepts valid boolean values', () => {
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', 'true')).not.toThrow();
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', 'false')).not.toThrow();
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', '1')).not.toThrow();
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', '0')).not.toThrow();
  });

  it('rejects invalid boolean values', () => {
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', 'yes')).toThrow(
      /must be "true"\/"false"/,
    );
  });

  it('accepts valid numeric values', () => {
    const result = validateSettingUpdate('DISCOCLAW_MESSAGE_HISTORY_BUDGET', '5000');
    expect(result.key).toBe('DISCOCLAW_MESSAGE_HISTORY_BUDGET');
    expect(result.value).toBe('5000');
  });

  it('rejects negative numeric values', () => {
    expect(() => validateSettingUpdate('DISCOCLAW_MESSAGE_HISTORY_BUDGET', '-1')).toThrow(
      /non-negative number/,
    );
  });

  it('rejects empty key', () => {
    expect(() => validateSettingUpdate('', 'true')).toThrow('Setting key is required.');
  });

  it('rejects unknown key', () => {
    expect(() => validateSettingUpdate('UNKNOWN_KEY', 'true')).toThrow('Unknown setting key');
  });

  it('rejects empty value', () => {
    expect(() => validateSettingUpdate('DISCOCLAW_CRON_ENABLED', '')).toThrow(
      'Setting value is required.',
    );
  });
});

describe('buildSettingsPostResponse', () => {
  it('persists the setting and returns updated categories', async () => {
    const loadDoctorContext = vi.fn(async () => makeDoctorContext());
    const updateEnvKey = vi.fn(async () => undefined);

    const response = await buildSettingsPostResponse(
      { cwd: '/repo', env: {} },
      { loadDoctorContext, updateEnvKey },
      'DISCOCLAW_CRON_ENABLED',
      'false',
    );

    expect(response.ok).toBe(true);
    expect(response.message).toContain('Updated DISCOCLAW_CRON_ENABLED');
    expect(updateEnvKey).toHaveBeenCalledWith('/repo/.env', 'DISCOCLAW_CRON_ENABLED', 'false');

    const cronSetting = response.categories['Core Features'].find(
      (s) => s.key === 'DISCOCLAW_CRON_ENABLED',
    );
    expect(cronSetting?.value).toBe('false');
  });

  it('throws on invalid input', async () => {
    const loadDoctorContext = vi.fn(async () => makeDoctorContext());
    const updateEnvKey = vi.fn(async () => undefined);

    await expect(
      buildSettingsPostResponse(
        { cwd: '/repo', env: {} },
        { loadDoctorContext, updateEnvKey },
        '',
        'true',
      ),
    ).rejects.toThrow('Setting key is required.');

    expect(updateEnvKey).not.toHaveBeenCalled();
  });
});
