import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildThreadName, buildBeadStarterContent, getThreadIdFromBead, updateBeadStarterMessage, closeBeadThread, reloadTagMapInPlace } from './discord-sync.js';
import type { BeadData, TagMap } from './types.js';

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
// buildBeadStarterContent
// ---------------------------------------------------------------------------

describe('buildBeadStarterContent', () => {
  const makeBead = (overrides?: Partial<BeadData>): BeadData => ({
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
    const content = buildBeadStarterContent(makeBead());
    expect(content).toContain('A test bead');
    expect(content).toContain('**ID:** `ws-001`');
    expect(content).toContain('**Priority:** P2');
    expect(content).toContain('**Status:** open');
  });

  it('includes owner when present', () => {
    const content = buildBeadStarterContent(makeBead({ owner: 'alice' }));
    expect(content).toContain('**Owner:** alice');
  });

  it('omits owner when empty', () => {
    const content = buildBeadStarterContent(makeBead({ owner: '' }));
    expect(content).not.toContain('**Owner:**');
  });

  it('does not include mention lines when mentionUserId omitted', () => {
    const content = buildBeadStarterContent(makeBead());
    expect(content).not.toContain('<@');
  });

  it('appends mention when mentionUserId provided', () => {
    const content = buildBeadStarterContent(makeBead(), '999888777');
    expect(content).toContain('<@999888777>');
  });

  it('defaults priority to P2 when undefined', () => {
    const content = buildBeadStarterContent(makeBead({ priority: undefined as any }));
    expect(content).toContain('**Priority:** P2');
  });
});

// ---------------------------------------------------------------------------
// getThreadIdFromBead
// ---------------------------------------------------------------------------

describe('getThreadIdFromBead', () => {
  const makeBead = (externalRef: string): BeadData => ({
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
    expect(getThreadIdFromBead(makeBead('discord:123456789'))).toBe('123456789');
  });

  it('extracts raw numeric ID', () => {
    expect(getThreadIdFromBead(makeBead('123456789'))).toBe('123456789');
  });

  it('returns null for empty external_ref', () => {
    expect(getThreadIdFromBead(makeBead(''))).toBeNull();
  });

  it('returns null for non-discord external_ref', () => {
    expect(getThreadIdFromBead(makeBead('gh-123'))).toBeNull();
  });

  it('handles whitespace', () => {
    expect(getThreadIdFromBead(makeBead('  discord:123  '))).toBe('123');
  });
});

// ---------------------------------------------------------------------------
// updateBeadStarterMessage
// ---------------------------------------------------------------------------

describe('updateBeadStarterMessage', () => {
  const bead: BeadData = {
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
    expect(await updateBeadStarterMessage(client, 'missing', bead)).toBe(false);
  });

  it('returns false when fetchStarterMessage throws', async () => {
    const thread = {
      isThread: () => true,
      fetchStarterMessage: vi.fn(async () => { throw new Error('not found'); }),
    };
    expect(await updateBeadStarterMessage(makeClient(thread), '123', bead)).toBe(false);
  });

  it('returns false when starter is not bot-authored', async () => {
    const thread = makeThread({ author: { id: 'user-456' } });
    expect(await updateBeadStarterMessage(makeClient(thread), '123', bead)).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('returns false when content is already identical (idempotent)', async () => {
    const currentContent = buildBeadStarterContent(bead);
    const thread = makeThread({ content: currentContent });
    expect(await updateBeadStarterMessage(makeClient(thread), '123', bead)).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('edits starter and returns true when content differs', async () => {
    const thread = makeThread({ content: 'stale content' });
    const result = await updateBeadStarterMessage(makeClient(thread), '123', bead);
    expect(result).toBe(true);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: buildBeadStarterContent(bead),
      allowedMentions: { parse: [], users: [] },
    });
  });

  it('passes mentionUserId to content builder and sets allowedMentions.users', async () => {
    const thread = makeThread({ content: 'stale content' });
    const result = await updateBeadStarterMessage(makeClient(thread), '123', bead, '999');
    expect(result).toBe(true);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: buildBeadStarterContent(bead, '999'),
      allowedMentions: { parse: [], users: ['999'] },
    });
  });

  it('skips edit when mention content already matches', async () => {
    const contentWithMention = buildBeadStarterContent(bead, '999');
    const thread = makeThread({ content: contentWithMention });
    const result = await updateBeadStarterMessage(makeClient(thread), '123', bead, '999');
    expect(result).toBe(false);
    expect(thread._editFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// closeBeadThread
// ---------------------------------------------------------------------------

describe('closeBeadThread', () => {
  const bead: BeadData = {
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
    const contentWithMention = buildBeadStarterContent(bead, '999');
    const thread = makeCloseThread({ starterContent: contentWithMention });
    const client = makeClient(thread);

    await closeBeadThread(client, 'thread-1', bead);

    const cleanContent = buildBeadStarterContent(bead);
    expect(thread._editFn).toHaveBeenCalledWith({
      content: cleanContent.slice(0, 2000),
      allowedMentions: { parse: [], users: [] },
    });
  });

  it('skips starter edit when content has no mention', async () => {
    const cleanContent = buildBeadStarterContent(bead);
    const thread = makeCloseThread({ starterContent: cleanContent });
    const client = makeClient(thread);

    await closeBeadThread(client, 'thread-1', bead);

    expect(thread._editFn).not.toHaveBeenCalled();
  });

  it('proceeds with close even if fetchStarterMessage throws', async () => {
    const thread = makeCloseThread();
    thread.fetchStarterMessage = vi.fn(async () => { throw new Error('not found'); });
    const client = makeClient(thread);

    await closeBeadThread(client, 'thread-1', bead);

    expect(thread._sendFn).toHaveBeenCalled();
    expect(thread._setNameFn).toHaveBeenCalled();
    expect(thread._setArchivedFn).toHaveBeenCalledWith(true);
  });

  it('does nothing when thread is not found', async () => {
    const client = {
      channels: { cache: { get: () => undefined } },
      user: { id: 'bot-123' },
    } as any;

    await closeBeadThread(client, 'missing', bead);
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
