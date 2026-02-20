import {
  autoTagTask,
  type AutoTagOptions,
} from '../tasks/auto-tag.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/auto-tag.ts`.
 */
export { AutoTagOptions };
export const autoTagBead = autoTagTask;
