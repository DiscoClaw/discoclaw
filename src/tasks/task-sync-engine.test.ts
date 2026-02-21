import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTaskSync } from './task-sync-engine.js';
import { withDirectTaskLifecycle } from './task-lifecycle.js';

vi.mock('../discord/inflight-replies.js', () => ({
  hasInFlightForChannel: vi.fn(() => false),
}));

var discordSyncMock: any;
function makeDiscordSyncMock() {
  if (!discordSyncMock) {
    const resolveTasksForum = vi.fn(async () => ({ threads: { fetchActive: vi.fn(async () => ({ threads: new Map() })), fetchArchived: vi.fn(async () => ({ threads: new Map() })) } }));
    const createTaskThread = vi.fn(async () => 'thread-new');
    const closeTaskThread = vi.fn(async () => {});
    const isThreadArchived = vi.fn(async () => false);
    const isTaskThreadAlreadyClosed = vi.fn(async () => false);
    const updateTaskThreadName = vi.fn(async () => true);
    const updateTaskStarterMessage = vi.fn(async () => true);
    const updateTaskThreadTags = vi.fn(async () => false);
    const getThreadIdFromTask = vi.fn((task: any) => {
      const ref = (task.external_ref ?? '').trim();
      if (!ref) return null;
      if (ref.startsWith('discord:')) return ref.slice('discord:'.length);
      if (/^\\d+$/.test(ref)) return ref;
      return null;
    });
    const ensureUnarchived = vi.fn(async () => {});
    const findExistingThreadForTask = vi.fn(async () => null);
    const extractShortIdFromThreadName = vi.fn((name: string) => {
      const m = name.match(/\[(\d+)\]/);
      return m ? m[1] : null;
    });
    const shortTaskId = vi.fn((id: string) => {
      const idx = id.indexOf('-');
      return idx >= 0 ? id.slice(idx + 1) : id;
    });

    discordSyncMock = {
      resolveTasksForum,
      createTaskThread,
      closeTaskThread,
      isThreadArchived,
      isTaskThreadAlreadyClosed,
      updateTaskThreadName,
      updateTaskStarterMessage,
      updateTaskThreadTags,
      getThreadIdFromTask,
      ensureUnarchived,
      findExistingThreadForTask,
      extractShortIdFromThreadName,
      shortTaskId,
    };
  }
  return discordSyncMock;
}

vi.mock('./discord-sync.js', makeDiscordSyncMock);

function makeStore(tasks: any[] = []): any {
  const byId = new Map<string, any>(tasks.map((task) => [task.id, { ...task }]));
  return {
    list: vi.fn(() => [...byId.values()]),
    get: vi.fn((id: string) => byId.get(id)),
    update: vi.fn((id: string, params: { status?: string; externalRef?: string }) => {
      const existing = byId.get(id);
      if (!existing) return;
      const updated = {
        ...existing,
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.externalRef !== undefined ? { external_ref: params.externalRef } : {}),
      };
      byId.set(id, updated);
      return updated;
    }),
  };
}

function makeClient(): any {
  return { channels: { cache: { get: () => undefined } } };
}

function makeGuild(): any {
  return {};
}

describe('runTaskSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips no-thread tasks in phase 1', async () => {
    const { createTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'A', status: 'open', labels: ['no-thread'], external_ref: '' },
    ]);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.threadsCreated).toBe(0);
    expect(createTaskThread).not.toHaveBeenCalled();
  });

  it('dedupes by backfilling external_ref when a matching thread exists', async () => {
    const { createTaskThread, findExistingThreadForTask } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-002', title: 'B', status: 'open', labels: [], external_ref: '' },
    ]);
    (findExistingThreadForTask as any).mockResolvedValueOnce('thread-existing');

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.threadsCreated).toBe(0);
    expect(createTaskThread).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('ws-002', { externalRef: 'discord:thread-existing' });
  });

  it('re-checks latest phase 1 task state after lock wait and skips create when already linked', async () => {
    const { createTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-014', title: 'N', status: 'open', labels: [], external_ref: '' },
    ]);

    let applyUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      applyUpdate = resolve;
    });
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    const owner = withDirectTaskLifecycle('ws-014', async () => {
      await updateGate;
      store.update('ws-014', { externalRef: 'discord:thread-linked' });
      await ownerGate;
    });

    const syncRun = runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    await Promise.resolve();
    applyUpdate();
    await Promise.resolve();
    releaseOwner();

    const result = await syncRun;
    await owner;

    expect(result.threadsCreated).toBe(0);
    expect(createTaskThread).not.toHaveBeenCalled();
  });

  it('fixes open+blocked-label to blocked in phase 2', async () => {
    const store = makeStore([
      { id: 'ws-003', title: 'C', status: 'open', labels: ['blocked-waiting-on'], external_ref: 'discord:1' },
    ]);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.statusesUpdated).toBe(1);
    expect(store.update).toHaveBeenCalledWith('ws-003', { status: 'blocked' });
  });

  it('phase 3 skips tasks whose thread is already archived', async () => {
    const { isThreadArchived, ensureUnarchived, updateTaskThreadName } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-030', title: 'Archived active', status: 'in_progress', labels: [], external_ref: 'discord:300' },
    ]);
    (isThreadArchived as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '300');
    expect(ensureUnarchived).not.toHaveBeenCalled();
    expect(updateTaskThreadName).not.toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(0);
  });

  it('phase 3 processes non-archived tasks through the guard', async () => {
    const { isThreadArchived, ensureUnarchived, updateTaskThreadName } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-031', title: 'Active task', status: 'open', labels: [], external_ref: 'discord:301' },
    ]);
    (isThreadArchived as any).mockResolvedValueOnce(false);
    (updateTaskThreadName as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '301');
    expect(ensureUnarchived).toHaveBeenCalledWith(expect.anything(), '301');
    expect(updateTaskThreadName).toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(1);
  });

  it('renames threads for active tasks in phase 3 and counts changes', async () => {
    const { ensureUnarchived, updateTaskThreadName } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-004', title: 'D', status: 'in_progress', labels: [], external_ref: 'discord:123' },
    ]);
    (updateTaskThreadName as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(ensureUnarchived).toHaveBeenCalledWith(expect.anything(), '123');
    expect(updateTaskThreadName).toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(1);
  });

  it('calls updateTaskStarterMessage for active tasks with threads in phase 3', async () => {
    const { updateTaskStarterMessage } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-010', title: 'J', status: 'in_progress', labels: [], external_ref: 'discord:456' },
    ]);
    (updateTaskStarterMessage as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(updateTaskStarterMessage).toHaveBeenCalledWith(expect.anything(), '456', expect.objectContaining({ id: 'ws-010' }), undefined);
    expect(result.starterMessagesUpdated).toBe(1);
  });

  it('passes mentionUserId through to updateTaskStarterMessage in phase 3', async () => {
    const { updateTaskStarterMessage } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-012', title: 'L', status: 'in_progress', labels: [], external_ref: 'discord:456' },
    ]);
    (updateTaskStarterMessage as any).mockResolvedValueOnce(true);

    await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
      mentionUserId: '999',
    } as any);

    expect(updateTaskStarterMessage).toHaveBeenCalledWith(expect.anything(), '456', expect.objectContaining({ id: 'ws-012' }), '999');
  });

  it('passes mentionUserId through to createTaskThread in phase 1', async () => {
    const { createTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-013', title: 'M', status: 'open', labels: [], external_ref: '' },
    ]);

    await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
      mentionUserId: '999',
    } as any);

    expect(createTaskThread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'ws-013' }), {}, '999');
  });

  it('starterMessagesUpdated stays 0 when updateTaskStarterMessage returns false', async () => {
    const { updateTaskStarterMessage } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-011', title: 'K', status: 'open', labels: [], external_ref: 'discord:789' },
    ]);
    (updateTaskStarterMessage as any).mockResolvedValueOnce(false);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.starterMessagesUpdated).toBe(0);
  });

  it('archives threads for closed tasks in phase 4', async () => {
    const { closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-005', title: 'E', status: 'closed', labels: [], external_ref: 'discord:999' },
    ]);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(closeTaskThread).toHaveBeenCalled();
    expect(result.threadsArchived).toBe(1);
  });

  it('skips fully-closed task threads in phase 4', async () => {
    const { closeTaskThread, isTaskThreadAlreadyClosed } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-006', title: 'F', status: 'closed', labels: [], external_ref: 'discord:888' },
    ]);
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(isTaskThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '888', expect.objectContaining({ id: 'ws-006' }), {});
    expect(closeTaskThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
  });

  it('phase 4 uses isTaskThreadAlreadyClosed for full state check', async () => {
    const { isTaskThreadAlreadyClosed, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-040', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:400' },
    ]);
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(false);

    await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(isTaskThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '400', expect.objectContaining({ id: 'ws-040' }), {});
    expect(closeTaskThread).toHaveBeenCalled();
  });

  it('phase 4 recovers archived thread with wrong name/tags', async () => {
    const { isTaskThreadAlreadyClosed, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-050', title: 'Stale name', status: 'closed', labels: [], external_ref: 'discord:500' },
    ]);
    // Thread is archived but has wrong name — isTaskThreadAlreadyClosed returns false
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(false);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(isTaskThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '500', expect.objectContaining({ id: 'ws-050' }), {});
    expect(closeTaskThread).toHaveBeenCalled();
    expect(result.threadsArchived).toBe(1);
  });

  it('calls statusPoster.taskSyncComplete with the result when provided', async () => {
    const store = makeStore([]);
    const statusPoster = { taskSyncComplete: vi.fn(async () => {}) } as any;
    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
      statusPoster,
    } as any);

    expect(statusPoster.taskSyncComplete).toHaveBeenCalledOnce();
    expect(statusPoster.taskSyncComplete).toHaveBeenCalledWith(result);
  });

  it('works fine without statusPoster', async () => {
    const store = makeStore([]);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(0);
  });

  it('tagsUpdated counter increments when updateTaskThreadTags returns true', async () => {
    const { updateTaskThreadTags } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-020', title: 'T', status: 'open', labels: [], external_ref: 'discord:777' },
    ]);
    (updateTaskThreadTags as any).mockResolvedValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: { open: 's1' },
      store,
      throttleMs: 0,
    } as any);

    expect(updateTaskThreadTags).toHaveBeenCalledWith(expect.anything(), '777', expect.objectContaining({ id: 'ws-020' }), { open: 's1' });
    expect(result.tagsUpdated).toBe(1);
  });

  it('warnings increment when updateTaskThreadTags throws', async () => {
    const { updateTaskThreadTags } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-021', title: 'U', status: 'open', labels: [], external_ref: 'discord:888' },
    ]);
    (updateTaskThreadTags as any).mockRejectedValueOnce(new Error('Discord API failure'));

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBeGreaterThanOrEqual(1);
  });

  it('increments warnings counter on phase failures', async () => {
    const { updateTaskThreadName } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-008', title: 'H', status: 'in_progress', labels: [], external_ref: 'discord:555' },
    ]);
    (updateTaskThreadName as any).mockRejectedValueOnce(new Error('Discord API failure'));

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(1);
  });

  it('warnings counter increments when forum is not found', async () => {
    const { resolveTasksForum } = await import('./discord-sync.js');
    (resolveTasksForum as any).mockResolvedValueOnce(null);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store: makeStore([]),
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(1);
  });

  it('accepts skipPhase5 option without error and skips phase 5', async () => {
    const store = makeStore([
      { id: 'ws-001', title: 'A', status: 'closed', labels: [], external_ref: '' },
    ]);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
      skipPhase5: true,
    } as any);

    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('phase 5 archives non-archived thread for closed task and backfills external_ref', async () => {
    const { resolveTasksForum, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: '' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(1);
    expect(store.update).toHaveBeenCalledWith('ws-001', { externalRef: 'discord:thread-100' });
    expect(closeTaskThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 detects orphan threads with no matching task', async () => {
    const { resolveTasksForum } = await import('./discord-sync.js');
    const store = makeStore([]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-200', { id: 'thread-200', name: '\u{1F7E2} [999] Unknown task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.orphanThreadsFound).toBe(1);
    expect(result.threadsReconciled).toBe(0);
  });

  it('phase 5 skips threads with short-id collision (multiple tasks)', async () => {
    const { resolveTasksForum, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'First', status: 'closed', labels: [], external_ref: '' },
      { id: 'other-001', title: 'Second', status: 'open', labels: [], external_ref: '' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-300', { id: 'thread-300', name: '\u{1F7E2} [001] First', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    // Collision: two tasks with short ID "001" — should skip, not archive or count as orphan
    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
    // closeTaskThread should not be called from phase 5 (may be called from phase 4)
  });

  it('phase 5 skips thread when task external_ref points to a different thread', async () => {
    const { resolveTasksForum, closeTaskThread, isTaskThreadAlreadyClosed } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:thread-OTHER' },
    ]);
    // Phase 4 will try to archive thread-OTHER — let it skip via already-closed check.
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    // Thread should be skipped by Phase 5 — external_ref points elsewhere.
    expect(result.threadsReconciled).toBe(0);
    // closeTaskThread should not have been called for thread-100 (Phase 5 skipped it).
    expect(closeTaskThread).not.toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.anything(), expect.anything(), expect.anything());
  });

  it('phase 5 archives thread when task external_ref matches this thread', async () => {
    const { resolveTasksForum, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(1);
    // No backfill needed — external_ref already set.
    expect(store.update).not.toHaveBeenCalledWith('ws-001', { externalRef: expect.anything() });
    expect(closeTaskThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 still archives thread when external_ref backfill fails', async () => {
    const { resolveTasksForum, closeTaskThread } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: '' },
    ]);
    store.update.mockImplementationOnce(() => { throw new Error('store failure'); });

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    // Backfill failed but archive should still proceed.
    expect(result.warnings).toBeGreaterThanOrEqual(1);
    expect(result.threadsReconciled).toBe(1);
    expect(closeTaskThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 skips already-archived thread for closed task when fully reconciled', async () => {
    const { resolveTasksForum, closeTaskThread, isTaskThreadAlreadyClosed } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4 checks isTaskThreadAlreadyClosed → true (skip).
    // Phase 5 also checks isTaskThreadAlreadyClosed for the archived thread → true (skip).
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u2705 [001] Closed task', archived: true }],
          ]),
        })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    // Thread is already fully reconciled — no work from Phase 5.
    expect(result.threadsReconciled).toBe(0);
    // closeTaskThread should not be called (Phase 4 skipped, Phase 5 skipped via isTaskThreadAlreadyClosed).
    expect(closeTaskThread).not.toHaveBeenCalled();
  });

  it('phase 5 reconciles stale archived thread for closed task via unarchive→edit→re-archive', async () => {
    const { resolveTasksForum, closeTaskThread, isTaskThreadAlreadyClosed } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4 checks isTaskThreadAlreadyClosed → true (skip Phase 4 archive).
    // Phase 5 checks isTaskThreadAlreadyClosed → false (thread is stale, needs reconcile).
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E0} [001] Old stale name', archived: true }],
          ]),
        })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    // Phase 5 should have reconciled the stale archived thread.
    expect(result.threadsReconciled).toBe(1);
    expect(isTaskThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {});
    expect(closeTaskThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 no-ops gracefully when forum has 0 threads', async () => {
    const { resolveTasksForum } = await import('./discord-sync.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Some task', status: 'open', labels: [], external_ref: '' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('phase 5 handles fetchActive API error gracefully', async () => {
    const { resolveTasksForum } = await import('./discord-sync.js');
    const store = makeStore([]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => { throw new Error('Discord API failure'); }),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBeGreaterThanOrEqual(1);
    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('calls statusPoster.taskSyncComplete in forum-not-found early return', async () => {
    const { resolveTasksForum } = await import('./discord-sync.js');
    (resolveTasksForum as any).mockResolvedValueOnce(null);

    const statusPoster = { taskSyncComplete: vi.fn(async () => {}) } as any;
    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store: makeStore([]),
      throttleMs: 0,
      statusPoster,
    } as any);

    expect(statusPoster.taskSyncComplete).toHaveBeenCalledOnce();
    expect(statusPoster.taskSyncComplete).toHaveBeenCalledWith(result);
    expect(result.warnings).toBe(1);
  });

  it('phase 4 defers close when in-flight reply is active for that thread', async () => {
    const { closeTaskThread } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');
    const store = makeStore([
      { id: 'ws-005', title: 'E', status: 'closed', labels: [], external_ref: 'discord:999' },
    ]);
    (hasInFlightForChannel as any).mockReturnValueOnce(true);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(closeTaskThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
    expect(result.closesDeferred).toBe(1);
  });

  it('phase 5 defers close when in-flight reply is active for non-archived thread', async () => {
    const { resolveTasksForum, closeTaskThread } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: '' },
    ]);
    // Phase 4 sees no thread (no external_ref), so hasInFlightForChannel is not called there.
    // Phase 5 finds the thread and checks in-flight.
    (hasInFlightForChannel as any).mockReturnValue(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed task', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(closeTaskThread).not.toHaveBeenCalled();
    expect(result.threadsReconciled).toBe(0);
    expect(result.closesDeferred).toBeGreaterThanOrEqual(1);

    (hasInFlightForChannel as any).mockReturnValue(false);
  });

  it('phase 5 defers close when in-flight reply is active for archived stale thread', async () => {
    const { resolveTasksForum, closeTaskThread, isTaskThreadAlreadyClosed } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');
    const store = makeStore([
      { id: 'ws-001', title: 'Closed task', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4: already closed → skip (no hasInFlightForChannel call). Phase 5: stale → in-flight → defer.
    (isTaskThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    (hasInFlightForChannel as any).mockReturnValueOnce(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E0} [001] Old stale name', archived: true }],
          ]),
        })),
      },
    };
    (resolveTasksForum as any).mockResolvedValueOnce(mockForum);

    const result = await runTaskSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      store,
      throttleMs: 0,
    } as any);

    expect(closeTaskThread).not.toHaveBeenCalled();
    expect(result.threadsReconciled).toBe(0);
    expect(result.closesDeferred).toBe(1);
  });
});
