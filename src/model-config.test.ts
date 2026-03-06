import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULTS,
  loadModelConfig,
  saveModelConfig,
  resolveModelsJsonPath,
  migrateFromLegacy,
  loadLegacyOverrideModels,
} from './model-config.js';
import type { ModelConfig, ModelRole } from './model-config.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'model-config-'));
}

// ---------------------------------------------------------------------------
// resolveModelsJsonPath
// ---------------------------------------------------------------------------

describe('resolveModelsJsonPath', () => {
  it('uses configured data dir when provided', () => {
    expect(resolveModelsJsonPath('/var/lib/discoclaw', '/repo')).toBe(
      path.join('/var/lib/discoclaw', 'models.json'),
    );
  });

  it('falls back to <projectRoot>/data when data dir is empty string', () => {
    expect(resolveModelsJsonPath('', '/repo')).toBe(path.join('/repo', 'data', 'models.json'));
  });

  it('falls back to <projectRoot>/data when data dir is undefined', () => {
    expect(resolveModelsJsonPath(undefined, '/repo')).toBe(
      path.join('/repo', 'data', 'models.json'),
    );
  });
});

// ---------------------------------------------------------------------------
// loadModelConfig
// ---------------------------------------------------------------------------

describe('loadModelConfig', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns missing when file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const result = await loadModelConfig(path.join(dir, 'models.json'));
    expect(result).toEqual({ status: 'missing' });
  });

  it('loads a valid config', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    await fs.writeFile(filePath, JSON.stringify({ chat: 'opus', fast: 'haiku' }));

    const result = await loadModelConfig(filePath);
    expect(result).toEqual({ status: 'loaded', config: { chat: 'opus', fast: 'haiku' } });
  });

  it('skips non-string values', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    await fs.writeFile(filePath, JSON.stringify({ chat: 'opus', fast: 42, bad: null }));

    const result = await loadModelConfig(filePath);
    expect(result).toEqual({ status: 'loaded', config: { chat: 'opus' } });
  });

  it('returns corrupt and warns on invalid JSON', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    await fs.writeFile(filePath, '{not valid json!!!');

    const onWarn = vi.fn();
    const result = await loadModelConfig(filePath, onWarn);

    expect(result.status).toBe('corrupt');
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toMatch(/corrupt JSON/);
  });

  it('returns corrupt when root is an array', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    await fs.writeFile(filePath, JSON.stringify(['not', 'an', 'object']));

    const onWarn = vi.fn();
    const result = await loadModelConfig(filePath, onWarn);

    expect(result.status).toBe('corrupt');
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toMatch(/not an object/);
  });

  it('backs up corrupt file with timestamp suffix', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    await fs.writeFile(filePath, 'garbage');

    await loadModelConfig(filePath);

    // Original should be gone (renamed to backup)
    await expect(fs.access(filePath)).rejects.toThrow();

    // A backup file should exist
    const files = await fs.readdir(dir);
    const backups = files.filter((f) => f.startsWith('models.json.corrupt.'));
    expect(backups).toHaveLength(1);

    // Backup contains the original content
    const backupContent = await fs.readFile(path.join(dir, backups[0]!), 'utf-8');
    expect(backupContent).toBe('garbage');
  });
});

// ---------------------------------------------------------------------------
// saveModelConfig
// ---------------------------------------------------------------------------

describe('saveModelConfig', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('writes config and reads it back', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');
    const config: ModelConfig = { chat: 'sonnet', fast: 'haiku' };

    await saveModelConfig(filePath, config);

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(config);
  });

  it('creates parent directories', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'subdir', 'models.json');

    await saveModelConfig(filePath, { chat: 'opus' });

    const result = await loadModelConfig(filePath);
    expect(result).toEqual({ status: 'loaded', config: { chat: 'opus' } });
  });

  it('overwrites existing file atomically', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'models.json');

    await saveModelConfig(filePath, { chat: 'old' });
    await saveModelConfig(filePath, { chat: 'new', fast: 'haiku' });

    const result = await loadModelConfig(filePath);
    expect(result).toEqual({ status: 'loaded', config: { chat: 'new', fast: 'haiku' } });
  });
});

// ---------------------------------------------------------------------------
// migrateFromLegacy
// ---------------------------------------------------------------------------

describe('migrateFromLegacy', () => {
  it('merges env defaults with override models', () => {
    const envConfig: Partial<Record<ModelRole, string>> = { chat: 'capable', fast: 'fast' };
    const overrides = { chat: 'opus', 'cron-exec': 'sonnet' };

    const result = migrateFromLegacy(envConfig, overrides);

    expect(result).toEqual({ chat: 'opus', fast: 'fast', 'cron-exec': 'sonnet' });
  });

  it('returns env defaults when no overrides', () => {
    const envConfig: Partial<Record<ModelRole, string>> = { chat: 'capable', fast: 'fast' };
    const result = migrateFromLegacy(envConfig, {});
    expect(result).toEqual({ chat: 'capable', fast: 'fast' });
  });

  it('returns overrides only when env defaults are empty', () => {
    const result = migrateFromLegacy({}, { chat: 'opus' });
    expect(result).toEqual({ chat: 'opus' });
  });

  it('override wins for same role', () => {
    const result = migrateFromLegacy({ chat: 'capable' }, { chat: 'opus' });
    expect(result.chat).toBe('opus');
  });
});

// ---------------------------------------------------------------------------
// loadLegacyOverrideModels
// ---------------------------------------------------------------------------

describe('loadLegacyOverrideModels', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns empty record when file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const result = await loadLegacyOverrideModels(path.join(dir, 'runtime-overrides.json'));
    expect(result).toEqual({});
  });

  it('returns empty record on corrupt JSON', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, 'not json');

    const result = await loadLegacyOverrideModels(filePath);
    expect(result).toEqual({});
  });

  it('returns empty record when no models key', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ ttsVoice: 'alloy' }));

    const result = await loadLegacyOverrideModels(filePath);
    expect(result).toEqual({});
  });

  it('extracts models map from valid file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        models: { chat: 'opus', fast: 'haiku' },
        ttsVoice: 'alloy',
      }),
    );

    const result = await loadLegacyOverrideModels(filePath);
    expect(result).toEqual({ chat: 'opus', fast: 'haiku' });
  });

  it('skips non-string values in models map', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({ models: { chat: 'opus', bad: 42, nope: null } }),
    );

    const result = await loadLegacyOverrideModels(filePath);
    expect(result).toEqual({ chat: 'opus' });
  });

  it('returns empty record when models is an array', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ models: ['not', 'a', 'map'] }));

    const result = await loadLegacyOverrideModels(filePath);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

describe('DEFAULTS', () => {
  it('has expected default tiers for all 8 roles', () => {
    expect(DEFAULTS.chat).toBe('capable');
    expect(DEFAULTS.fast).toBe('fast');
    expect(DEFAULTS.summary).toBe('fast');
    expect(DEFAULTS['forge-drafter']).toBe('capable');
    expect(DEFAULTS['forge-auditor']).toBe('capable');
    expect(DEFAULTS.cron).toBe('fast');
    expect(DEFAULTS['cron-exec']).toBe('capable');
    expect(DEFAULTS.voice).toBe('capable');
  });
});
