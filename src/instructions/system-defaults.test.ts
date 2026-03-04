import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRACKED_DEFAULTS_DIR,
  TRACKED_DEFAULTS_FILE_NAME,
  TRACKED_DEFAULTS_SECTION_LABEL,
  _resetTrackedDefaultsCacheForTests,
  loadTrackedDefaultsPreamble,
  renderTrackedDefaultsSection,
  resolveTrackedDefaultsPath,
} from './system-defaults.js';

describe('resolveTrackedDefaultsPath', () => {
  it('resolves to templates/instructions/SYSTEM_DEFAULTS.md by default', async () => {
    const resolved = resolveTrackedDefaultsPath();
    expect(resolved.endsWith(path.join('templates', TRACKED_DEFAULTS_DIR, TRACKED_DEFAULTS_FILE_NAME))).toBe(true);
    await expect(fs.access(resolved)).resolves.toBeUndefined();
  });

  it('resolves relative to a provided base directory', () => {
    const resolved = resolveTrackedDefaultsPath('/tmp/repo/src/instructions');
    expect(resolved).toBe(path.resolve('/tmp/repo/templates/instructions/SYSTEM_DEFAULTS.md'));
  });
});

describe('renderTrackedDefaultsSection', () => {
  it('renders the canonical section header and trims trailing whitespace only', () => {
    const content = '# Header\n\nRule one\nRule two\n\n';
    const rendered = renderTrackedDefaultsSection(content);
    expect(rendered).toBe(`--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---\n# Header\n\nRule one\nRule two`);
  });

  it('is deterministic for identical input', () => {
    const input = 'line 1\nline 2\n';
    expect(renderTrackedDefaultsSection(input)).toBe(renderTrackedDefaultsSection(input));
  });

  it('returns empty string for blank content', () => {
    expect(renderTrackedDefaultsSection('\n   \n')).toBe('');
  });
});

describe('loadTrackedDefaultsPreamble', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    _resetTrackedDefaultsCacheForTests();
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns an explicit warning section and logs when the tracked defaults file is missing', () => {
    const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}-SYSTEM_DEFAULTS.md`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTrackedDefaultsPreamble({ trackedDefaultsPath: missingPath, forceReload: true });
    expect(result).toContain(`--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---`);
    expect(result).toContain('[tracked defaults unavailable: failed to read');
    expect(result).toContain(missingPath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`instructions:tracked-defaults failed to read ${missingPath}`),
    );
    warnSpy.mockRestore();
  });

  it('caches by path and only reloads when forced', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const trackedDefaultsPath = path.join(dir, 'SYSTEM_DEFAULTS.md');

    await fs.writeFile(trackedDefaultsPath, 'first version\n', 'utf-8');
    const first = loadTrackedDefaultsPreamble({ trackedDefaultsPath, forceReload: true });
    expect(first).toContain('first version');

    await fs.writeFile(trackedDefaultsPath, 'second version\n', 'utf-8');
    const cached = loadTrackedDefaultsPreamble({ trackedDefaultsPath });
    expect(cached).toBe(first);
    expect(cached).not.toContain('second version');

    const reloaded = loadTrackedDefaultsPreamble({ trackedDefaultsPath, forceReload: true });
    expect(reloaded).toContain('second version');
    expect(reloaded).not.toBe(first);
  });

  it('invalidates cache when path changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const aPath = path.join(dir, 'a.md');
    const bPath = path.join(dir, 'b.md');
    await fs.writeFile(aPath, 'A', 'utf-8');
    await fs.writeFile(bPath, 'B', 'utf-8');

    const a = loadTrackedDefaultsPreamble({ trackedDefaultsPath: aPath, forceReload: true });
    const b = loadTrackedDefaultsPreamble({ trackedDefaultsPath: bPath });
    expect(a).toContain('A');
    expect(b).toContain('B');
  });
});
