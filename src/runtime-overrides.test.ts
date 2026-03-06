import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadOverrides,
  resolveOverridesPath,
  saveOverrides,
} from './runtime-overrides.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-overrides-'));
}

describe('resolveOverridesPath', () => {
  it('uses configured data dir when provided', () => {
    const out = resolveOverridesPath('/var/lib/discoclaw', '/repo');
    expect(out).toBe(path.join('/var/lib/discoclaw', 'runtime-overrides.json'));
  });

  it('falls back to <projectRoot>/data when data dir is empty string', () => {
    const out = resolveOverridesPath('', '/repo');
    expect(out).toBe(path.join('/repo', 'data', 'runtime-overrides.json'));
  });

  it('falls back to <projectRoot>/data when data dir is undefined', () => {
    const out = resolveOverridesPath(undefined, '/repo');
    expect(out).toBe(path.join('/repo', 'data', 'runtime-overrides.json'));
  });
});

describe('loadOverrides', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns empty object when file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const result = await loadOverrides(path.join(dir, 'runtime-overrides.json'));
    expect(result).toEqual({});
  });

  it('loads ttsVoice from a valid file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ ttsVoice: 'aura-2-luna-en' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ ttsVoice: 'aura-2-luna-en' });
  });

  it('returns empty object for corrupt JSON and calls onWarn', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, 'not-valid-json', 'utf-8');
    const warnings: string[] = [];
    const result = await loadOverrides(filePath, (msg) => warnings.push(msg));
    expect(result).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/corrupt JSON/);
  });

  it('returns empty object when JSON root is an array and calls onWarn', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify(['opus']), 'utf-8');
    const warnings: string[] = [];
    const result = await loadOverrides(filePath, (msg) => warnings.push(msg));
    expect(result).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not an object/);
  });

  it('returns empty object when JSON root is a primitive and calls onWarn', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify(42), 'utf-8');
    const warnings: string[] = [];
    const result = await loadOverrides(filePath, (msg) => warnings.push(msg));
    expect(result).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not an object/);
  });

  it('silently drops unknown top-level fields (including legacy models key)', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ models: { chat: 'sonnet' }, unknownField: 'x' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('loads ttsVoice field correctly', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ ttsVoice: 'aura-2-asteria-en' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ ttsVoice: 'aura-2-asteria-en' });
  });

  it('silently drops ttsVoice when it is not a string', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ ttsVoice: 42 }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('loads voiceRuntime field correctly', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ voiceRuntime: 'gemini' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ voiceRuntime: 'gemini' });
  });

  it('silently drops voiceRuntime when it is not a string', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ voiceRuntime: 123 }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });
});

describe('saveOverrides', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('writes overrides and reads them back correctly', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { ttsVoice: 'aura-2-asteria-en', voiceRuntime: 'anthropic' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ ttsVoice: 'aura-2-asteria-en', voiceRuntime: 'anthropic' });
  });

  it('writes ttsVoice and reads it back correctly', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { ttsVoice: 'aura-2-asteria-en' });
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ ttsVoice: 'aura-2-asteria-en' });
  });

  it('round-trips ttsVoice + voiceRuntime through save and load', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    const original: import('./runtime-overrides.js').RuntimeOverrides = {
      ttsVoice: 'aura-2-luna-en',
      voiceRuntime: 'gemini',
    };
    await saveOverrides(filePath, original);
    const result = await loadOverrides(filePath);
    expect(result).toEqual(original);
  });

  it('creates the parent directory when it does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'subdir', 'runtime-overrides.json');
    await saveOverrides(filePath, { voiceRuntime: 'anthropic' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ voiceRuntime: 'anthropic' });
  });

  it('leaves no tmp file behind after a successful write', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { ttsVoice: 'aura-2-asteria-en' });
    const files = await fs.readdir(dir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites an existing overrides file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { ttsVoice: 'voice-a' });
    await saveOverrides(filePath, { ttsVoice: 'voice-b' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ ttsVoice: 'voice-b' });
  });

  it('writes an empty overrides object', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, {});
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({});
  });
});
