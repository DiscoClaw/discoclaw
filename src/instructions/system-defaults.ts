import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrackedToolsPreamble, resolveTrackedToolsPath } from './tracked-tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRACKED_DEFAULTS_DIR = 'instructions';
export const TRACKED_DEFAULTS_FILE_NAME = 'SYSTEM_DEFAULTS.md';
export const TRACKED_DEFAULTS_SECTION_LABEL = 'SYSTEM_DEFAULTS.md (tracked defaults)';

let cachedPath: string | null = null;
let cachedToolsPath: string | null = null;
let cachedPreamble: string | null = null;

/**
 * Resolve the tracked system-default file path from this module's location.
 * Works in both src/* and dist/* layouts.
 */
export function resolveTrackedDefaultsPath(baseDir: string = __dirname): string {
  return path.resolve(baseDir, '..', '..', 'templates', TRACKED_DEFAULTS_DIR, TRACKED_DEFAULTS_FILE_NAME);
}

/** Render tracked defaults in the canonical prompt section format. */
export function renderTrackedDefaultsSection(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed) return '';
  return `--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---\n${trimmed}`;
}

/**
 * Load the tracked instruction preamble with memoization.
 * This combines SYSTEM_DEFAULTS.md plus the tracked TOOLS.md layer so repo
 * updates land automatically for existing workspaces. Missing/unreadable files
 * return explicit warning sections so this prompt tier is never silently dropped.
 */
export function loadTrackedDefaultsPreamble(opts?: {
  trackedDefaultsPath?: string;
  trackedToolsPath?: string;
  forceReload?: boolean;
}): string {
  const trackedDefaultsPath = opts?.trackedDefaultsPath ?? resolveTrackedDefaultsPath();
  const trackedToolsPath = opts?.trackedToolsPath ?? resolveTrackedToolsPath();
  const forceReload = opts?.forceReload === true;
  if (
    !forceReload &&
    cachedPath === trackedDefaultsPath &&
    cachedToolsPath === trackedToolsPath &&
    cachedPreamble !== null
  ) {
    return cachedPreamble;
  }

  let defaultsPreamble = '';
  try {
    const content = fsSync.readFileSync(trackedDefaultsPath, 'utf-8');
    defaultsPreamble = renderTrackedDefaultsSection(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    defaultsPreamble = renderTrackedDefaultsSection(
      `[tracked defaults unavailable: failed to read ${trackedDefaultsPath}: ${message}]`,
    );
    console.warn(
      `instructions:tracked-defaults failed to read ${trackedDefaultsPath}; injecting fallback section (${message})`,
    );
  }

  const toolsPreamble = loadTrackedToolsPreamble({
    trackedToolsPath,
    forceReload,
  });
  const preamble = [defaultsPreamble, toolsPreamble].filter((section) => section.length > 0).join('\n\n');

  cachedPath = trackedDefaultsPath;
  cachedToolsPath = trackedToolsPath;
  cachedPreamble = preamble;
  return preamble;
}

/** Cached tracked defaults preamble used by prompt assembly and forge context summary. */
export function getTrackedDefaultsPreamble(): string {
  return loadTrackedDefaultsPreamble();
}

export function _resetTrackedDefaultsCacheForTests(): void {
  cachedPath = null;
  cachedToolsPath = null;
  cachedPreamble = null;
}
