import type { TaskStatus } from './types.js';
import { TASK_STATUSES } from './types.js';
import {
  TASK_DIRECT_THREAD_ACTIONS,
  TASK_STORE_MUTATION_EVENTS,
  TASK_SYNC_TRIGGER_EVENTS,
} from './sync-contract.js';

const ALL_TASK_STATUSES = [...TASK_STATUSES] as readonly TaskStatus[];

/**
 * Track 1 freezes current runtime behavior:
 * TaskStore status updates are currently permissive across all statuses.
 * Future domain-level restrictions should be introduced via TaskService.
 */
export const TASK_STORE_ALLOWED_STATUS_TRANSITIONS = {
  open: ALL_TASK_STATUSES,
  in_progress: ALL_TASK_STATUSES,
  blocked: ALL_TASK_STATUSES,
  closed: ALL_TASK_STATUSES,
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

export function isTaskStoreStatusTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STORE_ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export const TASK_STORE_MUTATION_EVENT_RULES = {
  create: ['created'],
  update: ['updated'],
  close: ['closed'],
  addLabel: ['labeled'],
  removeLabel: ['updated'],
  addLabelNoop: [],
  removeLabelNoop: [],
} as const;

export const TASK_ARCHITECTURE_CONTRACT = {
  storeMutationEvents: TASK_STORE_MUTATION_EVENTS,
  syncTriggerEvents: TASK_SYNC_TRIGGER_EVENTS,
  directThreadLifecycleActions: TASK_DIRECT_THREAD_ACTIONS,
  statusTransitions: TASK_STORE_ALLOWED_STATUS_TRANSITIONS,
  mutationEventRules: TASK_STORE_MUTATION_EVENT_RULES,
} as const;
