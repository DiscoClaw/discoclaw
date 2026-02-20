/**
 * Task sync contract
 *
 * This module is the canonical source for task-thread lifecycle ownership:
 * - Which TaskStore mutation events trigger coordinator sync.
 * - Which task actions perform direct thread lifecycle operations.
 *
 * Keep this contract behavior-only; avoid importing Discord/runtime modules.
 */

export const TASK_STORE_MUTATION_EVENTS = ['created', 'updated', 'closed', 'labeled'] as const;
export type TaskStoreMutationEvent = (typeof TASK_STORE_MUTATION_EVENTS)[number];

export const TASK_SYNC_TRIGGER_EVENTS = ['updated', 'closed', 'labeled'] as const;
export type TaskSyncTriggerEvent = (typeof TASK_SYNC_TRIGGER_EVENTS)[number];

const TASK_SYNC_TRIGGER_EVENT_SET = new Set<TaskStoreMutationEvent>(TASK_SYNC_TRIGGER_EVENTS);

export function shouldTriggerTaskSyncForStoreEvent(event: TaskStoreMutationEvent): boolean {
  return TASK_SYNC_TRIGGER_EVENT_SET.has(event);
}

export type TaskLifecycleAction = 'taskCreate' | 'taskUpdate' | 'taskClose' | 'taskShow' | 'taskList' | 'taskSync' | 'tagMapReload';

export const TASK_DIRECT_THREAD_ACTIONS = ['taskCreate', 'taskUpdate', 'taskClose'] as const;
type TaskDirectThreadAction = (typeof TASK_DIRECT_THREAD_ACTIONS)[number];

const TASK_DIRECT_THREAD_ACTION_SET = new Set<TaskLifecycleAction>(TASK_DIRECT_THREAD_ACTIONS);

/**
 * Direct thread lifecycle ownership (create/update/close) remains in action flow
 * for these actions; other actions rely on coordinator-only sync.
 */
export function shouldActionUseDirectThreadLifecycle(actionType: TaskLifecycleAction): actionType is TaskDirectThreadAction {
  return TASK_DIRECT_THREAD_ACTION_SET.has(actionType);
}
