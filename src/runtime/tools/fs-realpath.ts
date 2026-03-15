/**
 * OpenAI function-calling tool: realpath
 *
 * Resolves a file or directory path to its canonical absolute path,
 * following all symlinks. Returns an error if the path does not exist
 * or falls outside the allowed roots.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { OpenAIFunctionTool, ToolResult } from './types.js';
import { canonicalizeRoots } from './path-security.js';

export const name = 'realpath';

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'realpath',
    description: 'Resolve the canonical absolute path of a file or directory, following symlinks.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to resolve (absolute or relative to workspace).' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
};

export async function execute(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const filePath = args.file_path as string;
  if (!filePath) return { result: 'file_path is required', ok: false };

  // Resolve relative paths against the first allowed root
  const resolved = path.resolve(allowedRoots[0], filePath);

  let canonical: string;
  try {
    canonical = await fs.realpath(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { result: `Path does not exist: ${resolved}`, ok: false };
    }
    return { result: `Cannot resolve path: ${resolved}`, ok: false };
  }

  // Verify the canonical path falls within allowed roots
  const canonicalRoots = await canonicalizeRoots(allowedRoots);
  const allowed = canonicalRoots.some(
    (root) => canonical === root || canonical.startsWith(root + path.sep),
  );
  if (!allowed) {
    return { result: `Path outside allowed roots: ${filePath}`, ok: false };
  }

  return { result: canonical, ok: true };
}
