import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { writeWorkspaceFiles } from './onboarding-writer.js';
import { isOnboardingComplete } from '../workspace-bootstrap.js';
import type { OnboardingValues } from './onboarding-flow.js';

vi.mock('../workspace-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-bootstrap.js')>();
  return { ...actual, isOnboardingComplete: vi.fn(actual.isOnboardingComplete) };
});

describe('writeWorkspaceFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const baseValues: OnboardingValues = {
    userName: 'David',
    timezone: 'America/New_York',
    morningCheckin: false,
  };

  it('writes IDENTITY.md and USER.md with correct content', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const result = await writeWorkspaceFiles(baseValues, workspace);

    expect(result.written).toContain('IDENTITY.md');
    expect(result.written).toContain('USER.md');
    expect(result.errors).toHaveLength(0);

    const identity = await fs.readFile(path.join(workspace, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('Discoclaw');
    expect(identity).not.toContain('*(pick something you like)*');

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('David');
    expect(user).toContain('America/New_York');
    expect(user).toContain('**Morning check-in:** No');
  });

  it('passes isOnboardingComplete after writing', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    await writeWorkspaceFiles(baseValues, workspace);
    expect(await isOnboardingComplete(workspace)).toBe(true);
  });

  it('produces no unresolved placeholders', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const result = await writeWorkspaceFiles(baseValues, workspace);
    expect(result.warnings).toHaveLength(0);
  });

  it('writes morning check-in preference correctly', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const values: OnboardingValues = {
      userName: 'Dave',
      timezone: 'Europe/London',
      morningCheckin: true,
    };

    const result = await writeWorkspaceFiles(values, workspace);
    expect(result.errors).toHaveLength(0);

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('Europe/London');
    expect(user).toContain('**Morning check-in:** Yes');
  });

  it('deletes BOOTSTRAP.md on successful onboarding', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // Simulate a pre-existing BOOTSTRAP.md from scaffolding
    await fs.writeFile(path.join(workspace, 'BOOTSTRAP.md'), '# First run\n', 'utf-8');

    const result = await writeWorkspaceFiles(baseValues, workspace);
    expect(result.errors).toHaveLength(0);

    // BOOTSTRAP.md should be gone
    await expect(fs.access(path.join(workspace, 'BOOTSTRAP.md'))).rejects.toThrow();
  });

  it('succeeds when BOOTSTRAP.md does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // No BOOTSTRAP.md present — ENOENT should be silently swallowed
    const result = await writeWorkspaceFiles(baseValues, workspace);
    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('IDENTITY.md');
    expect(result.written).toContain('USER.md');
  });

  it('overwrites existing files on retry', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // First write
    await writeWorkspaceFiles(baseValues, workspace);

    // Second write with different values
    const newValues: OnboardingValues = {
      userName: 'NewUser',
      timezone: 'Asia/Tokyo',
      morningCheckin: true,
    };
    const result = await writeWorkspaceFiles(newValues, workspace);
    expect(result.errors).toHaveLength(0);

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('NewUser');
    expect(user).toContain('Asia/Tokyo');
    expect(user).not.toContain('America/New_York');
  });
});

describe('writeWorkspaceFiles — BOOTSTRAP.md cleanup', () => {
  const dirs: string[] = [];
  let isOnboardingCompleteSpy: MockInstance;

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const baseValues: OnboardingValues = {
    userName: 'David',
    timezone: 'America/New_York',
    morningCheckin: false,
  };

  it('preserves BOOTSTRAP.md when post-write validation fails', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // Place a BOOTSTRAP.md so we can verify it survives
    const bootstrapPath = path.join(workspace, 'BOOTSTRAP.md');
    await fs.writeFile(bootstrapPath, '# First run\n', 'utf-8');

    // Force isOnboardingComplete to return false after files are written
    const { isOnboardingComplete } = await import('../workspace-bootstrap.js');
    isOnboardingCompleteSpy = vi.mocked(isOnboardingComplete).mockResolvedValue(false);

    const result = await writeWorkspaceFiles(baseValues, workspace);

    // Validation failed → errors array is non-empty
    expect(result.errors.length).toBeGreaterThan(0);

    // BOOTSTRAP.md should still exist — it must not be deleted on failure
    await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
  });

  it('re-throws non-ENOENT unlink errors', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // Ensure isOnboardingComplete returns true so the cleanup branch runs
    const { isOnboardingComplete } = await import('../workspace-bootstrap.js');
    isOnboardingCompleteSpy = vi.mocked(isOnboardingComplete).mockResolvedValue(true);

    // Make fs.unlink throw EPERM
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockRejectedValue(eperm);

    await expect(writeWorkspaceFiles(baseValues, workspace)).rejects.toThrow(
      'Failed to clean up BOOTSTRAP.md',
    );

    unlinkSpy.mockRestore();
  });
});
