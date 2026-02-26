/**
 * Path security utilities for filesystem tool handlers.
 *
 * Ensures all file operations stay within allowed root directories,
 * resolving symlinks to prevent escape attacks.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Canonicalize allowed roots once (resolves symlinks in the roots themselves).
 * Falls back to path.resolve if the root dir doesn't exist yet.
 */
export async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      canonical.push(await fs.realpath(root));
    } catch {
      canonical.push(path.resolve(root));
    }
  }
  return canonical;
}

/**
 * Verify that `targetPath` falls under at least one allowed root.
 * Uses fs.realpath to resolve symlinks, preventing symlink escapes.
 * When the target (or its parent) doesn't exist, walks up the directory tree
 * to find an existing ancestor and validates that.
 */
export async function assertPathAllowed(
  targetPath: string,
  allowedRoots: string[],
  checkParent = false,
): Promise<void> {
  const canonicalRoots = await canonicalizeRoots(allowedRoots);
  const toCheck = checkParent ? path.dirname(targetPath) : targetPath;

  // Walk up to the nearest existing ancestor for realpath resolution
  let canonical: string | undefined;
  let current = toCheck;
  for (;;) {
    try {
      canonical = await fs.realpath(current);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error(`Path not accessible: ${toCheck}`);
        }
        current = parent;
        continue;
      }
      throw new Error(`Path not accessible: ${toCheck}`);
    }
  }

  // Reconstruct the full canonical path by appending the non-existing suffix
  const suffix = path.relative(current, toCheck);
  if (suffix && suffix !== '.') {
    canonical = path.join(canonical, suffix);
  }

  const allowed = canonicalRoots.some(
    (root) => canonical === root || canonical!.startsWith(root + path.sep),
  );
  if (!allowed) {
    throw new Error(`Path outside allowed roots: ${targetPath}`);
  }
}

/**
 * Resolve a file_path argument against the first allowed root,
 * then validate it falls within allowed roots.
 */
export async function resolveAndCheck(
  filePath: string,
  allowedRoots: string[],
  checkParent = false,
): Promise<string> {
  const resolved = path.resolve(allowedRoots[0], filePath);
  await assertPathAllowed(resolved, allowedRoots, checkParent);
  return resolved;
}
