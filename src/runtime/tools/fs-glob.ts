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
import { resolveAndCheck } from './path-security.js';

export const name = 'list_files';

const MAX_RESULTS = 1000;
const MAX_SCAN_FILES = 5000;

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts").' },
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
    const baseDir = searchPath
      ? await resolveAndCheck(searchPath, allowedRoots)
      : allowedRoots[0];

    const matches: string[] = [];

    if (typeof (fs as unknown as Record<string, unknown>).glob === 'function') {
      // Node 22+ fs.glob
      const globFn = (fs as unknown as { glob: (pattern: string, opts: Record<string, unknown>) => AsyncIterable<string> }).glob;
      for await (const entry of globFn(pattern, { cwd: baseDir })) {
        matches.push(entry);
        if (matches.length >= MAX_RESULTS) break;
      }
    } else {
      // Fallback: recursive readdir + simple glob matching
      const allFiles = await collectFiles(baseDir, baseDir, MAX_SCAN_FILES);
      for (const file of allFiles) {
        if (simpleGlobMatch(file, pattern)) {
          matches.push(file);
          if (matches.length >= MAX_RESULTS) break;
        }
      }
    }

    if (matches.length === 0) {
      return { result: 'No files matched', ok: true };
    }

    return { result: matches.join('\n'), ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: message, ok: false };
  }
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
