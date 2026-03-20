import { describe, it, expect } from 'vitest';
import {
  actionDedupeKey,
  isDuplicateAction,
  buildActionHistorySummary,
  QUERY_ACTION_TYPES,
} from './action-categories.js';
import type { ActionHistoryEntry } from './action-categories.js';

describe('actionDedupeKey', () => {
  it('uses type alone when no distinguishing param', () => {
    expect(actionDedupeKey({ type: 'channelList' })).toBe('channelList');
  });

  it('uses type + taskId', () => {
    expect(actionDedupeKey({ type: 'taskUpdate', taskId: 'ws-123' })).toBe('taskUpdate:ws-123');
  });

  it('uses type + channelId', () => {
    expect(actionDedupeKey({ type: 'readMessages', channelId: '456' })).toBe('readMessages:456');
  });

  it('uses type + channel when channelId is absent', () => {
    expect(actionDedupeKey({ type: 'readMessages', channel: '#general' })).toBe('readMessages:#general');
  });

  it('picks first matching field in priority order', () => {
    // taskId takes precedence over channelId
    expect(actionDedupeKey({ type: 'taskShow', taskId: 'ws-1', channelId: '999' })).toBe('taskShow:ws-1');
  });
});

describe('isDuplicateAction', () => {
  const history: ActionHistoryEntry[] = [
    { type: 'taskUpdate', key: 'taskUpdate:ws-1', ok: true },
    { type: 'taskCreate', key: 'taskCreate', ok: false },
    { type: 'readMessages', key: 'readMessages:#general', ok: true },
  ];

  it('returns true for a non-query action that already succeeded', () => {
    expect(isDuplicateAction('taskUpdate:ws-1', 'taskUpdate', history)).toBe(true);
  });

  it('returns false for a non-query action that failed previously', () => {
    expect(isDuplicateAction('taskCreate', 'taskCreate', history)).toBe(false);
  });

  it('returns false for query actions even if they succeeded (re-querying is OK)', () => {
    expect(isDuplicateAction('readMessages:#general', 'readMessages', history)).toBe(false);
  });

  it('returns false for actions not in history', () => {
    expect(isDuplicateAction('taskClose:ws-99', 'taskClose', history)).toBe(false);
  });

  it('returns false with empty history', () => {
    expect(isDuplicateAction('taskUpdate:ws-1', 'taskUpdate', [])).toBe(false);
  });
});

describe('buildActionHistorySummary', () => {
  it('returns empty string for empty history', () => {
    expect(buildActionHistorySummary([])).toBe('');
  });

  it('builds a readable summary', () => {
    const history: ActionHistoryEntry[] = [
      { type: 'taskList', key: 'taskList', ok: true },
      { type: 'modelSet', key: 'modelSet:chat', ok: false },
    ];
    const summary = buildActionHistorySummary(history);
    expect(summary).toContain('do NOT re-emit');
    expect(summary).toContain('taskList: succeeded');
    expect(summary).toContain('modelSet: failed');
  });
});
