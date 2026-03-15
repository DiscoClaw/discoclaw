import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveDiscordChannelContext, validatePaContextModules, loadDiscordChannelContext, ensureIndexedDiscordChannelContext } from './discord/channel-context.js';

describe('resolveDiscordChannelContext', () => {
  it('returns no contextPath for unknown guild channels (strict mode can require indexing)', () => {
    const ctx = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      paContextFiles: ['/.context/pa.md'],
      channelsDir: '/content/discord/channels',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/channels/dm.md',
    };
    const res = resolveDiscordChannelContext({ ctx, isDm: false, channelId: '1', threadParentId: null });
    expect(res.contextPath).toBeUndefined();
  });

  it('uses dm context for DMs', () => {
    const ctx = {
      contentDir: '/content',
      indexPath: '/content/discord/DISCORD.md',
      paContextFiles: ['/.context/pa.md'],
      channelsDir: '/content/discord/channels',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/channels/dm.md',
    };
    const res = resolveDiscordChannelContext({ ctx, isDm: true, channelId: 'dmchan', threadParentId: null });
    expect(res.contextPath).toBe('/content/discord/channels/dm.md');
  });
});

describe('validatePaContextModules', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('throws when pa.md is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-validate-'));
    tempDirs.push(dir);
    // Create only pa-safety.md, omit pa.md.
    await fs.writeFile(path.join(dir, 'pa-safety.md'), '# Safety', 'utf-8');

    await expect(validatePaContextModules(dir)).rejects.toThrow(/pa\.md/);
  });

  it('throws when contextModulesDir does not exist', async () => {
    await expect(validatePaContextModules('/nonexistent/path')).rejects.toThrow();
  });

  it('succeeds when all modules are present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-validate-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'pa.md'), '# PA', 'utf-8');

    await expect(validatePaContextModules(dir)).resolves.toBeUndefined();
  });
});

describe('loadDiscordChannelContext', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('populates paContextFiles with correct paths', async () => {
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-load-'));
    const contextModulesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-modules-'));
    tempDirs.push(contentDir, contextModulesDir);
    await fs.writeFile(path.join(contextModulesDir, 'pa.md'), '# PA', 'utf-8');
    await fs.mkdir(path.join(contentDir, 'discord', 'channels'), { recursive: true });

    const ctx = await loadDiscordChannelContext({ contentDir, contextModulesDir });

    expect(ctx.paContextFiles).toHaveLength(1);
    expect(ctx.paContextFiles[0]).toBe(path.join(contextModulesDir, 'pa.md'));
  });
});

describe('channelContextTemplate regression', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('new channel files do not contain Includes or ../base/', async () => {
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-template-'));
    const contextModulesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-modules-'));
    tempDirs.push(contentDir, contextModulesDir);
    await fs.writeFile(path.join(contextModulesDir, 'pa.md'), '# PA', 'utf-8');
    await fs.writeFile(path.join(contextModulesDir, 'pa-safety.md'), '# Safety', 'utf-8');
    await fs.mkdir(path.join(contentDir, 'discord', 'channels'), { recursive: true });

    const ctx = await loadDiscordChannelContext({ contentDir, contextModulesDir });

    const entry = await ensureIndexedDiscordChannelContext({
      ctx,
      channelId: '12345678901234567890',
      channelName: 'test-channel',
    });

    const content = await fs.readFile(entry.contextPath, 'utf-8');
    expect(content).not.toContain('Includes');
    expect(content).not.toContain('../base/');
  });
});
