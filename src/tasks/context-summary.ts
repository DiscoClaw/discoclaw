import { buildBeadContextSummary } from '../beads/bd-cli.js';
import type { TaskStore } from './store.js';

/**
 * Canonical task-named wrapper for thread-scoped task context summaries.
 */
export function buildTaskContextSummary(
  taskId: string | undefined,
  store: TaskStore | undefined,
): { summary: string; description?: string } | undefined {
  return buildBeadContextSummary(taskId, store);
}
