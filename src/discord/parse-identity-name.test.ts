import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseIdentityName } from '../identity.js';

describe('parseIdentityName', () => {
  it('parses "- **Name:** Weston" format', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\n- **Name:** Weston\n- **Vibe:** chill', 'utf8');
    const result = await parseIdentityName(dir);
    expect(result).toBe('Weston');
    await fs.rm(dir, { recursive: true });
  });

  it('parses "**Name**: Weston" format (no leading dash)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\n**Name**: Weston\n', 'utf8');
    const result = await parseIdentityName(dir);
    expect(result).toBe('Weston');
    await fs.rm(dir, { recursive: true });
  });

  it('parses "Name: Weston" format (no bold)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\nName: Weston\n', 'utf8');
    const result = await parseIdentityName(dir);
    expect(result).toBe('Weston');
    await fs.rm(dir, { recursive: true });
  });

  it('returns undefined for empty/missing name value', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    await fs.writeFile(path.join(dir, 'IDENTITY.md'), '# Identity\n\nNo name here\n', 'utf8');
    const result = await parseIdentityName(dir);
    expect(result).toBeUndefined();
    await fs.rm(dir, { recursive: true });
  });

  it('returns undefined for missing file (ENOENT)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    const result = await parseIdentityName(dir);
    expect(result).toBeUndefined();
    await fs.rm(dir, { recursive: true });
  });

  it('trims whitespace from the name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
    await fs.writeFile(path.join(dir, 'IDENTITY.md'), '- **Name:**   Weston  \n', 'utf8');
    const result = await parseIdentityName(dir);
    expect(result).toBe('Weston');
    await fs.rm(dir, { recursive: true });
  });
});
