import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// Spy on unlink for deletion verification and error injection in tests.
// We spy directly on the imported `fs` default object rather than using vi.mock,
// because vi.mock with ESM default imports is fragile.

import { ensureWorkspaceBootstrapFiles, isOnboardingComplete } from './workspace-bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/** Real IDENTITY.md content that passes onboarding check (no template marker). */
const REAL_IDENTITY = '# Identity\n\nName: Claw\nVibe: Snarky but helpful\nEmoji: \u{1F980}\nCreature: A sentient crustacean AI';

/** Real USER.md content that passes onboarding check (no template marker). */
const REAL_USER = '# USER.md - About Your Human\n\n- **Name:** Test User\n- **What to call them:** Test\n';

/** Helper to write both IDENTITY.md and USER.md with real content. */
async function writeOnboardedFiles(workspace: string) {
  await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');
  await fs.writeFile(path.join(workspace, 'USER.md'), REAL_USER, 'utf-8');
}

/** Helper to create a mock logger with info + warn. */
function mockLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

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

  it('returns false when IDENTITY.md still contains template placeholder', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(
      path.join(workspace, 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:**\n  *(pick something you like)*\n- **Creature:**\n',
      'utf-8',
    );
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });

  it('returns false when IDENTITY.md is the untouched scaffolded template', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    // Scaffold files — this copies the real template IDENTITY.md.
    await ensureWorkspaceBootstrapFiles(workspace);
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });

  it('returns true when both IDENTITY.md and USER.md have real content', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await writeOnboardedFiles(workspace);
    expect(await isOnboardingComplete(workspace)).toBe(true);
  });

  it('returns false when IDENTITY.md is real but USER.md is missing', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });

  it('returns false when IDENTITY.md is real but USER.md is still template', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');
    // Copy the template USER.md which contains the marker text
    const templateUser = await fs.readFile(
      path.join(__dirname, '..', 'templates', 'workspace', 'USER.md'),
      'utf-8',
    );
    await fs.writeFile(path.join(workspace, 'USER.md'), templateUser, 'utf-8');
    expect(await isOnboardingComplete(workspace)).toBe(false);
  });
});

describe('ensureWorkspaceBootstrapFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
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

    // Simulate completed onboarding: both files have real content.
    await writeOnboardedFiles(workspace);

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

    // Simulate completed onboarding: write real content to both files.
    await writeOnboardedFiles(workspace);

    // Second run — should auto-delete BOOTSTRAP.md.
    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('auto-deleted stale BOOTSTRAP.md'),
    );
  });

  // --- Plan-027 tests: force bootstrap env var ---

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 creates BOOTSTRAP.md in onboarded workspace', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    // BOOTSTRAP.md should exist despite onboarding being complete.
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('DISCOCLAW_FORCE_BOOTSTRAP'),
    );
  });

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 replaces existing BOOTSTRAP.md with template', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), 'corrupted bootstrap content', 'utf-8');

    await ensureWorkspaceBootstrapFiles(workspace);

    const content = await fs.readFile(path.join(workspace, 'BOOTSTRAP.md'), 'utf-8');
    // Read the actual template to compare.
    const templateContent = await fs.readFile(
      path.join(__dirname, '..', 'templates', 'workspace', 'BOOTSTRAP.md'),
      'utf-8',
    );
    expect(content).toBe(templateContent);
  });

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 does NOT overwrite other template files', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');

    const customFiles: Record<string, string> = {
      'AGENTS.md': 'My custom agents config',
      'SOUL.md': 'My soul',
      'TOOLS.md': 'My tools',
      'USER.md': 'My user',
      'HEARTBEAT.md': 'My heartbeat',
      'MEMORY.md': 'My memory',
    };
    for (const [file, content] of Object.entries(customFiles)) {
      await fs.writeFile(path.join(workspace, file), content, 'utf-8');
    }

    await ensureWorkspaceBootstrapFiles(workspace);

    // All custom files should retain their content byte-for-byte.
    for (const [file, expected] of Object.entries(customFiles)) {
      const actual = await fs.readFile(path.join(workspace, file), 'utf-8');
      expect(actual).toBe(expected);
    }
    // BOOTSTRAP.md should be created from template.
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).resolves.toBeUndefined();
  });

  it('DISCOCLAW_FORCE_BOOTSTRAP=true does NOT trigger force mode (strict equality)', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', 'true');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);

    await ensureWorkspaceBootstrapFiles(workspace);

    // BOOTSTRAP.md should NOT exist — onboarding is complete and force is not active.
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
  });

  // --- Plan-027 tests: stale warning ---

  it('stale BOOTSTRAP.md emits log.warn before auto-delete', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), 'stale content', 'utf-8');

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('stale BOOTSTRAP.md'),
    );
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('auto-deleted stale BOOTSTRAP.md'),
    );
  });

  it('no warning when BOOTSTRAP.md does not exist in onboarded workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 on brand-new workspace creates all files', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const log = mockLog();
    const created = await ensureWorkspaceBootstrapFiles(workspace, log as any);

    // All template files should exist.
    for (const file of ALL_TEMPLATE_FILES) {
      await expect(fs.access(path.join(workspace, file))).resolves.toBeUndefined();
    }
    // Force warning should fire even on brand-new workspace.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('DISCOCLAW_FORCE_BOOTSTRAP'),
    );
  });

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 with stale BOOTSTRAP.md emits only force warning', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), 'stale content', 'utf-8');

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    // Only one warn call — the force-active warning, not the stale warning.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('DISCOCLAW_FORCE_BOOTSTRAP'),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('stale BOOTSTRAP.md'),
    );
  });
});

// --- Plan-027 tests: unlink error handling ---
// Uses vi.spyOn on the imported fs default object to intercept unlink calls.

describe('ensureWorkspaceBootstrapFiles — unlink error handling', () => {
  const dirs: string[] = [];
  let unlinkSpy: MockInstance | undefined;
  const originalUnlink = fs.unlink.bind(fs);

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (unlinkSpy) unlinkSpy.mockRestore();
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('force path unlink re-throws non-ENOENT errors', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);

    // Spy on unlink to throw EPERM for BOOTSTRAP.md paths.
    unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (p: any) => {
      if (typeof p === 'string' && p.endsWith('BOOTSTRAP.md')) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return originalUnlink(p);
    });

    await expect(ensureWorkspaceBootstrapFiles(workspace)).rejects.toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it('auto-delete path unlink re-throws non-ENOENT errors', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await writeOnboardedFiles(workspace);
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), 'stale content', 'utf-8');

    // Spy on unlink to throw EPERM for BOOTSTRAP.md paths.
    unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (p: any) => {
      if (typeof p === 'string' && p.endsWith('BOOTSTRAP.md')) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return originalUnlink(p);
    });

    const log = mockLog();
    await expect(ensureWorkspaceBootstrapFiles(workspace, log as any)).rejects.toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
    // Both the stale warning and the failure warning should have fired.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('stale BOOTSTRAP.md'),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('failed to auto-delete'),
    );
  });
});
