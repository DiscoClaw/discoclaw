import {
  shortTaskId,
  taskIdToken,
  resolveTasksForum,
  getThreadIdFromTask,
  buildTaskStarterContent,
  createTaskThread,
  findExistingThreadForTask,
  closeTaskThread,
  isTaskThreadAlreadyClosed,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
} from '../tasks/discord-sync.js';

/**
 * Legacy compatibility shim. Canonical implementation now lives at
 * `src/tasks/discord-sync.ts`.
 */
export * from '../tasks/discord-sync.js';
export { shortTaskId as shortBeadId };
export { taskIdToken as beadIdToken };
export { resolveTasksForum as resolveBeadsForum };
export { getThreadIdFromTask as getThreadIdFromBead };
export { buildTaskStarterContent as buildBeadStarterContent };
export { createTaskThread as createBeadThread };
export { findExistingThreadForTask as findExistingThreadForBead };
export { closeTaskThread as closeBeadThread };
export { isTaskThreadAlreadyClosed as isBeadThreadAlreadyClosed };
export { updateTaskThreadName as updateBeadThreadName };
export { updateTaskStarterMessage as updateBeadStarterMessage };
export { updateTaskThreadTags as updateBeadThreadTags };
