import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseIdentityName, resolveDisplayName } from '../identity.js';

describe('parseIdentityName', () => {
  it('parses "- **Name:** Weston" format', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\n- **Name:** Weston\n- **Vibe:** chill', 'utf8');
      const result = await parseIdentityName(dir);
      expect(result).toBe('Weston');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('parses "**Name**: Weston" format (no leading dash)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\n**Name**: Weston\n', 'utf8');
      const result = await parseIdentityName(dir);
      expect(result).toBe('Weston');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('parses "Name: Weston" format (no bold)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\nName: Weston\n', 'utf8');
      const result = await parseIdentityName(dir);
      expect(result).toBe('Weston');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('returns undefined for empty/missing name value', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\nNo name here\n', 'utf8');
      const result = await parseIdentityName(dir);
      expect(result).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('returns undefined for missing file (ENOENT)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      const result = await parseIdentityName(dir);
      expect(result).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('trims whitespace from the name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '- **Name:**   Weston  \n', 'utf8');
      const result = await parseIdentityName(dir);
      expect(result).toBe('Weston');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('resolveDisplayName', () => {
  it('uses configName when provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '- **Name:** Ignored\n', 'utf8');
      const result = await resolveDisplayName({ configName: 'FromConfig', workspaceCwd: dir });
      expect(result).toBe('FromConfig');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('falls back to IDENTITY.md name when configName is undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      await fs.writeFile(path.join(dir, 'IDENTITY.md'), '- **Name:** Weston\n', 'utf8');
      const result = await resolveDisplayName({ workspaceCwd: dir });
      expect(result).toBe('Weston');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('falls back to Discoclaw when no name source exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      const result = await resolveDisplayName({ workspaceCwd: dir });
      expect(result).toBe('Discoclaw');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('truncates names exceeding 32 characters', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    const log = { warn: vi.fn() };
    try {
      const longName = 'A'.repeat(40);
      const result = await resolveDisplayName({ configName: longName, workspaceCwd: dir, log });
      expect(result).toBe('A'.repeat(32));
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ original: longName, truncated: 'A'.repeat(32) }),
        expect.stringContaining('truncating'),
      );
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('falls back to Discoclaw for whitespace-only configName', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    try {
      const result = await resolveDisplayName({ configName: '   ', workspaceCwd: dir });
      expect(result).toBe('Discoclaw');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
