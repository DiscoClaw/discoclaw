import { describe, expect, it } from 'vitest';
import {
  TASK_DIRECT_THREAD_ACTIONS,
  TASK_STORE_MUTATION_EVENTS,
  shouldActionUseDirectThreadLifecycle,
} from './sync-contract.js';

describe('task sync contract', () => {
  it('defines a stable TaskStore mutation universe', () => {
    expect(TASK_STORE_MUTATION_EVENTS).toEqual(['created', 'updated', 'closed', 'labeled']);
  });

  it('marks direct thread lifecycle ownership for create/update/close actions', () => {
    expect(TASK_DIRECT_THREAD_ACTIONS).toEqual(['taskCreate', 'taskUpdate', 'taskClose']);
    expect(shouldActionUseDirectThreadLifecycle('taskCreate')).toBe(true);
    expect(shouldActionUseDirectThreadLifecycle('taskUpdate')).toBe(true);
    expect(shouldActionUseDirectThreadLifecycle('taskClose')).toBe(true);
  });

  it('keeps non-lifecycle actions out of direct thread ownership', () => {
    expect(shouldActionUseDirectThreadLifecycle('taskShow')).toBe(false);
    expect(shouldActionUseDirectThreadLifecycle('taskList')).toBe(false);
    expect(shouldActionUseDirectThreadLifecycle('taskSync')).toBe(false);
    expect(shouldActionUseDirectThreadLifecycle('tagMapReload')).toBe(false);
  });
});
