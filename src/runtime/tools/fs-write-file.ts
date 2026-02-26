/**
 * OpenAI function-calling tool: write_file
 *
 * Writes content to a file, creating parent directories as needed.
 * Overwrites the file if it already exists.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { OpenAIFunctionTool, ToolResult } from './types.js';
import { resolveAndCheck } from './path-security.js';

export const name = 'write_file';

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write content to a file, creating or overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write.' },
        content: { type: 'string', description: 'The full content to write to the file.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
};

export async function execute(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  if (!filePath) return { result: 'file_path is required', ok: false };
  if (typeof content !== 'string') return { result: 'content is required', ok: false };

  try {
    const resolved = await resolveAndCheck(filePath, allowedRoots, true);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');

    return { result: `Wrote ${Buffer.byteLength(content)} bytes to ${resolved}`, ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: message, ok: false };
  }
}
