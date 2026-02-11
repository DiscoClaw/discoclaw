import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureWorkspaceBootstrapFiles } from './workspace-bootstrap.js';

const EXPECTED_FILES = [
  'BOOTSTRAP.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
];

describe('ensureWorkspaceBootstrapFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('scaffolds all template files into an empty workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bootstrap-'));
    dirs.push(workspace);

    const created = await ensureWorkspaceBootstrapFiles(workspace);

    expect(created.sort()).toEqual([...EXPECTED_FILES].sort());
    for (const file of EXPECTED_FILES) {
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

    expect(created.length).toBe(EXPECTED_FILES.length);
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
});
