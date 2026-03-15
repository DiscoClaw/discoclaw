import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve canonical task data paths.
 *
 * Returns `<dataDir>/tasks/<fileName>`.
 */
export function resolveTaskDataPath(
  dataDir: string | undefined,
  fileName: string,
): string | undefined {
  if (!dataDir) return undefined;
  return path.join(dataDir, 'tasks', fileName);
}

/**
 * Resolve legacy task data paths retained from the pre-hard-cut layout.
 *
 * Returns `<dataDir>/beads/<fileName>`.
 */
export function resolveLegacyTaskDataPath(
  dataDir: string | undefined,
  fileName: string,
): string | undefined {
  if (!dataDir) return undefined;
  return path.join(dataDir, 'beads', fileName);
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the best task data file path for read/load operations:
 * - canonical path when present
 * - legacy path when canonical is missing but legacy exists
 * - canonical path as the write target when neither exists yet
 */
export async function resolveTaskDataLoadPath(
  dataDir: string | undefined,
  fileName: string,
): Promise<string | undefined> {
  const canonicalPath = resolveTaskDataPath(dataDir, fileName);
  if (!canonicalPath) return undefined;
  if (await fileExists(canonicalPath)) return canonicalPath;

  const legacyPath = resolveLegacyTaskDataPath(dataDir, fileName);
  if (await fileExists(legacyPath)) return legacyPath;

  return canonicalPath;
}

export type LegacyTaskDataMigrationResult = {
  migrated: boolean;
  fromPath?: string;
  toPath?: string;
};

/**
 * Copy a legacy task data file from `<dataDir>/beads/` to the canonical
 * `<dataDir>/tasks/` path when the canonical file is missing.
 */
export async function migrateLegacyTaskDataFile(
  dataDir: string | undefined,
  fileName: string,
): Promise<LegacyTaskDataMigrationResult> {
  const toPath = resolveTaskDataPath(dataDir, fileName);
  const fromPath = resolveLegacyTaskDataPath(dataDir, fileName);
  if (!toPath || !fromPath) return { migrated: false };

  if (await fileExists(toPath)) return { migrated: false };
  if (!(await fileExists(fromPath))) return { migrated: false };

  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.copyFile(fromPath, toPath);
  return { migrated: true, fromPath, toPath };
}
