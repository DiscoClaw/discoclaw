import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRACKED_DEFAULTS_DIR = 'instructions';
export const TRACKED_DEFAULTS_FILE_NAME = 'SYSTEM_DEFAULTS.md';
export const TRACKED_DEFAULTS_SECTION_LABEL = 'SYSTEM_DEFAULTS.md (tracked defaults)';

let cachedPath: string | null = null;
let cachedPreamble: string | null = null;

type MarkdownSection = {
  heading: string;
  lines: string[];
};

/**
 * Sections dropped from the tracked defaults because they are
 * duplicated, unreachable after bootstrap, or rarely needed.
 */
const DROPPED_DEFAULTS_SECTIONS = new Set([
  'Runtime Instruction Precedence',
  'First Run',
  'Runtime Registry',
  'Bot Setup Assistance',
  'Knowledge Cutoff Awareness',
]);

function splitTopLevelSections(content: string): { prelude: string[]; sections: MarkdownSection[] } {
  const prelude: string[] = [];
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  for (const line of content.trimEnd().split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [line] };
      sections.push(current);
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      prelude.push(line);
    }
  }

  return { prelude, sections };
}

function joinDefaultsContent(parts: string[]): string {
  return parts
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trimEnd();
}

/**
 * Filter tracked defaults content by dropping rarely-needed sections
 * and stripping meta-descriptive blockquotes from the prelude.
 */
export function buildPromptSafeDefaultsContent(content: string): string {
  const { prelude, sections } = splitTopLevelSections(content);
  const filteredPrelude = prelude.filter((line) => !line.startsWith('> '));
  const filteredSections = sections.filter(
    (section) => !DROPPED_DEFAULTS_SECTIONS.has(section.heading),
  );

  return joinDefaultsContent([
    filteredPrelude.join('\n'),
    ...filteredSections.map((section) => section.lines.join('\n')),
  ]);
}

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
 * Load the tracked defaults preamble with memoization.
 * Missing/unreadable files return an explicit warning section so this prompt
 * tier is never silently dropped.
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

  let defaultsPreamble = '';
  try {
    const content = fsSync.readFileSync(trackedDefaultsPath, 'utf-8');
    defaultsPreamble = renderTrackedDefaultsSection(buildPromptSafeDefaultsContent(content));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    defaultsPreamble = renderTrackedDefaultsSection(
      `[tracked defaults unavailable: failed to read ${trackedDefaultsPath}: ${message}]`,
    );
    console.warn(
      `instructions:tracked-defaults failed to read ${trackedDefaultsPath}; injecting fallback section (${message})`,
    );
  }

  cachedPath = trackedDefaultsPath;
  cachedPreamble = defaultsPreamble;
  return defaultsPreamble;
}

/** Cached tracked defaults preamble used by prompt assembly and forge context summary. */
export function getTrackedDefaultsPreamble(): string {
  return loadTrackedDefaultsPreamble();
}

export function _resetTrackedDefaultsCacheForTests(): void {
  cachedPath = null;
  cachedPreamble = null;
}
