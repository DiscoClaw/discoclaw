import type {
  TaskCloseParams,
  TaskCreateParams,
  TaskData,
  TaskListParams,
  TaskUpdateParams,
} from './types.js';
import type { TaskStore } from './store.js';

export type TaskService = {
  get(id: string): TaskData | undefined;
  list(params?: TaskListParams): TaskData[];
  findByTitle(title: string, opts?: { label?: string }): TaskData | null;
  create(params: TaskCreateParams): TaskData;
  update(id: string, params: TaskUpdateParams): TaskData;
  close(id: string, reason?: TaskCloseParams['reason']): TaskData;
  addLabel(id: string, label: string): TaskData;
  removeLabel(id: string, label: string): TaskData;
};

/**
 * Track 2 mutation entrypoint.
 * This wraps TaskStore so callers can depend on one service contract while
 * we progressively move domain rules out of adapters.
 */
export function createTaskService(store: TaskStore): TaskService {
  return {
    get(id) {
      return store.get(id);
    },
    list(params) {
      return store.list(params);
    },
    findByTitle(title, opts) {
      return store.findByTitle(title, opts);
    },
    create(params) {
      return store.create(params);
    },
    update(id, params) {
      return store.update(id, params);
    },
    close(id, reason) {
      return store.close(id, reason);
    },
    addLabel(id, label) {
      return store.addLabel(id, label);
    },
    removeLabel(id, label) {
      return store.removeLabel(id, label);
    },
  };
}
