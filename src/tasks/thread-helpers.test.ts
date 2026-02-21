import { describe, expect, it } from 'vitest';
import type { TaskData, TagMap } from './types.js';
import {
  buildAppliedTagsWithStatus,
  buildTaskStarterContent,
  buildThreadName,
  extractShortIdFromThreadName,
  getStatusTagIds,
  getThreadIdFromTask,
  shortTaskId,
  taskIdToken,
} from './thread-helpers.js';

describe('thread-helpers', () => {
  it('builds thread names and short-id tokens', () => {
    expect(buildThreadName('ws-001', 'Fix login bug', 'open')).toContain('[001]');
    expect(shortTaskId('ws-010')).toBe('010');
    expect(taskIdToken('ws-010')).toBe('[010]');
  });

  it('extracts short ID from canonical thread names', () => {
    expect(extractShortIdFromThreadName('\u{1F7E1} [042] Add feature')).toBe('042');
    expect(extractShortIdFromThreadName('No match')).toBeNull();
  });

  it('extracts thread ID from external_ref', () => {
    const task = { external_ref: 'discord:123456789' } as TaskData;
    expect(getThreadIdFromTask(task)).toBe('123456789');
    expect(getThreadIdFromTask({ external_ref: 'gh-123' } as TaskData)).toBeNull();
  });

  it('computes status tag IDs and applies status priority', () => {
    const tagMap: TagMap = { open: 's1', closed: 's2', feature: 'c1' };
    expect(getStatusTagIds(tagMap)).toEqual(new Set(['s1', 's2']));
    const updated = buildAppliedTagsWithStatus(['c1', 's1'], 'closed', tagMap);
    expect(updated).toContain('s2');
    expect(updated).not.toContain('s1');
  });

  it('builds starter content with optional mention', () => {
    const task = { id: 'ws-001', status: 'open', priority: 2, description: 'A test task', owner: '' } as TaskData;
    const plain = buildTaskStarterContent(task);
    const mentioned = buildTaskStarterContent(task, '999888777');
    expect(plain).toContain('**ID:** `ws-001`');
    expect(plain).not.toContain('<@999888777>');
    expect(mentioned).toContain('<@999888777>');
  });
});
