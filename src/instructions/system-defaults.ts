import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRACKED_DEFAULTS_FILE_NAME = 'DISCOCLAW.md';
export const TRACKED_DEFAULTS_SECTION_LABEL = 'DISCOCLAW.md (tracked defaults)';

let cachedPath: string | null = null;
let cachedPreamble: string | null = null;

/**
 * Resolve the tracked system-default file path from this module's location.
 * Works in both src/* and dist/* layouts.
 */
export function resolveTrackedDefaultsPath(baseDir: string = __dirname): string {
  return path.resolve(baseDir, '..', '..', 'templates', 'workspace', TRACKED_DEFAULTS_FILE_NAME);
}

/** Render tracked defaults in the canonical prompt section format. */
export function renderTrackedDefaultsSection(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed) return '';
  return `--- ${TRACKED_DEFAULTS_SECTION_LABEL} ---\n${trimmed}`;
}

/**
 * Load tracked defaults from disk with memoization.
 * Fallback behavior on missing/unreadable files is an empty string.
 */
export function loadTrackedDefaultsPreamble(opts?: {
  trackedDefaultsPath?: string;
  forceReload?: boolean;
}): string {
  const trackedDefaultsPath = opts?.trackedDefaultsPath ?? resolveTrackedDefaultsPath();
  const forceReload = opts?.forceReload === true;
  if (!forceReload && cachedPath === trackedDefaultsPath && cachedPreamble !== null) {
    return cachedPreamble;
  }

  let preamble = '';
  try {
    const content = fsSync.readFileSync(trackedDefaultsPath, 'utf-8');
    preamble = renderTrackedDefaultsSection(content);
  } catch {
    preamble = '';
  }

  cachedPath = trackedDefaultsPath;
  cachedPreamble = preamble;
  return preamble;
}

/** Cached tracked defaults preamble used by prompt assembly and forge context summary. */
export function getTrackedDefaultsPreamble(): string {
  return loadTrackedDefaultsPreamble();
}

export function _resetTrackedDefaultsCacheForTests(): void {
  cachedPath = null;
  cachedPreamble = null;
}
