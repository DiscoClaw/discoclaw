import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateFromBd, writeJsonl } from './migrate.js';
import { TaskStore } from './store.js';
import type { TaskData } from './types.js';

vi.mock('../beads/bd-cli.js', () => ({
  bdList: vi.fn(),
}));

import { bdList } from '../beads/bd-cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_PATH = (suffix: string) => `/tmp/discoclaw-migrate-test-${suffix}.jsonl`;

async function cleanup(path: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  await unlink(path).catch(() => {});
}

// ---------------------------------------------------------------------------
// writeJsonl
// ---------------------------------------------------------------------------

describe('migrate — writeJsonl', () => {
  it('writes beads as JSONL and allows TaskStore to load them', async () => {
    const path = TMP_PATH('write-load');
    await cleanup(path);

    const beads: TaskData[] = [
      { id: 'ws-001', title: 'Alpha', status: 'open', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      { id: 'ws-002', title: 'Beta', status: 'closed', closed_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
    ];

    await writeJsonl(path, beads);

    const store = new TaskStore({ prefix: 'ws', persistPath: path });
    await store.load();
    expect(store.size()).toBe(2);
    expect(store.list({ status: 'all' }).map((b) => b.id).sort()).toEqual(['ws-001', 'ws-002']);

    await cleanup(path);
  });

  it('preserves all TaskData fields in the JSONL output', async () => {
    const path = TMP_PATH('fields');
    await cleanup(path);

    const bead: TaskData = {
      id: 'ws-005',
      title: 'Rich task',
      status: 'in_progress',
      description: 'some desc',
      priority: 1,
      issue_type: 'bug',
      owner: 'alice',
      external_ref: 'discord:123',
      labels: ['plan', 'tag:feature'],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };

    await writeJsonl(path, [bead]);

    const store = new TaskStore({ prefix: 'ws', persistPath: path });
    await store.load();

    const loaded = store.get('ws-005')!;
    expect(loaded.description).toBe('some desc');
    expect(loaded.priority).toBe(1);
    expect(loaded.issue_type).toBe('bug');
    expect(loaded.owner).toBe('alice');
    expect(loaded.external_ref).toBe('discord:123');
    expect(loaded.labels).toEqual(['plan', 'tag:feature']);

    await cleanup(path);
  });

  it('writes an empty file for an empty bead array', async () => {
    const path = TMP_PATH('empty');
    await cleanup(path);

    await writeJsonl(path, []);

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf8');
    expect(content).toBe('');

    await cleanup(path);
  });

  it('counter advances past the highest migrated ID so new tasks get non-colliding IDs', async () => {
    const path = TMP_PATH('counter');
    await cleanup(path);

    const beads: TaskData[] = [
      { id: 'ws-003', title: 'C', status: 'open' },
      { id: 'ws-001', title: 'A', status: 'open' },
      { id: 'ws-007', title: 'G', status: 'open' },
    ];

    await writeJsonl(path, beads);

    const store = new TaskStore({ prefix: 'ws', persistPath: path });
    await store.load();

    const next = store.create({ title: 'New' });
    expect(next.id).toBe('ws-008');

    await cleanup(path);
  });
});

// ---------------------------------------------------------------------------
// migrateFromBd
// ---------------------------------------------------------------------------

describe('migrate — migrateFromBd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls bdList with status:all and limit:0 and writes all beads to destPath', async () => {
    const path = TMP_PATH('bd-basic');
    await cleanup(path);

    const mockBeads: TaskData[] = [
      { id: 'dc-001', title: 'Task one', status: 'open', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      { id: 'dc-002', title: 'Task two', status: 'in_progress', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
    ];
    vi.mocked(bdList).mockResolvedValueOnce(mockBeads);

    const result = await migrateFromBd({ cwd: '/tmp/fake-workspace', destPath: path });

    expect(result.migrated).toBe(2);
    expect(bdList).toHaveBeenCalledOnce();
    expect(bdList).toHaveBeenCalledWith({ status: 'all', limit: 0 }, '/tmp/fake-workspace');

    const store = new TaskStore({ prefix: 'dc', persistPath: path });
    await store.load();
    expect(store.size()).toBe(2);
    expect(store.list({ status: 'all' }).map((b) => b.title).sort()).toEqual(['Task one', 'Task two']);

    await cleanup(path);
  });

  it('returns migrated: 0, writes an empty file, and warns when bd has no beads', async () => {
    const path = TMP_PATH('bd-empty');
    await cleanup(path);

    vi.mocked(bdList).mockResolvedValueOnce([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await migrateFromBd({ cwd: '/tmp/fake-workspace', destPath: path });

      expect(result.migrated).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('zero tasks'));

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(path, 'utf8');
      expect(content).toBe('');
    } finally {
      warnSpy.mockRestore();
      await cleanup(path);
    }
  });

  it('overwrites an existing JSONL file', async () => {
    const path = TMP_PATH('bd-overwrite');
    await cleanup(path);

    // First write
    vi.mocked(bdList).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Old', status: 'open' },
    ]);
    await migrateFromBd({ cwd: '/tmp/fake-workspace', destPath: path });

    // Second write with different data
    vi.mocked(bdList).mockResolvedValueOnce([
      { id: 'ws-010', title: 'New', status: 'open' },
    ]);
    const result = await migrateFromBd({ cwd: '/tmp/fake-workspace', destPath: path });

    expect(result.migrated).toBe(1);

    const store = new TaskStore({ prefix: 'ws', persistPath: path });
    await store.load();
    expect(store.size()).toBe(1);
    expect(store.get('ws-010')?.title).toBe('New');
    expect(store.get('ws-001')).toBeUndefined();

    await cleanup(path);
  });

  it('propagates bdList errors to the caller', async () => {
    const path = TMP_PATH('bd-error');

    vi.mocked(bdList).mockRejectedValueOnce(new Error('bd: database not found'));

    await expect(migrateFromBd({ cwd: '/tmp/fake-workspace', destPath: path })).rejects.toThrow(
      'bd: database not found',
    );
  });
});
