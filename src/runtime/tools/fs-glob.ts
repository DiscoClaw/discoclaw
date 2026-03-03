/**
 * OpenAI function-calling tool: list_files
 *
 * Finds files matching a glob pattern within allowed directories.
 * Uses Node 22+ fs.glob when available, falling back to recursive
 * readdir with simple glob matching.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { OpenAIFunctionTool, ToolResult } from './types.js';
import { assertPathAllowed, resolveAndCheck } from './path-security.js';

export const name = 'list_files';

const MAX_RESULTS = 1000;
const MAX_SCAN_FILES = 5000;

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'Find files matching a relative glob pattern within allowed roots.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Relative in-root glob pattern to match (e.g. "**/*.ts").',
        },
        path: { type: 'string', description: 'Directory to search in.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
};

export async function execute(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  if (!pattern) return { result: 'pattern is required', ok: false };

  try {
    const validationError = validateListFilesPattern(pattern);
    if (validationError) return { result: `Invalid glob pattern: ${validationError}`, ok: false };

    const baseDir = searchPath
      ? await resolveAndCheck(searchPath, allowedRoots)
      : allowedRoots[0];

    const matches: string[] = [];

    if (typeof (fs as unknown as Record<string, unknown>).glob === 'function') {
      // Node 22+ fs.glob
      const globFn = (fs as unknown as { glob: (pattern: string, opts: Record<string, unknown>) => AsyncIterable<string> }).glob;
      for await (const entry of globFn(pattern, { cwd: baseDir })) {
        try {
          const safeEntry = await normalizeContainedGlobMatch(entry, baseDir, allowedRoots);
          matches.push(safeEntry);
        } catch {
          return { result: `Unsafe glob match rejected: ${entry}`, ok: false };
        }
        if (matches.length >= MAX_RESULTS) break;
      }
    } else {
      // Fallback: recursive readdir + simple glob matching
      const allFiles = await collectFiles(baseDir, baseDir, MAX_SCAN_FILES);
      for (const file of allFiles) {
        if (simpleGlobMatch(file, pattern)) {
          try {
            const safeEntry = await normalizeContainedGlobMatch(file, baseDir, allowedRoots);
            matches.push(safeEntry);
          } catch {
            return { result: `Unsafe glob match rejected: ${file}`, ok: false };
          }
          if (matches.length >= MAX_RESULTS) break;
        }
      }
    }

    // Defense in depth: containment-check every output line right before returning.
    const verifiedMatches: string[] = [];
    for (const match of matches) {
      try {
        const safeEntry = await normalizeContainedGlobMatch(match, baseDir, allowedRoots);
        verifiedMatches.push(safeEntry);
      } catch {
        return { result: `Unsafe glob match rejected: ${match}`, ok: false };
      }
    }

    if (verifiedMatches.length === 0) {
      return { result: 'No files matched', ok: true };
    }

    return { result: verifiedMatches.join('\n'), ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: message, ok: false };
  }
}

function validateListFilesPattern(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.includes('\0')) {
    return 'pattern contains invalid characters';
  }

  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    return 'pattern must be relative';
  }

  if (/^[A-Za-z]:/.test(pattern)) {
    return 'pattern must be relative';
  }

  const normalized = pattern.replace(/\\/g, '/');
  // Reject absolute path branches hidden inside brace/extglob alternatives.
  if (/(^|[({,|])\s*\/+/.test(normalized)) {
    return 'pattern must be relative';
  }

  // Treat common glob wrappers as separators so traversal hidden in braces,
  // extglob groups, or character classes is still rejected.
  const normalizedForTraversalCheck = normalized.replace(/[{},()[\]|]/g, '/');
  const segments = normalizedForTraversalCheck.split('/');
  if (segments.some((segment) => segment === '..')) {
    return 'pattern cannot contain parent directory traversal';
  }

  return null;
}

async function normalizeContainedGlobMatch(
  entry: string,
  baseDir: string,
  allowedRoots: string[],
): Promise<string> {
  const candidate = path.resolve(baseDir, entry);
  await assertPathAllowed(candidate, allowedRoots);

  const relativeToBase = path.relative(baseDir, candidate);
  if (
    relativeToBase === '' ||
    relativeToBase === '.' ||
    relativeToBase.startsWith(`..${path.sep}`) ||
    relativeToBase === '..' ||
    path.isAbsolute(relativeToBase)
  ) {
    throw new Error(`Glob match escaped base path: ${entry}`);
  }

  return relativeToBase.split(path.sep).join('/');
}

/** Recursively collect relative file paths. */
async function collectFiles(dir: string, base: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= limit) break;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = await collectFiles(full, base, limit - results.length);
      results.push(...sub);
    } else {
      results.push(rel);
    }
  }
  return results;
}

/** Basic glob matching: ** → any path, * → any non-sep, ? → single char. */
export function simpleGlobMatch(file: string, pattern: string): boolean {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * and ?)
    .replace(/\*\*/g, '\0DOUBLESTAR\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0DOUBLESTAR\0/g, '.*')
    .replace(/\?/g, '[^/]');
  re = '^' + re + '$';
  return new RegExp(re).test(file);
}
