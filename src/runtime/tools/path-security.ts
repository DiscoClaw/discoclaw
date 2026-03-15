/**
 * Shared filesystem/path containment gate for runtime tool handlers.
 *
 * Retained guarantee:
 * - `resolveAndCheck()` and `assertPathAllowed()` reject canonical targets
 *   outside the configured allowed roots, including symlink escapes and
 *   non-existent write targets whose nearest existing ancestor escapes.
 *
 * Explicit non-guarantees:
 * - This module does not enforce tool allowlists, file existence, permissions,
 *   size limits, or glob-pattern safety.
 * - Callers only get the containment guarantee when they route the candidate
 *   path through this module before performing filesystem I/O.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const PATH_SECURITY_GATE = 'resolveAndCheck -> assertPathAllowed';
export const NO_ALLOWED_ROOTS_ERROR = 'No allowed roots configured';

function configuredAllowedRoots(roots: readonly string[]): [string, ...string[]] {
  const configured = roots.filter((root): root is string => root.trim().length > 0);
  if (configured.length === 0) {
    throw new Error(NO_ALLOWED_ROOTS_ERROR);
  }
  return configured as [string, ...string[]];
}

function isPathWithinRoot(canonicalPath: string, canonicalRoot: string): boolean {
  const relative = path.relative(canonicalRoot, canonicalPath);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

/**
 * Canonicalize the configured allowed roots for containment comparison.
 * Falls back to path.resolve if a root does not exist yet.
 */
export async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  const configured = configuredAllowedRoots(roots);
  const canonical: string[] = [];
  for (const root of configured) {
    try {
      canonical.push(await fs.realpath(root));
    } catch {
      canonical.push(path.resolve(root));
    }
  }
  return canonical;
}

/**
 * Concrete containment gate named by `PATH_SECURITY_GATE`.
 * Canonicalizes the target (or nearest existing ancestor when needed) and
 * rejects paths whose canonical location is outside the configured roots.
 */
export async function assertPathAllowed(
  targetPath: string,
  allowedRoots: readonly string[],
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

  const allowed = isPathUnderRoots(canonical, canonicalRoots);
  if (!allowed) {
    throw new Error(`Path outside allowed roots: ${targetPath}`);
  }
}

/**
 * Pure containment predicate used after canonicalization.
 * Both the path and roots should already be resolved (e.g. via fs.realpath).
 */
export function isPathUnderRoots(
  canonicalPath: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => root.length > 0 && isPathWithinRoot(canonicalPath, root));
}

/**
 * Resolve a user-supplied file path against the first configured allowed root,
 * then enforce containment via `PATH_SECURITY_GATE`.
 */
export async function resolveAndCheck(
  filePath: string,
  allowedRoots: readonly string[],
  checkParent = false,
): Promise<string> {
  const configured = configuredAllowedRoots(allowedRoots);
  const resolved = path.resolve(configured[0], filePath);
  await assertPathAllowed(resolved, configured, checkParent);
  return resolved;
}
