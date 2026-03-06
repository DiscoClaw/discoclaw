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
import { TRACKED_TOOLS_SECTION_LABEL } from './tracked-tools.js';

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
    expect(result).toContain(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---`);
    expect(result).toContain('[tracked defaults unavailable: failed to read');
    expect(result).toContain(missingPath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`instructions:tracked-defaults failed to read ${missingPath}`),
    );
    warnSpy.mockRestore();
  });

  it('includes tracked tools after tracked defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const trackedDefaultsPath = path.join(dir, 'SYSTEM_DEFAULTS.md');
    const trackedToolsPath = path.join(dir, 'TOOLS.md');

    await fs.writeFile(trackedDefaultsPath, '# Defaults\nAlways do X\n', 'utf-8');
    await fs.writeFile(trackedToolsPath, '# Tools\nUse tool Y\n', 'utf-8');

    const preamble = loadTrackedDefaultsPreamble({
      trackedDefaultsPath,
      trackedToolsPath,
      forceReload: true,
    });

    const defaultsIdx = preamble.indexOf(`--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---`);
    const toolsIdx = preamble.indexOf(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---`);
    expect(defaultsIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(defaultsIdx);
    expect(preamble).toContain('# Defaults\nAlways do X');
    expect(preamble).toContain('# Tools\nUse tool Y');
  });

  it('caches by both tracked paths and only reloads when forced', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const trackedDefaultsPath = path.join(dir, 'SYSTEM_DEFAULTS.md');
    const trackedToolsPath = path.join(dir, 'TOOLS.md');

    await fs.writeFile(trackedDefaultsPath, 'first version\n', 'utf-8');
    await fs.writeFile(trackedToolsPath, 'tool version one\n', 'utf-8');
    const first = loadTrackedDefaultsPreamble({ trackedDefaultsPath, trackedToolsPath, forceReload: true });
    expect(first).toContain('first version');
    expect(first).toContain('tool version one');

    await fs.writeFile(trackedDefaultsPath, 'second version\n', 'utf-8');
    await fs.writeFile(trackedToolsPath, 'tool version two\n', 'utf-8');
    const cached = loadTrackedDefaultsPreamble({ trackedDefaultsPath, trackedToolsPath });
    expect(cached).toBe(first);
    expect(cached).not.toContain('second version');
    expect(cached).not.toContain('tool version two');

    const reloaded = loadTrackedDefaultsPreamble({ trackedDefaultsPath, trackedToolsPath, forceReload: true });
    expect(reloaded).toContain('second version');
    expect(reloaded).toContain('tool version two');
    expect(reloaded).not.toBe(first);
  });

  it('invalidates cache when either tracked path changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const defaultsAPath = path.join(dir, 'defaults-a.md');
    const defaultsBPath = path.join(dir, 'defaults-b.md');
    const toolsAPath = path.join(dir, 'tools-a.md');
    const toolsBPath = path.join(dir, 'tools-b.md');
    await fs.writeFile(defaultsAPath, 'defaults A', 'utf-8');
    await fs.writeFile(defaultsBPath, 'defaults B', 'utf-8');
    await fs.writeFile(toolsAPath, 'tools A', 'utf-8');
    await fs.writeFile(toolsBPath, 'tools B', 'utf-8');

    const first = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: defaultsAPath,
      trackedToolsPath: toolsAPath,
      forceReload: true,
    });
    const second = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: defaultsBPath,
      trackedToolsPath: toolsAPath,
    });
    const third = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: defaultsBPath,
      trackedToolsPath: toolsBPath,
    });

    expect(first).toContain('defaults A');
    expect(first).toContain('tools A');
    expect(second).toContain('defaults B');
    expect(second).toContain('tools A');
    expect(third).toContain('defaults B');
    expect(third).toContain('tools B');
  });
});
