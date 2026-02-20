import type { RuntimeAdapter } from '../runtime/types.js';
import { autoTagBead } from '../beads/auto-tag.js';

/**
 * Canonical task-named auto-tag helper.
 */
export function autoTagTask(
  runtime: RuntimeAdapter,
  title: string,
  description: string,
  availableTags: string[],
  opts?: { model?: string; cwd?: string },
): Promise<string[]> {
  return autoTagBead(runtime, title, description, availableTags, opts);
}
