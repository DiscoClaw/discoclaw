import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildThreadName, buildTaskStarterContent, getThreadIdFromTask, updateTaskStarterMessage, closeTaskThread, isTaskThreadAlreadyClosed, isThreadArchived, reloadTagMapInPlace, getStatusTagIds, buildAppliedTagsWithStatus, updateTaskThreadTags, createTaskThread, shortTaskId, taskIdToken, extractShortIdFromThreadName } from './discord-sync.js';
import type { TaskData, TagMap } from '../tasks/types.js';

// ---------------------------------------------------------------------------
// buildThreadName
// ---------------------------------------------------------------------------

describe('buildThreadName', () => {
  it('builds name with emoji prefix and ID', () => {
    const name = buildThreadName('ws-001', 'Fix login bug', 'open');
    expect(name).toBe('\u{1F7E2} [001] Fix login bug');
  });

  it('uses yellow emoji for in_progress', () => {
    const name = buildThreadName('ws-002', 'Add feature', 'in_progress');
    expect(name).toContain('\u{1F7E1}');
  });

  it('uses checkmark for closed', () => {
    const name = buildThreadName('ws-003', 'Done task', 'closed');
    expect(name).toContain('\u2611\uFE0F');
  });

  it('uses prohibition for blocked', () => {
    const name = buildThreadName('ws-004', 'Blocked task', 'blocked');
    expect(name).toContain('\u26A0\uFE0F');
  });

  it('truncates long titles to 100 chars total', () => {
    const longTitle = 'A'.repeat(200);
    const name = buildThreadName('ws-001', longTitle, 'open');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain('\u2026'); // ellipsis
  });

  it('defaults to open emoji for unknown status', () => {
    const name = buildThreadName('ws-001', 'Test', 'unknown_status');
    expect(name).toContain('\u{1F7E2}');
  });
});

// ---------------------------------------------------------------------------
// buildTaskStarterContent
// ---------------------------------------------------------------------------

describe('buildTaskStarterContent', () => {
  const makeTask = (overrides?: Partial<TaskData>): TaskData => ({
    id: 'ws-001',
    title: 'Test',
    description: 'A test bead',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: '',
    labels: [],
    comments: [],
    created_at: '',
    updated_at: '',
    close_reason: '',
    ...overrides,
  });

  it('produces correct format with description, ID, priority, status', () => {
    const content = buildTaskStarterContent(makeTask());
    expect(content).toContain('A test bead');
    expect(content).toContain('**ID:** `ws-001`');
    expect(content).toContain('**Priority:** P2');
    expect(content).toContain('**Status:** open');
  });

  it('includes owner when present', () => {
    const content = buildTaskStarterContent(makeTask({ owner: 'alice' }));
    expect(content).toContain('**Owner:** alice');
  });

  it('omits owner when empty', () => {
    const content = buildTaskStarterContent(makeTask({ owner: '' }));
    expect(content).not.toContain('**Owner:**');
  });

  it('does not include mention lines when mentionUserId omitted', () => {
    const content = buildTaskStarterContent(makeTask());
    expect(content).not.toContain('<@');
  });

  it('appends mention when mentionUserId provided', () => {
    const content = buildTaskStarterContent(makeTask(), '999888777');
    expect(content).toContain('<@999888777>');
  });

  it('defaults priority to P2 when undefined', () => {
    const content = buildTaskStarterContent(makeTask({ priority: undefined as any }));
    expect(content).toContain('**Priority:** P2');
  });
});

// ---------------------------------------------------------------------------
// getThreadIdFromTask
// ---------------------------------------------------------------------------

describe('getThreadIdFromTask', () => {
  const makeTask = (externalRef: string): TaskData => ({
    id: 'ws-001',
    title: 'Test',
    description: '',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: externalRef,
    labels: [],
    comments: [],
    created_at: '',
    updated_at: '',
    close_reason: '',
  });

  it('extracts thread ID from discord: prefix', () => {
    expect(getThreadIdFromTask(makeTask('discord:123456789'))).toBe('123456789');
  });

  it('extracts raw numeric ID', () => {
    expect(getThreadIdFromTask(makeTask('123456789'))).toBe('123456789');
  });

  it('returns null for empty external_ref', () => {
    expect(getThreadIdFromTask(makeTask(''))).toBeNull();
  });

  it('returns null for non-discord external_ref', () => {
    expect(getThreadIdFromTask(makeTask('gh-123'))).toBeNull();
  });

  it('handles whitespace', () => {
    expect(getThreadIdFromTask(makeTask('  discord:123  '))).toBe('123');
  });
});

// ---------------------------------------------------------------------------
// updateTaskStarterMessage
// ---------------------------------------------------------------------------

describe('updateTaskStarterMessage', () => {
  const task: TaskData = {
    id: 'ws-001',
    title: 'Test',
    description: 'A test bead',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: '',
    labels: [],
    comments: [],
    created_at: '',
    updated_at: '',
    close_reason: '',
  };

  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
      user: { id: 'bot-123' },
    };
  }

  function makeThread(starterOverrides?: Record<string, any>): any {
    const editFn = vi.fn();
    return {
      isThread: () => true,
      fetchStarterMessage: vi.fn(async () => ({
        author: { id: 'bot-123' },
        content: 'old content',
        edit: editFn,
        ...starterOverrides,
      })),
      _editFn: editFn,
    };
  }

  it('returns false when thread is not found', async () => {
    const client = { channels: { cache: { get: () => undefined } }, user: { id: 'bot-123' } } as any;
    expect(await updateTaskStarterMessage(client, 'missing', task)).toBe(false);
  });

  it('returns false when fetchStarterMessage throws', async () => {
    const thread = {
      isThread: () => true,
      fetchStarterMessage: vi.fn(async () => { throw new Error('not found'); }),
    };
    expect(await updateTaskStarterMessage(makeClient(thread), '123', task)).toBe(false);
  });

  it('returns false when starter is not bot-authored', async () => {
    const thread = makeThread({ author: { id: 'user-456' } });
    expect(await updateTaskStarterMessage(makeClient(thread), '123', task)).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('returns false when content is already identical (idempotent)', async () => {
    const currentContent = buildTaskStarterContent(task);
    const thread = makeThread({ content: currentContent });
    expect(await updateTaskStarterMessage(makeClient(thread), '123', task)).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('edits starter and returns true when content differs', async () => {
    const thread = makeThread({ content: 'stale content' });
    const result = await updateTaskStarterMessage(makeClient(thread), '123', task);
    expect(result).toBe(true);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: buildTaskStarterContent(task),
      allowedMentions: { parse: [], users: [] },
    });
  });

  it('passes mentionUserId to content builder and sets allowedMentions.users', async () => {
    const thread = makeThread({ content: 'stale content' });
    const result = await updateTaskStarterMessage(makeClient(thread), '123', task, '999');
    expect(result).toBe(true);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: buildTaskStarterContent(task, '999'),
      allowedMentions: { parse: [], users: ['999'] },
    });
  });

  it('skips edit when mention content already matches', async () => {
    const contentWithMention = buildTaskStarterContent(task, '999');
    const thread = makeThread({ content: contentWithMention });
    const result = await updateTaskStarterMessage(makeClient(thread), '123', task, '999');
    expect(result).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// closeTaskThread
// ---------------------------------------------------------------------------

describe('closeTaskThread', () => {
  const task: TaskData = {
    id: 'ws-001',
    title: 'Test',
    description: 'A test bead',
    status: 'closed',
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: '',
    labels: [],
    comments: [],
    created_at: '',
    updated_at: '',
    close_reason: 'Done',
  };

  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
      user: { id: 'bot-123' },
    };
  }

  function makeCloseThread(opts?: { starterContent?: string; starterAuthorId?: string; archived?: boolean }): any {
    const editFn = vi.fn();
    const sendFn = vi.fn();
    const setNameFn = vi.fn();
    const setArchivedFn = vi.fn();
    const fetchStarterFn = vi.fn(async () => ({
      author: { id: opts?.starterAuthorId ?? 'bot-123' },
      content: opts?.starterContent ?? 'old content',
      edit: editFn,
    }));

    return {
      isThread: () => true,
      archived: opts?.archived ?? false,
      fetchStarterMessage: fetchStarterFn,
      send: sendFn,
      setName: setNameFn,
      setArchived: setArchivedFn,
      _editFn: editFn,
      _sendFn: sendFn,
      _setNameFn: setNameFn,
      _setArchivedFn: setArchivedFn,
      _fetchStarterFn: fetchStarterFn,
    };
  }

  it('strips mention from starter message before archiving', async () => {
    const contentWithMention = buildTaskStarterContent(task, '999');
    const thread = makeCloseThread({ starterContent: contentWithMention });
    const client = makeClient(thread);

    await closeTaskThread(client, 'thread-1', task);

    const cleanContent = buildTaskStarterContent(task);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: cleanContent.slice(0, 2000),
      allowedMentions: { parse: [], users: [] },
    });
  });

  it('skips starter edit when content has no mention', async () => {
    const cleanContent = buildTaskStarterContent(task);
    const thread = makeCloseThread({ starterContent: cleanContent });
    const client = makeClient(thread);

    await closeTaskThread(client, 'thread-1', task);

    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('proceeds with close even if fetchStarterMessage throws', async () => {
    const thread = makeCloseThread();
    thread.fetchStarterMessage = vi.fn(async () => { throw new Error('not found'); });
    const client = makeClient(thread);

    await closeTaskThread(client, 'thread-1', task);

    expect(thread._sendFn).toHaveBeenCalled();
    expect(thread._setNameFn).toHaveBeenCalled();
    expect(thread._setArchivedFn).toHaveBeenCalledWith(true);
  });

  it('does nothing when thread is not found', async () => {
    const client = {
      channels: { cache: { get: () => undefined } },
      user: { id: 'bot-123' },
    } as any;

    await closeTaskThread(client, 'missing', task);
    // No error thrown — function completes silently.
  });
});

// ---------------------------------------------------------------------------
// reloadTagMapInPlace
// ---------------------------------------------------------------------------

describe('reloadTagMapInPlace', () => {
  it('reads file, mutates object in-place, and returns count', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ bug: '111', feature: '222' }));
    const tagMap: TagMap = { old: '000' };
    const count = await reloadTagMapInPlace('/tmp/tag-map.json', tagMap);
    expect(count).toBe(2);
    expect(tagMap).toEqual({ bug: '111', feature: '222' });
    expect(tagMap).not.toHaveProperty('old');
  });

  it('throws on read failure, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/missing.json', tagMap)).rejects.toThrow('ENOENT');
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('throws on truncated JSON, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('{ "bug": "111"');
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/bad.json', tagMap)).rejects.toThrow();
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('rejects array with descriptive error, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('["a", "b"]');
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/array.json', tagMap)).rejects.toThrow('must be a JSON object, got array');
    expect(tagMap).toEqual({ existing: '999' });
  });

  it('rejects non-string values with descriptive error, existing map untouched', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ bug: 123 }));
    const tagMap: TagMap = { existing: '999' };
    await expect(reloadTagMapInPlace('/tmp/bad-val.json', tagMap)).rejects.toThrow('must be a string, got number');
    expect(tagMap).toEqual({ existing: '999' });
  });
});

// ---------------------------------------------------------------------------
// getStatusTagIds
// ---------------------------------------------------------------------------

describe('getStatusTagIds', () => {
  it('returns correct IDs for all statuses present', () => {
    const tagMap: TagMap = { open: '1', in_progress: '2', blocked: '3', closed: '4', feature: '5' };
    const ids = getStatusTagIds(tagMap);
    expect(ids).toEqual(new Set(['1', '2', '3', '4']));
  });

  it('handles partial entries', () => {
    const tagMap: TagMap = { blocked: '3', feature: '5' };
    const ids = getStatusTagIds(tagMap);
    expect(ids).toEqual(new Set(['3']));
  });

  it('returns empty set when no status tags configured', () => {
    const tagMap: TagMap = { feature: '5', bug: '6' };
    const ids = getStatusTagIds(tagMap);
    expect(ids.size).toBe(0);
  });

  it('ignores non-status keys', () => {
    const tagMap: TagMap = { feature: '5', open: '1' };
    const ids = getStatusTagIds(tagMap);
    expect(ids).toEqual(new Set(['1']));
    expect(ids.has('5')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAppliedTagsWithStatus
// ---------------------------------------------------------------------------

describe('buildAppliedTagsWithStatus', () => {
  it('swaps status tag preserving content tags', () => {
    const tagMap: TagMap = { open: 's1', closed: 's2', feature: 'c1' };
    const result = buildAppliedTagsWithStatus(['c1', 's1'], 'closed', tagMap);
    expect(result).toContain('s2');
    expect(result).toContain('c1');
    expect(result).not.toContain('s1');
  });

  it('handles missing status in tagMap — content tags unchanged', () => {
    const tagMap: TagMap = { feature: 'c1', bug: 'c2' };
    const result = buildAppliedTagsWithStatus(['c1', 'c2'], 'open', tagMap);
    expect(result).toEqual(['c1', 'c2']);
  });

  it('status tag gets priority: 5 content tags → 4 content + 1 status', () => {
    const tagMap: TagMap = { open: 's1', a: 'c1', b: 'c2', c: 'c3', d: 'c4', e: 'c5' };
    const result = buildAppliedTagsWithStatus(['c1', 'c2', 'c3', 'c4', 'c5'], 'open', tagMap);
    expect(result.length).toBe(5);
    expect(result).toContain('s1');
    expect(result.filter(id => id !== 's1').length).toBe(4);
  });

  it('no-op when correct status tag already present', () => {
    const tagMap: TagMap = { open: 's1', feature: 'c1' };
    const result = buildAppliedTagsWithStatus(['c1', 's1'], 'open', tagMap);
    expect(result).toContain('s1');
    expect(result).toContain('c1');
    expect(result.length).toBe(2);
  });

  it('strips old status tag even if new status not in tagMap', () => {
    const tagMap: TagMap = { open: 's1', feature: 'c1' };
    // in_progress not in tagMap
    const result = buildAppliedTagsWithStatus(['c1', 's1'], 'in_progress', tagMap);
    expect(result).not.toContain('s1');
    expect(result).toEqual(['c1']);
  });

  it('dedupes content tags', () => {
    const tagMap: TagMap = { open: 's1', feature: 'c1' };
    const result = buildAppliedTagsWithStatus(['c1', 'c1', 'c1'], 'open', tagMap);
    expect(result.filter(id => id === 'c1').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createTaskThread — status tag application
// ---------------------------------------------------------------------------

describe('createTaskThread', () => {
  const makeTask = (overrides?: Partial<TaskData>): TaskData => ({
    id: 'ws-001',
    title: 'Test bead',
    description: 'A test',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: '',
    labels: ['feature'],
    comments: [],
    created_at: '',
    updated_at: '',
    close_reason: '',
    ...overrides,
  });

  function makeForum(createFn: ReturnType<typeof vi.fn>): any {
    return { threads: { create: createFn } };
  }

  it('includes status tag in appliedTags when tagMap has status entry', async () => {
    const tagMap: TagMap = { open: 's1', feature: 'c1' };
    const task = makeTask({ status: 'open', labels: ['feature'] });
    const createFn = vi.fn(async (_opts: any) => ({ id: 'new-thread' }));

    await createTaskThread(makeForum(createFn), task, tagMap);

    const args = createFn.mock.calls[0]![0];
    expect(args.appliedTags).toContain('s1');
    expect(args.appliedTags).toContain('c1');
    expect(args.appliedTags.length).toBeLessThanOrEqual(5);
  });

  it('omits status tag when tagMap has no status entry for task status', async () => {
    const tagMap: TagMap = { feature: 'c1' };
    const task = makeTask({ status: 'open', labels: ['feature'] });
    const createFn = vi.fn(async (_opts: any) => ({ id: 'new-thread' }));

    await createTaskThread(makeForum(createFn), task, tagMap);

    const args = createFn.mock.calls[0]![0];
    expect(args.appliedTags).toContain('c1');
    expect(args.appliedTags).not.toContain(undefined);
    expect(args.appliedTags.length).toBeLessThanOrEqual(5);
  });

  it('caps total appliedTags at 5 even with many labels', async () => {
    const tagMap: TagMap = { open: 's1', a: 'c1', b: 'c2', c: 'c3', d: 'c4', e: 'c5' };
    const task = makeTask({ status: 'open', labels: ['a', 'b', 'c', 'd', 'e'] });
    const createFn = vi.fn(async (_opts: any) => ({ id: 'new-thread' }));

    await createTaskThread(makeForum(createFn), task, tagMap);

    const args = createFn.mock.calls[0]![0];
    expect(args.appliedTags.length).toBe(5);
    expect(args.appliedTags).toContain('s1');
  });

  it('passes mentionUserId to starter content and allowedMentions', async () => {
    const tagMap: TagMap = { open: 's1' };
    const task = makeTask({ status: 'open', labels: [] });
    const createFn = vi.fn(async (_opts: any) => ({ id: 'new-thread' }));

    await createTaskThread(makeForum(createFn), task, tagMap, '999');

    const args = createFn.mock.calls[0]![0];
    expect(args.message.content).toContain('<@999>');
    expect(args.message.allowedMentions.users).toEqual(['999']);
  });
});

// ---------------------------------------------------------------------------
// updateTaskThreadTags
// ---------------------------------------------------------------------------

describe('updateTaskThreadTags', () => {
  const task: TaskData = {
    id: 'ws-001', title: 'Test', status: 'in_progress',
    priority: 2, external_ref: '', labels: [],
  };

  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
      user: { id: 'bot-123' },
    };
  }

  it('returns false when thread not found', async () => {
    const client = { channels: { cache: { get: () => undefined } } } as any;
    const result = await updateTaskThreadTags(client, 'missing', task, { in_progress: 's2' });
    expect(result).toBe(false);
  });

  it('returns false when tags already match (order-insensitive)', async () => {
    const tagMap: TagMap = { in_progress: 's2', feature: 'c1' };
    const thread = {
      isThread: () => true,
      appliedTags: ['s2', 'c1'],
      edit: vi.fn(),
    };
    const result = await updateTaskThreadTags(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(false);
    expect(thread.edit).not.toHaveBeenCalled();
  });

  it('calls thread.edit when status tag differs', async () => {
    const tagMap: TagMap = { open: 's1', in_progress: 's2', feature: 'c1' };
    const thread = {
      isThread: () => true,
      appliedTags: ['c1', 's1'],
      edit: vi.fn(),
    };
    const result = await updateTaskThreadTags(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(true);
    expect(thread.edit).toHaveBeenCalledWith({
      appliedTags: expect.arrayContaining(['s2', 'c1']),
    });
    expect(thread.edit.mock.calls[0][0].appliedTags).not.toContain('s1');
  });
});

// ---------------------------------------------------------------------------
// closeTaskThread with tagMap
// ---------------------------------------------------------------------------

describe('closeTaskThread with tagMap', () => {
  const task: TaskData = {
    id: 'ws-001', title: 'Test', status: 'closed',
    priority: 2, external_ref: '', labels: [], close_reason: 'Done',
  };

  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
      user: { id: 'bot-123' },
    };
  }

  function makeCloseThread(opts?: { appliedTags?: string[] }): any {
    return {
      isThread: () => true,
      archived: false,
      appliedTags: opts?.appliedTags ?? [],
      fetchStarterMessage: vi.fn(async () => ({
        author: { id: 'bot-123' },
        content: 'old content',
        edit: vi.fn(),
      })),
      send: vi.fn(),
      setName: vi.fn(),
      setArchived: vi.fn(),
      edit: vi.fn(),
    };
  }

  it('applies closed status tag before archiving when tagMap provided', async () => {
    const tagMap: TagMap = { closed: 'sc', feature: 'c1' };
    const thread = makeCloseThread({ appliedTags: ['c1'] });
    await closeTaskThread(makeClient(thread), 'thread-1', task, tagMap);

    expect(thread.edit).toHaveBeenCalledWith({
      appliedTags: expect.arrayContaining(['sc', 'c1']),
    });
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('skips tag edit when tags already match', async () => {
    const tagMap: TagMap = { closed: 'sc', feature: 'c1' };
    const thread = makeCloseThread({ appliedTags: ['c1', 'sc'] });
    await closeTaskThread(makeClient(thread), 'thread-1', task, tagMap);

    expect(thread.edit).not.toHaveBeenCalled();
  });

  it('skips tag update when tagMap is undefined (backward compat)', async () => {
    const thread = makeCloseThread({ appliedTags: ['c1'] });
    await closeTaskThread(makeClient(thread), 'thread-1', task);

    expect(thread.edit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isTaskThreadAlreadyClosed with tagMap
// ---------------------------------------------------------------------------

describe('isTaskThreadAlreadyClosed with tagMap', () => {
  const task: TaskData = {
    id: 'ws-001', title: 'Test', status: 'closed',
    priority: 2, external_ref: '', labels: [],
  };

  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
    };
  }

  const closedName = '\u2611\uFE0F [001] Test';

  it('returns false when archived+named but has wrong/missing status tag', async () => {
    const tagMap: TagMap = { closed: 'sc', open: 'so' };
    const thread = {
      isThread: () => true,
      archived: true,
      name: closedName,
      appliedTags: ['c1'],
    };
    const result = await isTaskThreadAlreadyClosed(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(false);
  });

  it('returns false when thread has stale status tag', async () => {
    const tagMap: TagMap = { closed: 'sc', open: 'so' };
    const thread = {
      isThread: () => true,
      archived: true,
      name: closedName,
      appliedTags: ['so', 'c1'], // has open tag instead of closed
    };
    const result = await isTaskThreadAlreadyClosed(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(false);
  });

  it('returns true when thread has correct closed tag', async () => {
    const tagMap: TagMap = { closed: 'sc', open: 'so' };
    const thread = {
      isThread: () => true,
      archived: true,
      name: closedName,
      appliedTags: ['c1', 'sc'],
    };
    const result = await isTaskThreadAlreadyClosed(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(true);
  });

  it('returns true (backward compat) when tagMap omitted', async () => {
    const thread = {
      isThread: () => true,
      archived: true,
      name: closedName,
      appliedTags: [],
    };
    const result = await isTaskThreadAlreadyClosed(makeClient(thread), '123', task);
    expect(result).toBe(true);
  });

  it('returns true when tagMap has no status entries', async () => {
    const tagMap: TagMap = { feature: 'c1' };
    const thread = {
      isThread: () => true,
      archived: true,
      name: closedName,
      appliedTags: [],
    };
    const result = await isTaskThreadAlreadyClosed(makeClient(thread), '123', task, tagMap);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isThreadArchived
// ---------------------------------------------------------------------------

describe('isThreadArchived', () => {
  function makeClient(thread: any): any {
    return {
      channels: { cache: { get: () => thread } },
    };
  }

  it('returns true when thread is archived', async () => {
    const thread = { isThread: () => true, archived: true };
    const result = await isThreadArchived(makeClient(thread), '123');
    expect(result).toBe(true);
  });

  it('returns true when thread does not exist (missing)', async () => {
    const client = { channels: { cache: { get: () => undefined } } } as any;
    const result = await isThreadArchived(client, 'missing');
    expect(result).toBe(true);
  });

  it('returns false when thread is not archived', async () => {
    const thread = { isThread: () => true, archived: false };
    const result = await isThreadArchived(makeClient(thread), '123');
    expect(result).toBe(false);
  });

  it('returns true for archived thread regardless of name/tag metadata', async () => {
    // isThreadArchived only checks archived state, not name or tags.
    // Phase 4 of bead-sync uses isTaskThreadAlreadyClosed instead, which
    // checks all three (archived + name + tags) for proper recovery.
    const thread = {
      isThread: () => true,
      archived: true,
      name: 'wrong name',
      appliedTags: ['wrong-tag'],
    };
    const result = await isThreadArchived(makeClient(thread), '123');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shortTaskId
// ---------------------------------------------------------------------------

describe('shortTaskId', () => {
  it('strips project prefix', () => {
    expect(shortTaskId('ws-001')).toBe('001');
  });

  it('returns full string when no dash', () => {
    expect(shortTaskId('001')).toBe('001');
  });

  it('strips only first dash segment', () => {
    expect(shortTaskId('my-proj-042')).toBe('proj-042');
  });
});

// ---------------------------------------------------------------------------
// taskIdToken
// ---------------------------------------------------------------------------

describe('taskIdToken', () => {
  it('wraps short ID in brackets', () => {
    expect(taskIdToken('ws-001')).toBe('[001]');
  });

  it('works without prefix', () => {
    expect(taskIdToken('042')).toBe('[042]');
  });
});

// ---------------------------------------------------------------------------
// extractShortIdFromThreadName
// ---------------------------------------------------------------------------

describe('extractShortIdFromThreadName', () => {
  it('extracts ID from open emoji thread name', () => {
    expect(extractShortIdFromThreadName('\u{1F7E2} [001] Fix login bug')).toBe('001');
  });

  it('extracts ID from in_progress emoji thread name', () => {
    expect(extractShortIdFromThreadName('\u{1F7E1} [042] Add feature')).toBe('042');
  });

  it('extracts ID from blocked emoji thread name (multi-codepoint ⚠️)', () => {
    expect(extractShortIdFromThreadName('\u26A0\uFE0F [007] Blocked task')).toBe('007');
  });

  it('extracts ID from closed emoji thread name (multi-codepoint ☑️)', () => {
    expect(extractShortIdFromThreadName('\u2611\uFE0F [123] Done task')).toBe('123');
  });

  it('returns null for non-bead thread name', () => {
    expect(extractShortIdFromThreadName('Bug [123] some issue')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractShortIdFromThreadName('')).toBeNull();
  });

  it('returns null when bracket is not at start after emoji', () => {
    expect(extractShortIdFromThreadName('General discussion about [001]')).toBeNull();
  });

  it('handles no space between emoji and bracket', () => {
    expect(extractShortIdFromThreadName('\u{1F7E2}[001] Test')).toBe('001');
  });

  it('handles multiple spaces between emoji and bracket', () => {
    expect(extractShortIdFromThreadName('\u{1F7E2}  [001] Test')).toBe('001');
  });

  it('returns null for non-numeric bracket content', () => {
    expect(extractShortIdFromThreadName('\u{1F7E2} [abc] Test')).toBeNull();
  });

  it('roundtrips with buildThreadName', () => {
    const name = buildThreadName('ws-085', 'Plan execution', 'in_progress');
    expect(extractShortIdFromThreadName(name)).toBe('085');
  });
});
