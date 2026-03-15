import { describe, it, expect } from 'vitest';
import {
  TASK_STATUSES,
  isTaskStatus,
  STATUS_EMOJI,
} from './types.js';
import type {
  TaskStatus,
  TaskData,
  TaskSyncResult,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCloseParams,
  TaskListParams,
} from './types.js';

describe('Task types', () => {
  it('isTaskStatus accepts valid statuses', () => {
    expect(isTaskStatus('open')).toBe(true);
    expect(isTaskStatus('in_progress')).toBe(true);
    expect(isTaskStatus('blocked')).toBe(true);
    expect(isTaskStatus('closed')).toBe(true);
  });

  it('isTaskStatus rejects invalid statuses', () => {
    expect(isTaskStatus('unknown')).toBe(false);
    expect(isTaskStatus('')).toBe(false);
  });

  it('STATUS_EMOJI is indexable with a plain string', () => {
    const status: string = 'open';
    // This must compile and return a value (widened type check)
    expect(STATUS_EMOJI[status]).toBe('\u{1F7E2}');
  });

  it('STATUS_EMOJI covers all TASK_STATUSES', () => {
    for (const s of TASK_STATUSES) {
      expect(STATUS_EMOJI[s]).toBeDefined();
    }
  });

  // Type-level assertions for canonical task types.
  // These are compile-time checks; if they compile the test passes at runtime.
  it('Task types are assignable in expected shapes', () => {
    const taskData: TaskData = {
      id: '1',
      title: 'test',
      status: 'open',
    };
    const taskData2: TaskData = taskData;
    expect(taskData2).toBe(taskData);

    const taskStatus: TaskStatus = 'open';
    expect(taskStatus).toBe('open');

    const syncResult: TaskSyncResult = {
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
      warnings: 0,
    };
    const syncResult2: TaskSyncResult = syncResult;
    expect(syncResult2).toBe(syncResult);

    const createParams: TaskCreateParams = { title: 'x' };
    const createParams2: TaskCreateParams = createParams;
    expect(createParams2).toBe(createParams);

    const updateParams: TaskUpdateParams = { title: 'y' };
    const updateParams2: TaskUpdateParams = updateParams;
    expect(updateParams2).toBe(updateParams);

    const closeParams: TaskCloseParams = { reason: 'done' };
    const closeParams2: TaskCloseParams = closeParams;
    expect(closeParams2).toBe(closeParams);

    const listParams: TaskListParams = { status: 'open' };
    const listParams2: TaskListParams = listParams;
    expect(listParams2).toBe(listParams);
  });
});
