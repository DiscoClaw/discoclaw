/**
 * Per-task lifecycle lock and ownership markers used to coordinate direct
 * action-owned thread operations with background sync passes.
 */

const TASK_LIFECYCLE_TAILS = new Map<string, Promise<void>>();
const DIRECT_TASK_LIFECYCLE_ACTIVE = new Set<string>();

/**
 * Serialize lifecycle work for a specific task ID.
 */
export async function withTaskLifecycleLock<T>(
  taskId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previousTail = TASK_LIFECYCLE_TAILS.get(taskId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentSignal = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail.then(() => currentSignal);
  TASK_LIFECYCLE_TAILS.set(taskId, currentTail);

  await previousTail;
  try {
    return await work();
  } finally {
    releaseCurrent();
    if (TASK_LIFECYCLE_TAILS.get(taskId) === currentTail) {
      TASK_LIFECYCLE_TAILS.delete(taskId);
    }
  }
}

/**
 * Mark a task as direct-action-owned while its lifecycle work is running.
 * This is used by store-event wiring to avoid duplicate sync ownership.
 */
export async function withDirectTaskLifecycle<T>(
  taskId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withTaskLifecycleLock(taskId, async () => {
    DIRECT_TASK_LIFECYCLE_ACTIVE.add(taskId);
    try {
      return await work();
    } finally {
      DIRECT_TASK_LIFECYCLE_ACTIVE.delete(taskId);
    }
  });
}

export function isDirectTaskLifecycleActive(taskId: string): boolean {
  return DIRECT_TASK_LIFECYCLE_ACTIVE.has(taskId);
}
