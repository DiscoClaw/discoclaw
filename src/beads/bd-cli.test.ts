import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { parseBdJson, normalizeBeadData, bdShow, bdList, bdFindByTitle, ensureBdDatabaseReady, buildBeadContextSummary } from './bd-cli.js';
import { parseBdJson as parseTaskBdJson, bdList as taskBdList } from '../tasks/bd-cli.js';
import { buildTaskContextSummary } from '../tasks/context-summary.js';
import { TaskStore } from '../tasks/store.js';
import type { BeadData } from './types.js';

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
  it('keeps compatibility exports aligned to canonical task bd-cli', () => {
    expect(parseBdJson).toBe(parseTaskBdJson);
    expect(bdList).toBe(taskBdList);
  });

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
// normalizeBeadData
// ---------------------------------------------------------------------------

describe('normalizeBeadData', () => {
  const baseBead: BeadData = {
    id: 'ws-001',
    title: 'Test bead',
    status: 'open',
  };

  it('maps "done" → "closed"', () => {
    const bead = { ...baseBead, status: 'done' as BeadData['status'] };
    expect(normalizeBeadData(bead).status).toBe('closed');
  });

  it('maps "tombstone" → "closed"', () => {
    const bead = { ...baseBead, status: 'tombstone' as BeadData['status'] };
    expect(normalizeBeadData(bead).status).toBe('closed');
  });

  it('does not mutate the original bead when mapping', () => {
    const bead = { ...baseBead, status: 'done' as BeadData['status'] };
    normalizeBeadData(bead);
    expect(bead.status).toBe('done');
  });

  it.each(['open', 'in_progress', 'blocked', 'closed'] as const)(
    'passes through valid status "%s" unchanged',
    (status) => {
      const bead = { ...baseBead, status };
      const result = normalizeBeadData(bead);
      expect(result.status).toBe(status);
      expect(result).toBe(bead); // same reference — no copy
    },
  );
});

// ---------------------------------------------------------------------------
// bdShow — "not found" error handling
// ---------------------------------------------------------------------------

describe('bdShow', () => {
  it('returns null for "not found" errors', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: not found',
    });

    const result = await bdShow('ws-999', '/tmp');
    expect(result).toBeNull();
  });

  it('returns null for "no issue found matching" errors (bd resolve failure)', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: resolving ID ws-007: operation failed: failed to resolve ID: no issue found matching "ws-007"',
    });

    const result = await bdShow('ws-007', '/tmp');
    expect(result).toBeNull();
  });

  it('returns bead data on success', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([{ id: 'ws-001', title: 'Test', status: 'open' }]),
      stderr: '',
    });

    const result = await bdShow('ws-001', '/tmp');
    expect(result).toEqual({ id: 'ws-001', title: 'Test', status: 'open' });
  });

  it('throws on unexpected errors', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: database corruption detected',
    });

    await expect(bdShow('ws-001', '/tmp')).rejects.toThrow('database corruption');
  });
});

// ---------------------------------------------------------------------------
// runBd — argument construction (--db, --no-daemon pinning)
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
// bdFindByTitle — title-match dedup
// ---------------------------------------------------------------------------

describe('bdFindByTitle', () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('returns matching open bead (case-insensitive, trimmed)', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: 'ws-001', title: '  Fix The Bug  ', status: 'open' },
      ]),
      stderr: '',
    });

    const result = await bdFindByTitle('fix the bug', '/tmp');
    expect(result).toEqual({ id: 'ws-001', title: '  Fix The Bug  ', status: 'open' });
  });

  it('returns null when no title matches', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: 'ws-001', title: 'Something else', status: 'open' },
      ]),
      stderr: '',
    });

    const result = await bdFindByTitle('Fix the bug', '/tmp');
    expect(result).toBeNull();
  });

  it('skips closed beads with matching title', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: 'ws-001', title: 'Fix the bug', status: 'closed' },
      ]),
      stderr: '',
    });

    const result = await bdFindByTitle('Fix the bug', '/tmp');
    expect(result).toBeNull();
  });

  it('matches in_progress beads', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: 'ws-002', title: 'Add auth', status: 'in_progress' },
      ]),
      stderr: '',
    });

    const result = await bdFindByTitle('Add auth', '/tmp');
    expect(result).toEqual({ id: 'ws-002', title: 'Add auth', status: 'in_progress' });
  });

  it('returns null for empty/whitespace title without calling bd', async () => {
    const result = await bdFindByTitle('   ', '/tmp');
    expect(result).toBeNull();
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('passes label filter to bdList when provided', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([]),
      stderr: '',
    });

    await bdFindByTitle('Some title', '/tmp', { label: 'plan' });

    const calledArgs = mockExeca.mock.calls[0][1] as string[];
    expect(calledArgs).toContain('--label');
    expect(calledArgs).toContain('plan');
  });

  it('returns first match when multiple beads match', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: 'ws-001', title: 'Fix the bug', status: 'open' },
        { id: 'ws-002', title: 'Fix the bug', status: 'in_progress' },
      ]),
      stderr: '',
    });

    const result = await bdFindByTitle('Fix the bug', '/tmp');
    expect(result?.id).toBe('ws-001');
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
// buildBeadContextSummary — in-process TaskStore path
// ---------------------------------------------------------------------------

describe('buildBeadContextSummary', () => {
  it('keeps compatibility export aligned to canonical task helper', () => {
    expect(buildBeadContextSummary).toBe(buildTaskContextSummary);
  });

  it('returns undefined when beadId is undefined', () => {
    const store = new TaskStore();
    expect(buildBeadContextSummary(undefined, store)).toBeUndefined();
  });

  it('returns undefined when store is undefined', () => {
    expect(buildBeadContextSummary('t-001', undefined)).toBeUndefined();
  });

  it('returns undefined when bead is not found in store', () => {
    const store = new TaskStore();
    expect(buildBeadContextSummary('t-001', store)).toBeUndefined();
  });

  it('returns summary with title only when no description', () => {
    const store = new TaskStore();
    const bead = store.create({ title: 'Fix the bug' });
    const result = buildBeadContextSummary(bead.id, store);
    expect(result?.summary).toBe('Bead context for this thread:\nTitle: Fix the bug');
    expect(result?.description).toBeUndefined();
  });

  it('returns summary with title and truncated description', () => {
    const store = new TaskStore();
    const bead = store.create({ title: 'My task', description: 'a'.repeat(500) });
    const result = buildBeadContextSummary(bead.id, store);
    expect(result?.summary).toContain('Title: My task');
    expect(result?.description).toHaveLength(400);
    expect(result?.description?.endsWith('\u2026')).toBe(true);
  });

  it('collapses whitespace in description', () => {
    const store = new TaskStore();
    const bead = store.create({ title: 'T', description: 'hello\n  world' });
    const result = buildBeadContextSummary(bead.id, store);
    expect(result?.description).toBe('hello world');
  });

  it('does not call execa — store.get is synchronous', () => {
    // This test verifies no subprocess is spawned. Since buildBeadContextSummary
    // is now a synchronous function, it cannot be an async subprocess call.
    const store = new TaskStore();
    const bead = store.create({ title: 'Sync task' });
    const returnValue = buildBeadContextSummary(bead.id, store);
    // Must return a plain object, not a Promise.
    expect(returnValue).not.toBeInstanceOf(Promise);
    expect(returnValue?.summary).toContain('Sync task');
  });
});
