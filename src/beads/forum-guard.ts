import {
  initTasksForumGuard,
  type TasksForumGuardOptions,
} from '../tasks/forum-guard.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/forum-guard.ts`.
 */
export type BeadsForumGuardOptions = TasksForumGuardOptions;
export const initBeadsForumGuard = initTasksForumGuard;
