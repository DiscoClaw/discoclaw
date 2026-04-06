import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOverrides, normalizeRuntimeOverrides, resolveOverridesPath, saveOverrides } from './runtime-overrides.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-overrides-'));
}

describe('resolveOverridesPath', () => {
  it('uses configured data dir when provided', () => {
    expect(resolveOverridesPath('/var/lib/discoclaw', '/repo')).toBe('/var/lib/discoclaw/runtime-overrides.json');
  });

  it('falls back to <projectRoot>/data when data dir is absent', () => {
    expect(resolveOverridesPath(undefined, '/repo')).toBe('/repo/data/runtime-overrides.json');
  });
});

describe('loadOverrides and saveOverrides', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns empty object when the file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    await expect(loadOverrides(path.join(dir, 'runtime-overrides.json'))).resolves.toEqual({});
  });

  it('round-trips managed runtime overrides', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');

    await saveOverrides(filePath, { voiceRuntime: 'claude-api', fastRuntime: 'codex-cli' });

    await expect(loadOverrides(filePath)).resolves.toEqual({
      voiceRuntime: 'claude-api',
      fastRuntime: 'codex-cli',
    });
  });

  it('drops legacy ttsVoice while preserving unrelated keys', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');

    await fs.writeFile(
      filePath,
      JSON.stringify({ customFlag: true, ttsVoice: 'old-voice', voiceRuntime: 'gemini-api' }),
      'utf-8',
    );

    await saveOverrides(filePath, { fastRuntime: 'codex-cli' });

    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
    expect(raw).toEqual({ customFlag: true, fastRuntime: 'codex-cli' });
  });
});

describe('normalizeRuntimeOverrides', () => {
  it('canonicalizes accepted runtime aliases', () => {
    expect(normalizeRuntimeOverrides({ voiceRuntime: 'Anthropic', fastRuntime: 'claude_code' })).toEqual({
      overrides: { voiceRuntime: 'claude-api', fastRuntime: 'claude-cli' },
      changed: true,
    });
  });

  it('leaves invalid or canonical runtime values unchanged', () => {
    expect(normalizeRuntimeOverrides({ voiceRuntime: 'claude-api', fastRuntime: 'not-a-runtime' })).toEqual({
      overrides: { voiceRuntime: 'claude-api', fastRuntime: 'not-a-runtime' },
      changed: false,
    });
  });
});
