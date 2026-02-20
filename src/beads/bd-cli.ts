import {
  buildTaskContextSummary,
} from '../tasks/context-summary.js';
import {
  normalizeTaskData,
} from '../tasks/bd-cli.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/bd-cli.ts`.
 */
export * from '../tasks/bd-cli.js';
export const buildBeadContextSummary = buildTaskContextSummary;
export const normalizeBeadData = normalizeTaskData;
