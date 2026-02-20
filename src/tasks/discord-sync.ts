/**
 * Canonical task namespace for Discord thread sync helpers.
 * Legacy implementation currently lives in `src/beads/discord-sync.ts`.
 */
export {
  loadTagMap,
  resolveTasksForum,
  buildThreadName,
  buildAppliedTagsWithStatus,
  createTaskThread,
  closeTaskThread,
  updateTaskThreadName,
  updateTaskStarterMessage,
  updateTaskThreadTags,
  ensureUnarchived,
  getThreadIdFromTask,
  reloadTagMapInPlace,
  findExistingThreadForTask,
} from '../beads/discord-sync.js';
