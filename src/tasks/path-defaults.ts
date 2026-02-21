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
