import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { parseBdJson, normalizeTaskData, bdList, ensureBdDatabaseReady, buildTaskContextSummary } from './bd-cli.js';
import { TaskStore } from './store.js';
import type { TaskData } from './types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p),
  },
}));

// ---------------------------------------------------------------------------
// parseBdJson
// ---------------------------------------------------------------------------

describe('parseBdJson', () => {
  it('parses array output', () => {
    const input = JSON.stringify([
      { id: 'ws-001', title: 'Test', status: 'open' },
      { id: 'ws-002', title: 'Test 2', status: 'closed' },
    ]);
    const result = parseBdJson(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('ws-001');
    expect(result[1].id).toBe('ws-002');
  });

  it('parses single-object output', () => {
    const input = JSON.stringify({ id: 'ws-001', title: 'Test', status: 'open' });
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ws-001');
  });

  it('strips markdown fences', () => {
    const input = '```json\n[{"id":"ws-001","title":"Test"}]\n```';
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ws-001');
  });

  it('strips bare markdown fences (no language tag)', () => {
    const input = '```\n{"id":"ws-001","title":"Test"}\n```';
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseBdJson('')).toEqual([]);
    expect(parseBdJson('  \n  ')).toEqual([]);
  });

  it('throws on error-only object', () => {
    const input = JSON.stringify({ error: 'not found' });
    expect(() => parseBdJson(input)).toThrow('not found');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBdJson('{bad json}')).toThrow();
  });

  it('returns empty array for non-object JSON', () => {
    expect(parseBdJson('"just a string"')).toEqual([]);
    expect(parseBdJson('42')).toEqual([]);
    expect(parseBdJson('null')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeTaskData
// ---------------------------------------------------------------------------

describe('normalizeTaskData', () => {
  const baseTask: TaskData = {
    id: 'ws-001',
    title: 'Test task',
    status: 'open',
  };

  it('maps "done" → "closed"', () => {
    const task = { ...baseTask, status: 'done' as TaskData['status'] };
    expect(normalizeTaskData(task).status).toBe('closed');
  });

  it('maps "tombstone" → "closed"', () => {
    const task = { ...baseTask, status: 'tombstone' as TaskData['status'] };
    expect(normalizeTaskData(task).status).toBe('closed');
  });

  it('does not mutate the original task when mapping', () => {
    const task = { ...baseTask, status: 'done' as TaskData['status'] };
    normalizeTaskData(task);
    expect(task.status).toBe('done');
  });

  it.each(['open', 'in_progress', 'blocked', 'closed'] as const)(
    'passes through valid status "%s" unchanged',
    (status) => {
      const task = { ...baseTask, status };
      const result = normalizeTaskData(task);
      expect(result.status).toBe(status);
      expect(result).toBe(task); // same reference — no copy
    },
  );
});

// ---------------------------------------------------------------------------
// runBd (via bdList) — argument construction (--db, --no-daemon pinning)
// ---------------------------------------------------------------------------

describe('runBd argument construction', () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('prepends --db and --no-daemon to execa args', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    await bdList({}, '/home/user/workspace');

    expect(mockExeca).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        '--db', '/home/user/workspace/.beads/beads.db',
        '--no-daemon',
      ]),
      expect.objectContaining({ cwd: '/home/user/workspace' }),
    );
  });

  it('resolves relative cwd to absolute dbPath', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    await bdList({}, 'workspace');

    const calledArgs = mockExeca.mock.calls[0][1] as string[];
    const dbArg = calledArgs[calledArgs.indexOf('--db') + 1];
    // path.resolve('workspace', ...) produces an absolute path
    expect(path.isAbsolute(dbArg)).toBe(true);
    expect(dbArg).toBe(path.resolve('workspace', '.beads', 'beads.db'));
  });

  it('passes --limit 0 when status is all and no explicit limit', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    await bdList({ status: 'all' }, '/tmp');

    const calledArgs = mockExeca.mock.calls[0][1] as string[];
    expect(calledArgs).toContain('--all');
    expect(calledArgs).toContain('--limit');
    const limitIdx = calledArgs.indexOf('--limit');
    expect(calledArgs[limitIdx + 1]).toBe('0');
  });

  it('respects explicit limit when status is all', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    await bdList({ status: 'all', limit: 10 }, '/tmp');

    const calledArgs = mockExeca.mock.calls[0][1] as string[];
    expect(calledArgs).toContain('--all');
    expect(calledArgs).toContain('--limit');
    const limitIdx = calledArgs.indexOf('--limit');
    expect(calledArgs[limitIdx + 1]).toBe('10');
  });

  it('places --db and --no-daemon before subcommand args', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    await bdList({ status: 'open' }, '/tmp');

    const calledArgs = mockExeca.mock.calls[0][1] as string[];
    const dbIdx = calledArgs.indexOf('--db');
    const noDaemonIdx = calledArgs.indexOf('--no-daemon');
    const listIdx = calledArgs.indexOf('list');
    expect(dbIdx).toBeLessThan(listIdx);
    expect(noDaemonIdx).toBeLessThan(listIdx);
  });
});

// ---------------------------------------------------------------------------
// ensureBdDatabaseReady
// ---------------------------------------------------------------------------

describe('ensureBdDatabaseReady', () => {
  let mockExeca: ReturnType<typeof vi.fn>;
  let mockRealpath: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();

    const fsMod = await import('node:fs/promises');
    mockRealpath = fsMod.default.realpath as unknown as ReturnType<typeof vi.fn>;
    // Default: identity (no symlink). Tests that need symlink behavior override this.
    mockRealpath.mockReset();
    mockRealpath.mockImplementation(async (p: string) => p);
  });

  it('returns ready with prefix when prefix already set', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'dev',
      stderr: '',
    });

    const result = await ensureBdDatabaseReady('/home/user/discoclaw-data/workspace');
    expect(result).toEqual({ ready: true, prefix: 'dev' });
    // Should only call config get, never config set
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['config', 'get', 'issue_prefix']),
      expect.objectContaining({ cwd: '/home/user/discoclaw-data/workspace', reject: false }),
    );
  });

  it('auto-initializes prefix when "(not set)" and set succeeds', async () => {
    // First call: config get returns "(not set)"
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'issue_prefix (not set)',
      stderr: '',
    });
    // Second call: config set succeeds
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await ensureBdDatabaseReady('/home/user/discoclaw-data/workspace');
    expect(result).toEqual({ ready: true, prefix: 'data' });
    expect(mockExeca).toHaveBeenCalledTimes(2);
    // Verify the set call used the derived prefix
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toEqual(expect.arrayContaining(['config', 'set', 'issue_prefix', 'data']));
  });

  it('auto-initializes prefix when config get returns empty output', async () => {
    // exitCode 0 but empty stdout → falls through to auto-init
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await ensureBdDatabaseReady('/home/user/discoclaw-personal/workspace');
    expect(result).toEqual({ ready: true, prefix: 'personal' });
  });

  it('auto-initializes prefix when config get returns non-zero exit code', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'config key not found',
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await ensureBdDatabaseReady('/home/user/discoclaw-data/workspace');
    expect(result).toEqual({ ready: true, prefix: 'data' });
  });

  it('returns not ready when auto-init set fails', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'issue_prefix (not set)',
      stderr: '',
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'permission denied',
    });

    const result = await ensureBdDatabaseReady('/home/user/discoclaw-data/workspace');
    expect(result).toEqual({ ready: false });
  });

  it('returns not ready when execa throws', async () => {
    mockExeca.mockRejectedValueOnce(new Error('ENOENT: bd not found'));

    const result = await ensureBdDatabaseReady('/tmp/workspace');
    expect(result).toEqual({ ready: false });
  });

  // ---- Prefix derivation logic ----

  it('derives prefix from "discoclaw-personal" → "personal"', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '(not set)', stderr: '' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await ensureBdDatabaseReady('/home/user/discoclaw-personal/workspace');
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toContain('personal');
  });

  it('derives prefix from "discoclaw-data" → "data"', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '(not set)', stderr: '' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await ensureBdDatabaseReady('/home/user/discoclaw-data/workspace');
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toContain('data');
  });

  it('derives prefix from bare "discoclaw" → "dc" (fallback)', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '(not set)', stderr: '' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await ensureBdDatabaseReady('/home/user/discoclaw/workspace');
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toContain('dc');
  });

  it('strips non-alphanumeric chars from derived prefix', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '(not set)', stderr: '' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    // Parent dir has special chars: "my-project_v2" → "myprojectv2"
    await ensureBdDatabaseReady('/home/user/my-project_v2/workspace');
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toContain('myprojectv2');
  });

  it('uses correct --db path derived from cwd', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'ws', stderr: '' });

    await ensureBdDatabaseReady('/home/user/discoclaw-personal/workspace');
    const getArgs = mockExeca.mock.calls[0][1] as string[];
    const dbIdx = getArgs.indexOf('--db');
    expect(getArgs[dbIdx + 1]).toBe(
      path.resolve('/home/user/discoclaw-personal/workspace', '.beads', 'beads.db'),
    );
  });

  it('resolves symlinks before deriving prefix', async () => {
    // Symlink: code/discoclaw/workspace → discoclaw-data/workspace
    // Without realpath, parent would be "discoclaw" → "dc" (wrong)
    // With realpath, parent is "discoclaw-data" → "data" (correct)
    mockRealpath.mockResolvedValueOnce('/home/user/discoclaw-data/workspace');
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '(not set)', stderr: '' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await ensureBdDatabaseReady('/home/user/code/discoclaw/workspace');
    expect(result).toEqual({ ready: true, prefix: 'data' });
    expect(mockRealpath).toHaveBeenCalledWith('/home/user/code/discoclaw/workspace');
    const setArgs = mockExeca.mock.calls[1][1] as string[];
    expect(setArgs).toContain('data');
  });
});

// ---------------------------------------------------------------------------
// buildTaskContextSummary — in-process TaskStore path
// ---------------------------------------------------------------------------

describe('buildTaskContextSummary', () => {
  it('returns undefined when taskId is undefined', () => {
    const store = new TaskStore();
    expect(buildTaskContextSummary(undefined, store)).toBeUndefined();
  });

  it('returns undefined when store is undefined', () => {
    expect(buildTaskContextSummary('t-001', undefined)).toBeUndefined();
  });

  it('returns undefined when task is not found in store', () => {
    const store = new TaskStore();
    expect(buildTaskContextSummary('t-001', store)).toBeUndefined();
  });

  it('returns summary with title only when no description', () => {
    const store = new TaskStore();
    const task = store.create({ title: 'Fix the bug' });
    const result = buildTaskContextSummary(task.id, store);
    expect(result?.summary).toBe('Task context for this thread:\nTitle: Fix the bug');
    expect(result?.description).toBeUndefined();
  });

  it('returns summary with title and truncated description', () => {
    const store = new TaskStore();
    const task = store.create({ title: 'My task', description: 'a'.repeat(500) });
    const result = buildTaskContextSummary(task.id, store);
    expect(result?.summary).toContain('Title: My task');
    expect(result?.description).toHaveLength(400);
    expect(result?.description?.endsWith('\u2026')).toBe(true);
  });

  it('collapses whitespace in description', () => {
    const store = new TaskStore();
    const task = store.create({ title: 'T', description: 'hello\n  world' });
    const result = buildTaskContextSummary(task.id, store);
    expect(result?.description).toBe('hello world');
  });

  it('does not call execa — store.get is synchronous', () => {
    // This test verifies no subprocess is spawned. Since buildTaskContextSummary
    // is now a synchronous function, it cannot be an async subprocess call.
    const store = new TaskStore();
    const task = store.create({ title: 'Sync task' });
    const returnValue = buildTaskContextSummary(task.id, store);
    // Must return a plain object, not a Promise.
    expect(returnValue).not.toBeInstanceOf(Promise);
    expect(returnValue?.summary).toContain('Sync task');
  });
});
