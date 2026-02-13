import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureWorkspaceBootstrapFiles, isOnboardingComplete } from './workspace-bootstrap.js';

const ALL_TEMPLATE_FILES = [
  'BOOTSTRAP.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
];

/** Template files scaffolded when onboarding is complete (no BOOTSTRAP.md). */
const POST_ONBOARD_FILES = ALL_TEMPLATE_FILES.filter(f => f !== 'BOOTSTRAP.md');

describe('isOnboardingComplete', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('returns false when IDENTITY.md does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });

  it('returns false when IDENTITY.md is near-empty (template placeholder)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# Identity\n', 'utf-8');
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });

  it('returns true when IDENTITY.md has real content', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(
      path.join(workspace, 'IDENTITY.md'),
      '# Identity\n\nName: Claw\nVibe: Snarky but helpful\nEmoji: 🦀\nCreature: A sentient crustacean AI',
      'utf-8',
    );
    expect(await isOnboardingComplete(workspace)).toBe(true);
  });
});

describe('ensureWorkspaceBootstrapFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('scaffolds all template files into an empty workspace (fresh onboarding)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created.sort()).toEqual([...ALL_TEMPLATE_FILES].sort());
    for (const file of ALL_TEMPLATE_FILES) {
      const content = await fs.readFile(path.join(workspace, file), 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('does not overwrite existing files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // Pre-populate SOUL.md with custom content.
    const customContent = '# My custom soul';
    await fs.writeFile(path.join(workspace, 'SOUL.md'), customContent, 'utf-8');

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    // SOUL.md should NOT be in the created list.
    expect(created).not.toContain('SOUL.md');
    // Custom content should be preserved.
    const soul = await fs.readFile(path.join(workspace, 'SOUL.md'), 'utf-8');
    expect(soul).toBe(customContent);
    // Other files should be scaffolded.
    expect(created).toContain('BOOTSTRAP.md');
    expect(created).toContain('IDENTITY.md');
  });

  it('creates workspace directory if it does not exist', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(parent);
    const workspace = path.join(parent, 'nested', 'workspace');

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created.length).toBe(ALL_TEMPLATE_FILES.length);
    const stat = await fs.stat(workspace);
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates memory/ directory for daily logs', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await ensureWorkspaceBootstrapFiles(workspace);

    const stat = await fs.stat(path.join(workspace, 'memory'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('returns empty array when all files already exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // First run — scaffolds everything.
    await ensureWorkspaceBootstrapFiles(workspace);
    // Second run — nothing to do.
    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created).toEqual([]);
  });

  it('skips BOOTSTRAP.md scaffolding when onboarding is complete', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // Simulate completed onboarding: IDENTITY.md has real content.
    await fs.writeFile(
      path.join(workspace, 'IDENTITY.md'),
      '# Identity\n\nName: Claw\nVibe: Snarky but helpful\nEmoji: 🦀\nCreature: A sentient crustacean AI',
      'utf-8',
    );

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created).not.toContain('BOOTSTRAP.md');
    // BOOTSTRAP.md should not exist on disk.
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
    // Other files should still be scaffolded.
    expect(created).toContain('SOUL.md');
  });

  it('auto-deletes stale BOOTSTRAP.md when onboarding is complete', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // First run — scaffolds everything including BOOTSTRAP.md.
    await ensureWorkspaceBootstrapFiles(workspace);
    expect(await fs.access(path.join(workspace, 'BOOTSTRAP.md')).then(() => true)).toBe(true);

    // Simulate completed onboarding: write real content to IDENTITY.md.
    await fs.writeFile(
      path.join(workspace, 'IDENTITY.md'),
      '# Identity\n\nName: Claw\nVibe: Snarky but helpful\nEmoji: 🦀\nCreature: A sentient crustacean AI',
      'utf-8',
    );

    // Second run — should auto-delete BOOTSTRAP.md.
    const log = { info: vi.fn() };
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('auto-deleted stale BOOTSTRAP.md'),
    );
  });
});
