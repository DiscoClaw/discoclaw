import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRACKED_TOOLS_DIR = 'instructions';
export const TRACKED_TOOLS_FILE_NAME = 'TOOLS.md';
export const TRACKED_TOOLS_SECTION_LABEL = 'TOOLS.md (tracked tools)';

let cachedPath: string | null = null;
let cachedPreamble: string | null = null;

/**
 * Resolve the tracked TOOLS.md path from this module's location.
 * Works in both src/* and dist/* layouts.
 */
export function resolveTrackedToolsPath(baseDir: string = __dirname): string {
  return path.resolve(baseDir, '..', '..', 'templates', TRACKED_TOOLS_DIR, TRACKED_TOOLS_FILE_NAME);
}

/** Render tracked tools in the canonical prompt section format. */
export function renderTrackedToolsSection(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed) return '';
  return `--- ${TRACKED_TOOLS_SECTION_LABEL} ---\n${trimmed}`;
}

/**
 * Load tracked tools from disk with memoization.
 * Missing/unreadable files return an explicit warning section so the
 * tracked-tools prompt tier is never silently dropped.
 */
export function loadTrackedToolsPreamble(opts?: {
  trackedToolsPath?: string;
  forceReload?: boolean;
}): string {
  const trackedToolsPath = opts?.trackedToolsPath ?? resolveTrackedToolsPath();
  const forceReload = opts?.forceReload === true;
  if (!forceReload && cachedPath === trackedToolsPath && cachedPreamble !== null) {
    return cachedPreamble;
  }

  let preamble = '';
  try {
    const content = fsSync.readFileSync(trackedToolsPath, 'utf-8');
    preamble = renderTrackedToolsSection(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    preamble = renderTrackedToolsSection(
      `[tracked tools unavailable: failed to read ${trackedToolsPath}: ${message}]`,
    );
    console.warn(
      `instructions:tracked-tools failed to read ${trackedToolsPath}; injecting fallback section (${message})`,
    );
  }

  cachedPath = trackedToolsPath;
  cachedPreamble = preamble;
  return preamble;
}

/** Cached tracked tools preamble used by prompt assembly. */
export function getTrackedToolsPreamble(): string {
  return loadTrackedToolsPreamble();
}

export function _resetTrackedToolsCacheForTests(): void {
  cachedPath = null;
  cachedPreamble = null;
}
