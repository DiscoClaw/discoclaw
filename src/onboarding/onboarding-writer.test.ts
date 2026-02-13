import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeWorkspaceFiles } from './onboarding-writer.js';
import { isOnboardingComplete } from '../workspace-bootstrap.js';
import type { OnboardingValues } from './onboarding-flow.js';

describe('writeWorkspaceFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const baseValues: OnboardingValues = {
    botName: 'Weston',
    userName: 'David',
    purpose: 'dev',
    workingDirs: '~/code/project',
  };

  it('writes IDENTITY.md and USER.md with correct content', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const result = await writeWorkspaceFiles(baseValues, workspace);

    expect(result.written).toContain('IDENTITY.md');
    expect(result.written).toContain('USER.md');
    expect(result.errors).toHaveLength(0);

    const identity = await fs.readFile(path.join(workspace, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('Weston');
    expect(identity).not.toContain('*(pick something you like)*');

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('David');
    expect(user).toContain('~/code/project');
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

  it('handles pa purpose correctly', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const values: OnboardingValues = {
      botName: 'Claw',
      userName: 'Dave',
      purpose: 'pa',
      personality: 'snarky but helpful',
    };

    const result = await writeWorkspaceFiles(values, workspace);
    expect(result.errors).toHaveLength(0);

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('snarky but helpful');
    expect(user).not.toContain('Working directories');
  });

  it('handles both purpose correctly', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const values: OnboardingValues = {
      botName: 'Bot',
      userName: 'User',
      purpose: 'both',
      workingDirs: '~/projects',
      personality: 'calm and thorough',
    };

    const result = await writeWorkspaceFiles(values, workspace);
    expect(result.errors).toHaveLength(0);

    const user = await fs.readFile(path.join(workspace, 'USER.md'), 'utf-8');
    expect(user).toContain('~/projects');
    expect(user).toContain('calm and thorough');
  });

  it('handles optional fields being undefined', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const values: OnboardingValues = {
      botName: 'Bot',
      userName: 'User',
      purpose: 'dev',
      // workingDirs undefined
    };

    const result = await writeWorkspaceFiles(values, workspace);
    expect(result.errors).toHaveLength(0);
    expect(await isOnboardingComplete(workspace)).toBe(true);
  });

  it('user value containing {{USER_NAME}} is not double-substituted', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    const values: OnboardingValues = {
      botName: '{{USER_NAME}} Bot',
      userName: 'David',
      purpose: 'dev',
    };

    const result = await writeWorkspaceFiles(values, workspace);
    const identity = await fs.readFile(path.join(workspace, 'IDENTITY.md'), 'utf-8');
    // The bot name should be literally "{{USER_NAME}} Bot", not "David Bot"
    // (single-pass substitution means the generated content isn't re-scanned)
    expect(identity).toContain('{{USER_NAME}} Bot');
  });

  it('overwrites existing files on retry', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writer-'));
    dirs.push(workspace);

    // First write
    await writeWorkspaceFiles(baseValues, workspace);

    // Second write with different values
    const newValues: OnboardingValues = {
      botName: 'NewBot',
      userName: 'NewUser',
      purpose: 'pa',
      personality: 'warm',
    };
    const result = await writeWorkspaceFiles(newValues, workspace);
    expect(result.errors).toHaveLength(0);

    const identity = await fs.readFile(path.join(workspace, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('NewBot');
    expect(identity).not.toContain('Weston');
  });
});
