import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskData } from '../tasks/types.js';

import { loadWorkspacePaFiles, loadWorkspaceMemoryFile, loadDailyLogFiles, buildTaskContextSection, buildTaskThreadSection, resolveEffectiveTools, _resetToolsAuditState } from './prompt-common.js';

describe('loadWorkspacePaFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('returns empty array when skip is true', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# ID', 'utf-8');

    const files = await loadWorkspacePaFiles(workspace, { skip: true });
    expect(files).toEqual([]);
  });

  it('returns PA files when skip is false', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# ID', 'utf-8');

    const files = await loadWorkspacePaFiles(workspace, { skip: false });
    expect(files).toEqual([
      path.join(workspace, 'SOUL.md'),
      path.join(workspace, 'IDENTITY.md'),
    ]);
  });

  it('returns PA files when opts is omitted', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'USER.md'), '# User', 'utf-8');

    const files = await loadWorkspacePaFiles(workspace);
    expect(files).toEqual([path.join(workspace, 'USER.md')]);
  });

  it('includes BOOTSTRAP.md before PA files when onboarding is incomplete', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), '# Bootstrap', 'utf-8');
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    // No IDENTITY.md with real content — onboarding incomplete.

    const files = await loadWorkspacePaFiles(workspace);
    expect(files[0]).toBe(path.join(workspace, 'BOOTSTRAP.md'));
    expect(files[1]).toBe(path.join(workspace, 'SOUL.md'));
  });

  it('excludes BOOTSTRAP.md when onboarding is complete', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), '# Bootstrap', 'utf-8');
    await fs.writeFile(path.join(workspace, 'SOUL.md'), '# Soul', 'utf-8');
    // IDENTITY.md with real content — onboarding complete.
    await fs.writeFile(
      path.join(workspace, 'IDENTITY.md'),
      '# Identity\n\nName: Claw\nVibe: Snarky but helpful\nEmoji: 🦀\nCreature: A sentient crustacean AI',
      'utf-8',
    );
    // USER.md with real content — required for onboarding complete.
    await fs.writeFile(
      path.join(workspace, 'USER.md'),
      '# USER.md - About Your Human\n\n- **Name:** Test User\n- **What to call them:** Test\n',
      'utf-8',
    );

    const files = await loadWorkspacePaFiles(workspace);
    expect(files).not.toContainEqual(expect.stringContaining('BOOTSTRAP.md'));
    expect(files).toContainEqual(expect.stringContaining('SOUL.md'));
    expect(files).toContainEqual(expect.stringContaining('IDENTITY.md'));
  });
});

describe('loadWorkspaceMemoryFile', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('returns path when MEMORY.md exists', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'MEMORY.md'), '# Memory', 'utf-8');

    const result = await loadWorkspaceMemoryFile(workspace);
    expect(result).toBe(path.join(workspace, 'MEMORY.md'));
  });

  it('returns null when MEMORY.md does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadWorkspaceMemoryFile(workspace);
    expect(result).toBeNull();
  });
});

describe('loadDailyLogFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function dateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  it('returns today and yesterday log paths when both exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    const memDir = path.join(workspace, 'memory');
    await fs.mkdir(memDir, { recursive: true });

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    await fs.writeFile(path.join(memDir, dateStr(today) + '.md'), 'today', 'utf-8');
    await fs.writeFile(path.join(memDir, dateStr(yesterday) + '.md'), 'yesterday', 'utf-8');

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([
      path.join(memDir, dateStr(today) + '.md'),
      path.join(memDir, dateStr(yesterday) + '.md'),
    ]);
  });

  it('returns only today when yesterday does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);
    const memDir = path.join(workspace, 'memory');
    await fs.mkdir(memDir, { recursive: true });

    const today = new Date();
    await fs.writeFile(path.join(memDir, dateStr(today) + '.md'), 'today', 'utf-8');

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([path.join(memDir, dateStr(today) + '.md')]);
  });

  it('returns empty array when no daily logs exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([]);
  });

  it('returns empty array when memory dir does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-test-'));
    dirs.push(workspace);

    const result = await loadDailyLogFiles(workspace);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTaskContextSection
// ---------------------------------------------------------------------------

function makeBead(overrides: Partial<TaskData> = {}): TaskData {
  return { id: 'ws-042', title: 'Fix auth bug', status: 'in_progress', ...overrides };
}

describe('buildTaskContextSection', () => {
  it('formats all fields as JSON', () => {
    const bead = makeBead({
      priority: 2,
      owner: 'David',
      labels: ['bug', 'auth'],
      description: 'Users are getting 401 errors on login.',
    });
    const section = buildTaskContextSection(bead);
    expect(section).toContain('```json');
    const json = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
    expect(json.id).toBe('ws-042');
    expect(json.title).toBe('Fix auth bug');
    expect(json.status).toBe('in_progress');
    expect(json.priority).toBe(2);
    expect(json.owner).toBe('David');
    expect(json.labels).toEqual(['bug', 'auth']);
    expect(json.description).toBe('Users are getting 401 errors on login.');
  });

  it('handles missing optional fields', () => {
    const bead = makeBead(); // no priority, owner, labels, description
    const section = buildTaskContextSection(bead);
    const json = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
    expect(json.id).toBe('ws-042');
    expect(json.priority).toBeUndefined();
    expect(json.owner).toBeUndefined();
    expect(json.labels).toBeUndefined();
    expect(json.description).toBeUndefined();
  });

  it('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(600);
    const bead = makeBead({ description: longDesc });
    const section = buildTaskContextSection(bead);
    const json = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
    expect(json.description.length).toBe(500);
    expect(json.description).toMatch(/\u2026$/);
  });

  it('includes forum sendMessage guidance for active beads', () => {
    const bead = makeBead();
    const section = buildTaskContextSection(bead);
    expect(section).toContain('Do not emit a sendMessage action targeting the parent forum channel');
  });

  it('omits forum sendMessage guidance for closed beads', () => {
    const bead = makeBead({ status: 'closed' });
    const section = buildTaskContextSection(bead);
    expect(section).not.toContain('Do not emit a sendMessage action targeting the parent forum channel');
  });

  it('emits minimal context for closed beads', () => {
    const bead = makeBead({
      status: 'closed',
      priority: 1,
      owner: 'David',
      labels: ['bug'],
      description: 'Full description here',
    });
    const section = buildTaskContextSection(bead);
    const json = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
    expect(json.id).toBe('ws-042');
    expect(json.title).toBe('Fix auth bug');
    expect(json.status).toBe('closed');
    // Closed beads should NOT include verbose fields.
    expect(json.priority).toBeUndefined();
    expect(json.owner).toBeUndefined();
    expect(json.labels).toBeUndefined();
    expect(json.description).toBeUndefined();
    // Should include the behavioral hint.
    expect(section).toContain('This task is resolved');
  });
});

// ---------------------------------------------------------------------------
// buildTaskThreadSection
// ---------------------------------------------------------------------------

// Mock the cache so tests can control task lookups deterministically.
vi.mock('../tasks/thread-cache.js', () => ({
  taskThreadCache: {
    get: vi.fn(),
  },
}));

import { taskThreadCache } from '../tasks/thread-cache.js';

const mockedCacheGet = vi.mocked(taskThreadCache.get);

const SNOWFLAKE_FORUM_ID = '12345678901234567890';

function makeBeadCtx(overrides: Partial<{ tasksCwd: string; forumId: string }> = {}) {
  return {
    tasksCwd: '/tmp/beads',
    forumId: SNOWFLAKE_FORUM_ID,
    tagMap: {},
    store: {} as any,
    runtime: {} as any,
    autoTag: false,
    autoTagModel: 'haiku',
    ...overrides,
  };
}

describe('buildTaskThreadSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when not a thread', async () => {
    const result = await buildTaskThreadSection({
      isThread: false,
      threadId: null,
      threadParentId: null,
      taskCtx: makeBeadCtx(),
    });
    expect(result).toBe('');
  });

  it('returns empty string when taskCtx is undefined', async () => {
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: SNOWFLAKE_FORUM_ID,
      taskCtx: undefined,
    });
    expect(result).toBe('');
  });

  it('returns empty string when threadParentId does not match forumId', async () => {
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: '99999999999999999999',
      taskCtx: makeBeadCtx(),
    });
    expect(result).toBe('');
  });

  it('returns empty string when forumId is not a snowflake (logs warning)', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: 'beads',
      taskCtx: makeBeadCtx({ forumId: 'beads' }),
      log,
    });
    expect(result).toBe('');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ forumId: 'beads' }),
      expect.stringContaining('not a snowflake'),
    );
  });

  it('returns formatted section when bead found', async () => {
    mockedCacheGet.mockResolvedValue(makeBead({ priority: 1, owner: 'David' }));
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: SNOWFLAKE_FORUM_ID,
      taskCtx: makeBeadCtx(),
    });
    expect(result).toContain('Task context for this thread');
    expect(result).toContain('```json');
    expect(result).toContain('ws-042');
  });

  it('returns empty string when bead not found', async () => {
    mockedCacheGet.mockResolvedValue(null);
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: SNOWFLAKE_FORUM_ID,
      taskCtx: makeBeadCtx(),
    });
    expect(result).toBe('');
  });

  it('returns empty string when cache throws (graceful degradation)', async () => {
    mockedCacheGet.mockRejectedValue(new Error('bd CLI not available'));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await buildTaskThreadSection({
      isThread: true,
      threadId: 'thread-1',
      threadParentId: SNOWFLAKE_FORUM_ID,
      taskCtx: makeBeadCtx(),
      log,
    });
    expect(result).toBe('');
    expect(log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveTools — fingerprint audit logging
// ---------------------------------------------------------------------------

describe('resolveEffectiveTools audit logging', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    _resetToolsAuditState();
  });

  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function tmpDir() {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-audit-'));
    dirs.push(d);
    return d;
  }

  it('stores fingerprint without warning on first call', async () => {
    const workspace = await tmpDir();
    await fs.writeFile(path.join(workspace, 'PERMISSIONS.json'), '{"tier":"readonly"}');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resolveEffectiveTools({ workspaceCwd: workspace, runtimeTools: ['Bash', 'Read'], log });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('produces no warning when tools are unchanged', async () => {
    const workspace = await tmpDir();
    await fs.writeFile(path.join(workspace, 'PERMISSIONS.json'), '{"tier":"readonly"}');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resolveEffectiveTools({ workspaceCwd: workspace, runtimeTools: ['Bash', 'Read'], log });
    await resolveEffectiveTools({ workspaceCwd: workspace, runtimeTools: ['Bash', 'Read'], log });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when effective tools change between invocations', async () => {
    const workspace = await tmpDir();
    await fs.writeFile(path.join(workspace, 'PERMISSIONS.json'), '{"tier":"readonly"}');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resolveEffectiveTools({ workspaceCwd: workspace, runtimeTools: ['Bash', 'Read'], log });

    // Simulate tier change by rewriting PERMISSIONS.json.
    await fs.writeFile(path.join(workspace, 'PERMISSIONS.json'), '{"tier":"full"}');
    await resolveEffectiveTools({ workspaceCwd: workspace, runtimeTools: ['Bash', 'Read'], log });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('effective tools changed'),
    );
  });

  it('tracks different workspaceCwd values independently', async () => {
    const ws1 = await tmpDir();
    const ws2 = await tmpDir();
    await fs.writeFile(path.join(ws1, 'PERMISSIONS.json'), '{"tier":"readonly"}');
    await fs.writeFile(path.join(ws2, 'PERMISSIONS.json'), '{"tier":"full"}');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resolveEffectiveTools({ workspaceCwd: ws1, runtimeTools: ['Bash', 'Read'], log });
    await resolveEffectiveTools({ workspaceCwd: ws2, runtimeTools: ['Bash', 'Read'], log });

    // Neither should warn — they're different workspaces.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops tools unsupported by runtime capabilities', async () => {
    const workspace = await tmpDir();
    await fs.writeFile(path.join(workspace, 'PERMISSIONS.json'), '{"tier":"full"}');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await resolveEffectiveTools({
      workspaceCwd: workspace,
      runtimeTools: ['Bash', 'Read', 'WebSearch'],
      runtimeCapabilities: new Set(['tools_fs']),
      runtimeId: 'codex',
      log,
    });

    expect(result.effectiveTools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(result.runtimeCapabilityNote).toContain('Bash');
    expect(result.runtimeCapabilityNote).toContain('WebSearch');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'codex',
        droppedTools: expect.arrayContaining(['Bash', 'WebSearch']),
      }),
      expect.stringContaining('dropped unsupported tools'),
    );
  });
});
