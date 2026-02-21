type TaskCreatePayload = {
  title: string;
  description?: string;
  priority?: number;
  tags?: string;
};

type TaskUpdatePayload = {
  taskId?: string;
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
};

type TaskClosePayload = {
  taskId?: string;
  reason?: string;
};

type TaskShowPayload = {
  taskId?: string;
};

type TaskListPayload = {
  status?: string;
  label?: string;
  limit?: number;
};

export type TaskActionRequest =
  | ({ type: 'taskCreate' } & TaskCreatePayload)
  | ({ type: 'taskUpdate' } & TaskUpdatePayload)
  | ({ type: 'taskClose' } & TaskClosePayload)
  | ({ type: 'taskShow' } & TaskShowPayload)
  | ({ type: 'taskList' } & TaskListPayload)
  | { type: 'taskSync' }
  | { type: 'tagMapReload' };

const TASK_TYPE_MAP: Record<TaskActionRequest['type'], true> = {
  taskCreate: true,
  taskUpdate: true,
  taskClose: true,
  taskShow: true,
  taskList: true,
  taskSync: true,
  tagMapReload: true,
};

export const TASK_ACTION_TYPES = new Set<string>(Object.keys(TASK_TYPE_MAP));

export function isTaskActionType(type: string): type is TaskActionRequest['type'] {
  return TASK_ACTION_TYPES.has(type);
}

export function isTaskActionRequest(action: { type?: unknown }): action is TaskActionRequest {
  return typeof action.type === 'string' && isTaskActionType(action.type);
}
