/**
 * OpenAI function-calling tool: read_file
 *
 * Reads the contents of a file at a given path, with optional line
 * offset and limit for partial reads. Enforces a 1 MB size cap.
 */

import fs from 'node:fs/promises';

import type { OpenAIFunctionTool, ToolResult } from './types.js';
import { resolveAndCheck } from './path-security.js';

export const name = 'read_file';

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based).' },
        limit: { type: 'number', description: 'Maximum number of lines to read.' },
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

  try {
    const resolved = await resolveAndCheck(filePath, allowedRoots);

    const stat = await fs.stat(resolved);
    if (stat.size > MAX_READ_BYTES) {
      return { result: `File too large: ${stat.size} bytes (max ${MAX_READ_BYTES})`, ok: false };
    }

    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');

    const offset = typeof args.offset === 'number' ? Math.max(0, args.offset - 1) : 0; // 1-based to 0-based
    const limit = typeof args.limit === 'number' ? args.limit : lines.length;
    const sliced = lines.slice(offset, offset + limit);

    return { result: sliced.join('\n'), ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: message, ok: false };
  }
}
