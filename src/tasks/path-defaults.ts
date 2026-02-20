import fs from 'node:fs';
import path from 'node:path';

type ExistsFn = (candidate: string) => boolean;

/**
 * Resolve canonical task data paths with legacy fallback.
 *
 * Preference order:
 * 1. Existing canonical path: `<dataDir>/tasks/<fileName>`
 * 2. Existing legacy path: `<dataDir>/beads/<fileName>`
 * 3. Canonical default path (for new writes)
 */
export function resolveTaskDataPath(
  dataDir: string | undefined,
  fileName: string,
  exists: ExistsFn = fs.existsSync,
): string | undefined {
  if (!dataDir) return undefined;

  const canonicalPath = path.join(dataDir, 'tasks', fileName);
  const legacyPath = path.join(dataDir, 'beads', fileName);

  if (exists(canonicalPath)) return canonicalPath;
  if (exists(legacyPath)) return legacyPath;
  return canonicalPath;
}
