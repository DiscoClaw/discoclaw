import type { TaskStore } from './store.js';

/**
 * Canonical task-context summary shape.
 */
export type TaskContextSummary = {
  summary: string;
  description?: string;
};

type ContextLogger = { warn?: (meta: unknown, message: string) => void };

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Build a thread-scoped task context summary from the in-process TaskStore.
 */
export function buildTaskContextSummary(
  taskId: string | undefined,
  store: TaskStore | undefined,
  _log?: ContextLogger,
): TaskContextSummary | undefined {
  if (!taskId || !store) return undefined;
  const task = store.get(taskId);
  if (!task) return undefined;
  const lines = ['Task context for this thread:'];
  if (task.title) lines.push(`Title: ${task.title}`);
  let description: string | undefined;
  if (task.description) {
    const desc = task.description.trim().replace(/\s+/g, ' ');
    const truncated = truncateText(desc, 400);
    lines.push(`Description: ${truncated}`);
    description = truncated;
  }
  return {
    summary: lines.join('\n'),
    description,
  };
}

// Bead* compatibility alias
export const buildBeadContextSummary = buildTaskContextSummary;
