import { describe, it, expect } from 'vitest';
import {
  TASK_STATUSES,
  isTaskStatus,
  STATUS_EMOJI,
  BEAD_STATUSES,
  isBeadStatus,
} from './types.js';
import type {
  TaskStatus,
  TaskData,
  TaskSyncResult,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCloseParams,
  TaskListParams,
  BeadStatus,
  BeadData,
  BeadSyncResult,
  BeadCreateParams,
  BeadUpdateParams,
  BeadCloseParams,
  BeadListParams,
} from './types.js';

describe('Bead* compatibility aliases', () => {
  it('BEAD_STATUSES is the same reference as TASK_STATUSES', () => {
    expect(BEAD_STATUSES).toBe(TASK_STATUSES);
  });

  it('isBeadStatus is the same reference as isTaskStatus', () => {
    expect(isBeadStatus).toBe(isTaskStatus);
  });

  it('isBeadStatus accepts valid statuses', () => {
    expect(isBeadStatus('open')).toBe(true);
    expect(isBeadStatus('in_progress')).toBe(true);
    expect(isBeadStatus('blocked')).toBe(true);
    expect(isBeadStatus('closed')).toBe(true);
  });

  it('isBeadStatus rejects invalid statuses', () => {
    expect(isBeadStatus('unknown')).toBe(false);
    expect(isBeadStatus('')).toBe(false);
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

  // Type-level assertions: Bead* aliases must be assignable to/from Task* types.
  // These are compile-time checks; if they compile the test passes at runtime.
  it('Bead* type aliases are structurally identical to Task* types', () => {
    const taskData: TaskData = {
      id: '1',
      title: 'test',
      status: 'open',
    };
    const beadData: BeadData = taskData; // BeadData = TaskData
    const taskData2: TaskData = beadData;
    expect(taskData2).toBe(beadData);

    const taskStatus: TaskStatus = 'open';
    const beadStatus: BeadStatus = taskStatus;
    expect(beadStatus).toBe(taskStatus);

    const syncResult: TaskSyncResult = {
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
      warnings: 0,
    };
    const beadSyncResult: BeadSyncResult = syncResult;
    expect(beadSyncResult).toBe(syncResult);

    const createParams: TaskCreateParams = { title: 'x' };
    const beadCreate: BeadCreateParams = createParams;
    expect(beadCreate).toBe(createParams);

    const updateParams: TaskUpdateParams = { title: 'y' };
    const beadUpdate: BeadUpdateParams = updateParams;
    expect(beadUpdate).toBe(updateParams);

    const closeParams: TaskCloseParams = { reason: 'done' };
    const beadClose: BeadCloseParams = closeParams;
    expect(beadClose).toBe(closeParams);

    const listParams: TaskListParams = { status: 'open' };
    const beadList: BeadListParams = listParams;
    expect(beadList).toBe(listParams);
  });
});
