import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRACKED_DEFAULTS_DIR,
  TRACKED_DEFAULTS_FILE_NAME,
  TRACKED_DEFAULTS_SECTION_LABEL,
  _resetTrackedDefaultsCacheForTests,
  buildPromptSafeDefaultsContent,
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

describe('buildPromptSafeDefaultsContent', () => {
  it('drops rarely-needed sections from the tracked defaults template', async () => {
    const content = await fs.readFile(resolveTrackedDefaultsPath(), 'utf-8');
    const sanitized = buildPromptSafeDefaultsContent(content);

    // Dropped sections
    expect(sanitized).not.toContain('## Runtime Instruction Precedence');
    expect(sanitized).not.toContain('## First Run');
    expect(sanitized).not.toContain('## Runtime Registry');
    expect(sanitized).not.toContain('## Bot Setup Assistance');
    expect(sanitized).not.toContain('## Knowledge Cutoff Awareness');

    // Sections that should survive filtering
    expect(sanitized).toContain('## Search Before Asking');
    expect(sanitized).toContain('## Tool Use First');
    expect(sanitized).toContain('## Discord Action Grounding');
    expect(sanitized).toContain('## Response Economy');
    expect(sanitized).toContain('## Landing the Plane');
  });

  it('strips blockquote lines from the prelude', () => {
    const content = '# Title\n\n> Meta description\n> Second line\n\n## Kept\nContent';
    const sanitized = buildPromptSafeDefaultsContent(content);
    expect(sanitized).not.toContain('> Meta description');
    expect(sanitized).toContain('# Title');
    expect(sanitized).toContain('## Kept');
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

  it('returns only the tracked defaults section', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const trackedDefaultsPath = path.join(dir, 'SYSTEM_DEFAULTS.md');

    await fs.writeFile(trackedDefaultsPath, '# Defaults\nAlways do X\n', 'utf-8');

    const preamble = loadTrackedDefaultsPreamble({
      trackedDefaultsPath,
      forceReload: true,
    });

    expect(preamble.startsWith(`--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---`)).toBe(true);
    expect(preamble).toContain('# Defaults\nAlways do X');
  });

  it('caches by tracked defaults path and only reloads when forced', async () => {
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

  it('sanitizes the default tracked template before rendering it into the preamble', () => {
    const preamble = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: resolveTrackedDefaultsPath(),
      forceReload: true,
    });

    expect(preamble).toContain(`--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---`);
    expect(preamble).not.toContain('## Runtime Instruction Precedence');
    expect(preamble).not.toContain('## Runtime Registry');
    expect(preamble).not.toContain('## Bot Setup Assistance');
    expect(preamble).toContain('## Search Before Asking');
    expect(preamble).toContain('## Tool Use First');
  });

  it('invalidates cache when the tracked defaults path changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-defaults-'));
    dirs.push(dir);
    const defaultsAPath = path.join(dir, 'defaults-a.md');
    const defaultsBPath = path.join(dir, 'defaults-b.md');
    await fs.writeFile(defaultsAPath, 'defaults A', 'utf-8');
    await fs.writeFile(defaultsBPath, 'defaults B', 'utf-8');

    const first = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: defaultsAPath,
      forceReload: true,
    });
    const second = loadTrackedDefaultsPreamble({
      trackedDefaultsPath: defaultsBPath,
    });

    expect(first).toContain('defaults A');
    expect(second).toContain('defaults B');
  });
});
