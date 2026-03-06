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

  it('returns true when IDENTITY.md is real but USER.md is missing (only IDENTITY checked)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');
    expect(await isOnboardingComplete(workspace)).toBe(true);
  });

  it('returns true when IDENTITY.md is real but USER.md is still template (only IDENTITY checked)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboard-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');
    // Copy the template USER.md which contains the marker text
    const templateUser = await fs.readFile(
      path.join(__dirname, '..', 'templates', 'workspace', 'USER.md'),
      'utf-8',
    );
    await fs.writeFile(path.join(workspace, 'USER.md'), templateUser, 'utf-8');
    expect(await isOnboardingComplete(workspace)).toBe(true);
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
    expect(created).not.toContain('TOOLS.md');
    await expect(fs.access(path.join(workspace, 'TOOLS.md'))).rejects.toThrow();
  });

  it('does not overwrite existing user-owned files', async () => {
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

  it('returns empty array when all scaffolded files already exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // First run — scaffolds everything.
    await ensureWorkspaceBootstrapFiles(workspace);
    // Second run — nothing newly created.
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

  // --- Legacy DISCOCLAW.md migration compatibility tests ---

  it('does not scaffold DISCOCLAW.md in a fresh workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created).not.toContain('DISCOCLAW.md');
    await expect(fs.access(path.join(workspace, 'DISCOCLAW.md'))).rejects.toThrow();
  });

  it('preserves AGENTS.md and legacy DISCOCLAW.md content during bootstrap', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    // User customizes AGENTS.md (user-owned, should NOT be overwritten).
    const customAgents = '# My custom agents rules';
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), customAgents, 'utf-8');

    // Legacy file from older installs should remain untouched.
    const legacyDiscoclaw = '# legacy discoclaw file';
    await fs.writeFile(path.join(workspace, 'DISCOCLAW.md'), legacyDiscoclaw, 'utf-8');

    await ensureWorkspaceBootstrapFiles(workspace);

    // AGENTS.md should be preserved.
    const agentsContent = await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toBe(customAgents);

    // Legacy DISCOCLAW.md should not be clobbered.
    const discoContent = await fs.readFile(path.join(workspace, 'DISCOCLAW.md'), 'utf-8');
    expect(discoContent).toBe(legacyDiscoclaw);
  });

  it('warns when legacy DISCOCLAW.md is present in workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await fs.writeFile(path.join(workspace, 'DISCOCLAW.md'), '# legacy', 'utf-8');

    const log = mockLog();
    const created = await ensureWorkspaceBootstrapFiles(workspace, log as any);

    expect(created).not.toContain('DISCOCLAW.md');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'DISCOCLAW.md', workspaceCwd: workspace }),
      expect.stringContaining('legacy DISCOCLAW.md detected'),
    );
  });

  it('warns when AGENTS.md still contains legacy system sections', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const legacyAgents = [
      '# AGENTS.md - Legacy',
      '## Releasing to npm',
      '## Rebuild & Restart Workflow',
      '## Discord Action Batching',
    ].join('\n');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), legacyAgents, 'utf-8');

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    expect(
      log.warn.mock.calls.some(([, msg]) => String(msg).includes('legacy AGENTS.md system sections detected')),
    ).toBe(true);
  });

  it('does not warn when AGENTS.md has fewer than two legacy markers', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const customAgents = [
      '# AGENTS.md',
      '## My Rules',
      '- Keep answers short',
      '## Discord Action Batching',
    ].join('\n');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), customAgents, 'utf-8');

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    expect(
      log.warn.mock.calls.some(([, msg]) => String(msg).includes('legacy AGENTS.md system sections detected')),
    ).toBe(false);
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

  it('DISCOCLAW_FORCE_BOOTSTRAP=1 does NOT overwrite other user-owned template files', async () => {
    vi.stubEnv('DISCOCLAW_FORCE_BOOTSTRAP', '1');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    await fs.writeFile(path.join(workspace, 'IDENTITY.md'), REAL_IDENTITY, 'utf-8');

    const customFiles: Record<string, string> = {
      'AGENTS.md': 'My custom agents config',
      'SOUL.md': 'My soul',
      'TOOLS.md': 'My tools',
      'USER.md': 'My user',
      'MEMORY.md': 'My memory',
    };
    for (const [file, content] of Object.entries(customFiles)) {
      await fs.writeFile(path.join(workspace, file), content, 'utf-8');
    }

    await ensureWorkspaceBootstrapFiles(workspace);

    // All custom user-owned files should retain their content byte-for-byte.
    for (const [file, expected] of Object.entries(customFiles)) {
      const actual = await fs.readFile(path.join(workspace, file), 'utf-8');
      expect(actual).toBe(expected);
    }
    // BOOTSTRAP.md should be created from template.
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).resolves.toBeUndefined();
    // DISCOCLAW.md is no longer scaffolded/managed by bootstrap.
    await expect(fs.access(path.join(workspace, 'DISCOCLAW.md'))).rejects.toThrow();
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
    await expect(fs.access(path.join(workspace, 'TOOLS.md'))).rejects.toThrow();
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

// --- Template content completeness tests ---
// Ensures templates contain critical operational knowledge so a fresh install
// produces a fully operational bot without manual additions.

describe('template content — SYSTEM_DEFAULTS.md', () => {
  const templatesDir = path.join(__dirname, '..', 'templates', 'instructions');
  let systemDefaults: string;

  it('template file exists and is non-empty', async () => {
    systemDefaults = await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults.length).toBeGreaterThan(0);
  });

  it('contains tracked-defaults runtime-injection guidance', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('tracked default instruction source');
    expect(systemDefaults).toContain('not a workspace-managed file');
    expect(systemDefaults).toContain('Runtime Instruction Precedence');
    expect(systemDefaults).toContain('templates/instructions/TOOLS.md');
    expect(systemDefaults).toContain('workspace/TOOLS.md');
  });

  it('contains Discord action batching rules', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('Discord Action Batching');
    expect(systemDefaults).toContain('Multiple actions of the same type in a single response are fully supported');
  });

  it('contains response economy guidance', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('Response Economy');
  });

  it('contains knowledge cutoff awareness section', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('Knowledge Cutoff Awareness');
    expect(systemDefaults).toContain('use the web to verify');
  });

  it('contains session completion workflow', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('Landing the Plane');
    expect(systemDefaults).toContain('git push');
  });

  it('contains git commit hash guidance', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).toContain('Git Commits');
    expect(systemDefaults).toContain('short commit hash');
  });

  it('does not contain memory commands (moved to pa.md)', async () => {
    systemDefaults ??= await fs.readFile(path.join(templatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    expect(systemDefaults).not.toContain('!memory remember');
    expect(systemDefaults).not.toContain('!memory add');
  });
});

describe('template content — AGENTS.md', () => {
  const templatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  let agents: string;

  it('template file exists and is non-empty', async () => {
    agents = await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    expect(agents.length).toBeGreaterThan(0);
  });

  it('declares itself as user-owned (always preserved)', async () => {
    agents ??= await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('always preserves');
  });

  it('references runtime-injected tracked defaults for system instructions', async () => {
    agents ??= await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('tracked');
    expect(agents).toContain('not from a workspace-managed file');
  });

  it('contains memory vs instructions guidance', async () => {
    agents ??= await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Memory vs Instructions');
  });

  it('contains make-it-yours section', async () => {
    agents ??= await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Make It Yours');
  });

  it('does not contain system instructions (those are in tracked defaults)', async () => {
    agents ??= await fs.readFile(path.join(templatesDir, 'AGENTS.md'), 'utf-8');
    // These sections live in templates/instructions/SYSTEM_DEFAULTS.md.
    expect(agents).not.toContain('Discord Action Batching');
    expect(agents).not.toContain('Response Economy');
    expect(agents).not.toContain('Knowledge Cutoff Awareness');
    expect(agents).not.toContain('Landing the Plane');
    expect(agents).not.toContain('Plan-Audit-Implement Workflow');
  });
});

describe('template content — TOOLS.md', () => {
  const templatesDir = path.join(__dirname, '..', 'templates', 'instructions');
  let tools: string;

  it('template file exists and is non-empty', async () => {
    tools = await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools.length).toBeGreaterThan(0);
  });

  it('contains browser automation section', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('Browser Automation');
    expect(tools).toContain('agent-browser');
  });

  it('declares tracked runtime injection and workspace override behavior', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('canonical tracked tools instruction source');
    expect(tools).toContain('runtime after `templates/instructions/SYSTEM_DEFAULTS.md`');
    expect(tools).toContain('workspace/TOOLS.md');
    expect(tools).toContain('Runtime Instruction Precedence');
  });

  it('documents browser automation tiers (WebFetch, Playwright, CDP)', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('Playwright');
    expect(tools).toContain('CDP');
  });

  it('contains service operations section', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('Service Operations');
    expect(tools).toContain('systemctl --user');
  });

  it('contains plan-audit-implement workflow', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('Plan-Audit-Implement Workflow');
  });

  it('contains discord action pointer stub referencing actions reference', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('discord-action');
  });

  it('documents restart convenience commands', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('!restart');
    expect(tools).toContain('Discord Convenience Commands');
  });

  it('contains service operation guardrails', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('Always ask before restart');
    expect(tools).toContain('Guardrails');
  });
});

describe('template content — workspace TOOLS.md override', () => {
  const templatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  let tools: string;

  it('template file exists and is non-empty', async () => {
    tools = await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools.length).toBeGreaterThan(0);
  });

  it('describes workspace TOOLS.md as an optional override layer', async () => {
    tools ??= await fs.readFile(path.join(templatesDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('tracked tool and environment instructions');
    expect(tools).toContain('workspace-specific overrides');
    expect(tools).toContain('If you do not have any local overrides, you can delete this file');
  });
});

describe('template content — no personalization leak', () => {
  const workspaceTemplatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  const instructionsTemplatesDir = path.join(__dirname, '..', 'templates', 'instructions');
  const FORBIDDEN_TOKENS = ['David', 'Escondido', 'Chelsea', 'marshmonkey'];

  it('AGENTS.md does not contain user-specific tokens', async () => {
    const content = await fs.readFile(path.join(workspaceTemplatesDir, 'AGENTS.md'), 'utf-8');
    for (const token of FORBIDDEN_TOKENS) {
      expect(content).not.toContain(token);
    }
  });

  it('TOOLS.md does not contain user-specific tokens', async () => {
    const content = await fs.readFile(path.join(instructionsTemplatesDir, 'TOOLS.md'), 'utf-8');
    for (const token of FORBIDDEN_TOKENS) {
      expect(content).not.toContain(token);
    }
  });

  it('workspace TOOLS.md template does not contain user-specific tokens', async () => {
    const content = await fs.readFile(path.join(workspaceTemplatesDir, 'TOOLS.md'), 'utf-8');
    for (const token of FORBIDDEN_TOKENS) {
      expect(content).not.toContain(token);
    }
  });

  it('SYSTEM_DEFAULTS.md does not contain user-specific tokens', async () => {
    const content = await fs.readFile(path.join(instructionsTemplatesDir, 'SYSTEM_DEFAULTS.md'), 'utf-8');
    for (const token of FORBIDDEN_TOKENS) {
      expect(content).not.toContain(token);
    }
  });
});

describe('scaffolded workspace contains operational content', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('fresh scaffold does not create managed DISCOCLAW.md', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-content-'));
    dirs.push(workspace);

    await ensureWorkspaceBootstrapFiles(workspace);

    await expect(fs.access(path.join(workspace, 'DISCOCLAW.md'))).rejects.toThrow();
  });

  it('fresh scaffold does not create managed TOOLS.md', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-content-'));
    dirs.push(workspace);

    await ensureWorkspaceBootstrapFiles(workspace);

    await expect(fs.access(path.join(workspace, 'TOOLS.md'))).rejects.toThrow();
  });
});

// --- TOOLS.md stale-content migration tests ---

describe('TOOLS.md migration', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** Content that contains the stale markers (old system-generated action reference). */
  const STALE_TOOLS_CONTENT = [
    '# TOOLS.md - Local Tools & Environment',
    '',
    '## Browser Automation (agent-browser)',
    '',
    'Some browser docs here.',
    '',
    '## Discord Action Types',
    '',
    'Use these as `<discord-action>` blocks.',
    '',
    '### Forge Actions',
    '',
    '**forgeCreate** — Start a new forge run.',
    '',
    '### Plan Actions',
    '',
    '**planList** — List all plans.',
  ].join('\n');

  /** Custom TOOLS.md without the stale markers — should not be touched. */
  const CUSTOM_TOOLS_CONTENT = [
    '# TOOLS.md - My Custom Tools',
    '',
    '## My Custom Section',
    '',
    'This file has been customized by the user.',
  ].join('\n');

  it('migrates stale TOOLS.md: backs up and replaces with workspace override template', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-migrate-'));
    dirs.push(workspace);

    // Write stale content with both markers present.
    await fs.writeFile(path.join(workspace, 'TOOLS.md'), STALE_TOOLS_CONTENT, 'utf-8');

    const originalCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (src: any, dest: any, mode?: any) =>
      originalCopyFile(src, dest, mode),
    );
    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    // Backup should exist with original stale content.
    const backup = await fs.readFile(path.join(workspace, 'TOOLS.md.bak'), 'utf-8');
    expect(backup).toBe(STALE_TOOLS_CONTENT);

    // TOOLS.md should now match the workspace override template.
    const templateContent = await fs.readFile(
      path.join(__dirname, '..', 'templates', 'workspace', 'TOOLS.md'),
      'utf-8',
    );
    const replaced = await fs.readFile(path.join(workspace, 'TOOLS.md'), 'utf-8');
    expect(replaced).toBe(templateContent);
    expect(copyFileSpy).toHaveBeenCalledWith(
      path.join(__dirname, '..', 'templates', 'workspace', 'TOOLS.md'),
      path.join(workspace, 'TOOLS.md'),
    );
    copyFileSpy.mockRestore();

    // Both log messages should have fired.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('backed up stale TOOLS.md'),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      expect.stringContaining('replaced stale TOOLS.md with workspace override template'),
    );
  });

  it('leaves customized TOOLS.md without stale marker untouched', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-migrate-'));
    dirs.push(workspace);

    await fs.writeFile(path.join(workspace, 'TOOLS.md'), CUSTOM_TOOLS_CONTENT, 'utf-8');

    const log = mockLog();
    await ensureWorkspaceBootstrapFiles(workspace, log as any);

    // TOOLS.md should be unchanged.
    const content = await fs.readFile(path.join(workspace, 'TOOLS.md'), 'utf-8');
    expect(content).toBe(CUSTOM_TOOLS_CONTENT);

    // No backup should exist.
    await expect(fs.access(path.join(workspace, 'TOOLS.md.bak'))).rejects.toThrow();

    // No migration log messages.
    expect(
      log.info.mock.calls.some(([, msg]) => String(msg).includes('backed up stale TOOLS.md')),
    ).toBe(false);
  });

  it('does not migrate when only one marker is present', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-migrate-'));
    dirs.push(workspace);

    // Has the heading but NOT the subheading.
    const partialContent = '# TOOLS.md\n\n## Discord Action Types\n\nCustom action docs.';
    await fs.writeFile(path.join(workspace, 'TOOLS.md'), partialContent, 'utf-8');

    await ensureWorkspaceBootstrapFiles(workspace);

    const content = await fs.readFile(path.join(workspace, 'TOOLS.md'), 'utf-8');
    expect(content).toBe(partialContent);
    await expect(fs.access(path.join(workspace, 'TOOLS.md.bak'))).rejects.toThrow();
  });
});
