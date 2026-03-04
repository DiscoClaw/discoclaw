import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadWorkspacePermissions, probeWorkspacePermissions, resolveTools, TIER_TOOLS, MAX_NOTE_LENGTH } from './workspace-permissions.js';

describe('loadWorkspacePermissions', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function tmpDir() {
    const p = fs.mkdtemp(path.join(os.tmpdir(), 'ws-perm-'));
    p.then((d) => dirs.push(d));
    return p;
  }

  it('returns null when file is missing', async () => {
    const dir = await tmpDir();
    expect(await loadWorkspacePermissions(dir)).toBeNull();
  });

  it('parses valid standard tier', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"standard"}');
    const result = await loadWorkspacePermissions(dir);
    expect(result).toEqual({ tier: 'standard' });
  });

  it('parses valid custom tier with tools', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      '{"tier":"custom","tools":["Read","Edit"]}',
    );
    const result = await loadWorkspacePermissions(dir);
    expect(result).toEqual({ tier: 'custom', tools: ['Read', 'Edit'] });
  });

  it('preserves optional note field', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      '{"tier":"readonly","note":"No file changes."}',
    );
    const result = await loadWorkspacePermissions(dir);
    expect(result).toEqual({ tier: 'readonly', note: 'No file changes.' });
  });

  it('returns null and warns on invalid JSON', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{{bad');
    const log = { warn: vi.fn() };
    expect(await loadWorkspacePermissions(dir, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('returns null and warns on invalid tier', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"godmode"}');
    const log = { warn: vi.fn() };
    expect(await loadWorkspacePermissions(dir, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('returns null when custom tier lacks tools array', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"custom"}');
    const log = { warn: vi.fn() };
    expect(await loadWorkspacePermissions(dir, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('custom tier with empty tools array parses and warns', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"custom","tools":[]}');
    const log = { warn: vi.fn() };
    const result = await loadWorkspacePermissions(dir, log);
    expect(result).toEqual({ tier: 'custom', tools: [] });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('custom tier with unknown tool names parses and warns', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      '{"tier":"custom","tools":["Read","NotARealTool"]}',
    );
    const log = { warn: vi.fn() };
    const result = await loadWorkspacePermissions(dir, log);
    expect(result).toEqual({ tier: 'custom', tools: ['Read', 'NotARealTool'] });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('omits note exceeding MAX_NOTE_LENGTH and warns', async () => {
    const dir = await tmpDir();
    const longNote = 'x'.repeat(MAX_NOTE_LENGTH + 1);
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      JSON.stringify({ tier: 'readonly', note: longNote }),
    );
    const log = { warn: vi.fn() };
    const result = await loadWorkspacePermissions(dir, log);
    expect(result).toEqual({ tier: 'readonly' });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('preserves note at exactly MAX_NOTE_LENGTH', async () => {
    const dir = await tmpDir();
    const note = 'x'.repeat(MAX_NOTE_LENGTH);
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      JSON.stringify({ tier: 'standard', note }),
    );
    const result = await loadWorkspacePermissions(dir);
    expect(result).toEqual({ tier: 'standard', note });
  });

  it('accepts note containing newlines', async () => {
    const dir = await tmpDir();
    const note = 'line1\nline2\nline3';
    await fs.writeFile(
      path.join(dir, 'PERMISSIONS.json'),
      JSON.stringify({ tier: 'readonly', note }),
    );
    const result = await loadWorkspacePermissions(dir);
    expect(result).toEqual({ tier: 'readonly', note });
  });
});

describe('probeWorkspacePermissions', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function tmpDir() {
    const p = fs.mkdtemp(path.join(os.tmpdir(), 'ws-probe-'));
    p.then((d) => dirs.push(d));
    return p;
  }

  it('returns missing when file does not exist', async () => {
    const dir = await tmpDir();
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'missing' });
  });

  it('returns invalid with reason for bad JSON', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{{bad');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'invalid', reason: 'invalid JSON' });
  });

  it('returns invalid with reason for non-object', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '"just a string"');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'invalid', reason: 'expected object' });
  });

  it('returns invalid with reason for bad tier', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"godmode"}');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'invalid', reason: 'invalid tier: "godmode"' });
  });

  it('returns invalid when custom tier lacks tools array', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"custom"}');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'invalid', reason: 'custom tier requires tools array' });
  });

  it('returns valid with permissions for standard tier', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"standard"}');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'valid', permissions: { tier: 'standard' } });
  });

  it('returns valid with permissions for custom tier', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"custom","tools":["Read","Edit"]}');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'valid', permissions: { tier: 'custom', tools: ['Read', 'Edit'] } });
  });

  it('returns valid with note when present', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'PERMISSIONS.json'), '{"tier":"readonly","note":"No writes."}');
    const result = await probeWorkspacePermissions(dir);
    expect(result).toEqual({ status: 'valid', permissions: { tier: 'readonly', note: 'No writes.' } });
  });
});

describe('resolveTools', () => {
  const envTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Pipeline', 'Step'];

  it('returns env tools when permissions is null', () => {
    expect(resolveTools(null, envTools)).toBe(envTools);
  });

  it('returns correct tools for readonly tier', () => {
    expect(resolveTools({ tier: 'readonly' }, envTools)).toEqual(
      ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    );
  });

  it('returns correct tools for standard tier', () => {
    expect(resolveTools({ tier: 'standard' }, envTools)).toEqual(
      ['Read', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    );
  });

  it('returns correct tools for full tier', () => {
    expect(resolveTools({ tier: 'full' }, envTools)).toEqual(
      ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Pipeline', 'Step'],
    );
  });

  it('uses custom tools array for custom tier', () => {
    const custom = ['Read', 'WebSearch'];
    expect(resolveTools({ tier: 'custom', tools: custom }, envTools)).toEqual(custom);
  });

  it('intersects tier tools with env allowlist', () => {
    const restrictedEnv = ['Read', 'Pipeline'];
    expect(resolveTools({ tier: 'full' }, restrictedEnv)).toEqual(['Read', 'Pipeline']);
  });

  it('intersects custom tools with env allowlist', () => {
    expect(resolveTools({ tier: 'custom', tools: ['Read', 'Write'] }, ['Read'])).toEqual(['Read']);
  });
});
