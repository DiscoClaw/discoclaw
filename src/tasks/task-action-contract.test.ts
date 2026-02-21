import { describe, expect, it } from 'vitest';
import { isTaskActionRequest, isTaskActionType, TASK_ACTION_TYPES } from './task-action-contract.js';

describe('task-action-contract guards', () => {
  it('accepts canonical task action types', () => {
    for (const type of TASK_ACTION_TYPES) {
      expect(isTaskActionType(type)).toBe(true);
    }
  });

  it('recognizes task action requests by type', () => {
    expect(isTaskActionRequest({ type: 'taskCreate' })).toBe(true);
    expect(isTaskActionRequest({ type: 'taskSync' })).toBe(true);
    expect(isTaskActionRequest({ type: 'channelCreate' })).toBe(false);
    expect(isTaskActionRequest({ type: 42 })).toBe(false);
    expect(isTaskActionRequest({})).toBe(false);
  });
});
