import {
  findTaskByThreadId,
  TaskThreadCache,
  taskThreadCache,
} from '../tasks/thread-cache.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/thread-cache.ts`.
 */
export const findBeadByThreadId = findTaskByThreadId;
export { TaskThreadCache as BeadThreadCache };
export const beadThreadCache = taskThreadCache;
