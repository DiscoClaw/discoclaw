import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBeadSync } from './bead-sync.js';

vi.mock('../discord/inflight-replies.js', () => ({
  hasInFlightForChannel: vi.fn(() => false),
}));

vi.mock('./bd-cli.js', () => ({
  bdList: vi.fn(async () => []),
  bdUpdate: vi.fn(async () => {}),
}));

vi.mock('./discord-sync.js', () => ({
  resolveBeadsForum: vi.fn(async () => ({ threads: { fetchActive: vi.fn(async () => ({ threads: new Map() })), fetchArchived: vi.fn(async () => ({ threads: new Map() })) } })),
  createBeadThread: vi.fn(async () => 'thread-new'),
  closeBeadThread: vi.fn(async () => {}),
  isThreadArchived: vi.fn(async () => false),
  isBeadThreadAlreadyClosed: vi.fn(async () => false),
  updateBeadThreadName: vi.fn(async () => true),
  updateBeadStarterMessage: vi.fn(async () => true),
  updateBeadThreadTags: vi.fn(async () => false),
  getThreadIdFromBead: vi.fn((bead: any) => {
    const ref = (bead.external_ref ?? '').trim();
    if (!ref) return null;
    if (ref.startsWith('discord:')) return ref.slice('discord:'.length);
    if (/^\\d+$/.test(ref)) return ref;
    return null;
  }),
  ensureUnarchived: vi.fn(async () => {}),
  findExistingThreadForBead: vi.fn(async () => null),
  extractShortIdFromThreadName: vi.fn((name: string) => {
    const m = name.match(/\[(\d+)\]/);
    return m ? m[1] : null;
  }),
  shortBeadId: vi.fn((id: string) => {
    const idx = id.indexOf('-');
    return idx >= 0 ? id.slice(idx + 1) : id;
  }),
}));

function makeClient(): any {
  return { channels: { cache: { get: () => undefined } } };
}

function makeGuild(): any {
  return {};
}

describe('runBeadSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips no-thread beads in phase 1', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { createBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'A', status: 'open', labels: ['no-thread'], external_ref: '' },
    ]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.threadsCreated).toBe(0);
    expect(createBeadThread).not.toHaveBeenCalled();
  });

  it('dedupes by backfilling external_ref when a matching thread exists', async () => {
    const { bdList, bdUpdate } = await import('./bd-cli.js');
    const { createBeadThread, findExistingThreadForBead } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-002', title: 'B', status: 'open', labels: [], external_ref: '' },
    ]);
    (findExistingThreadForBead as any).mockResolvedValueOnce('thread-existing');

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.threadsCreated).toBe(0);
    expect(createBeadThread).not.toHaveBeenCalled();
    expect(bdUpdate).toHaveBeenCalledWith('ws-002', { externalRef: 'discord:thread-existing' }, '/tmp');
  });

  it('fixes open+blocked-label to blocked in phase 2', async () => {
    const { bdList, bdUpdate } = await import('./bd-cli.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-003', title: 'C', status: 'open', labels: ['blocked-waiting-on'], external_ref: 'discord:1' },
    ]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.statusesUpdated).toBe(1);
    expect(bdUpdate).toHaveBeenCalledWith('ws-003', { status: 'blocked' }, '/tmp');
  });

  it('phase 3 skips beads whose thread is already archived', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { isThreadArchived, ensureUnarchived, updateBeadThreadName } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-030', title: 'Archived active', status: 'in_progress', labels: [], external_ref: 'discord:300' },
    ]);
    (isThreadArchived as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '300');
    expect(ensureUnarchived).not.toHaveBeenCalled();
    expect(updateBeadThreadName).not.toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(0);
  });

  it('phase 3 processes non-archived beads through the guard', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { isThreadArchived, ensureUnarchived, updateBeadThreadName } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-031', title: 'Active bead', status: 'open', labels: [], external_ref: 'discord:301' },
    ]);
    (isThreadArchived as any).mockResolvedValueOnce(false);
    (updateBeadThreadName as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '301');
    expect(ensureUnarchived).toHaveBeenCalledWith(expect.anything(), '301');
    expect(updateBeadThreadName).toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(1);
  });

  it('renames threads for active beads in phase 3 and counts changes', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { ensureUnarchived, updateBeadThreadName } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-004', title: 'D', status: 'in_progress', labels: [], external_ref: 'discord:123' },
    ]);
    (updateBeadThreadName as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(ensureUnarchived).toHaveBeenCalledWith(expect.anything(), '123');
    expect(updateBeadThreadName).toHaveBeenCalled();
    expect(result.emojisUpdated).toBe(1);
  });

  it('calls updateBeadStarterMessage for active beads with threads in phase 3', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadStarterMessage } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-010', title: 'J', status: 'in_progress', labels: [], external_ref: 'discord:456' },
    ]);
    (updateBeadStarterMessage as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(updateBeadStarterMessage).toHaveBeenCalledWith(expect.anything(), '456', expect.objectContaining({ id: 'ws-010' }), undefined);
    expect(result.starterMessagesUpdated).toBe(1);
  });

  it('passes mentionUserId through to updateBeadStarterMessage in phase 3', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadStarterMessage } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-012', title: 'L', status: 'in_progress', labels: [], external_ref: 'discord:456' },
    ]);
    (updateBeadStarterMessage as any).mockResolvedValueOnce(true);

    await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
      mentionUserId: '999',
    } as any);

    expect(updateBeadStarterMessage).toHaveBeenCalledWith(expect.anything(), '456', expect.objectContaining({ id: 'ws-012' }), '999');
  });

  it('passes mentionUserId through to createBeadThread in phase 1', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { createBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-013', title: 'M', status: 'open', labels: [], external_ref: '' },
    ]);

    await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
      mentionUserId: '999',
    } as any);

    expect(createBeadThread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'ws-013' }), {}, '999');
  });

  it('starterMessagesUpdated stays 0 when updateBeadStarterMessage returns false', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadStarterMessage } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-011', title: 'K', status: 'open', labels: [], external_ref: 'discord:789' },
    ]);
    (updateBeadStarterMessage as any).mockResolvedValueOnce(false);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.starterMessagesUpdated).toBe(0);
  });

  it('archives threads for closed beads in phase 4', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-005', title: 'E', status: 'closed', labels: [], external_ref: 'discord:999' },
    ]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(closeBeadThread).toHaveBeenCalled();
    expect(result.threadsArchived).toBe(1);
  });

  it('skips fully-closed bead threads in phase 4', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { closeBeadThread, isBeadThreadAlreadyClosed } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-006', title: 'F', status: 'closed', labels: [], external_ref: 'discord:888' },
    ]);
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isBeadThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '888', expect.objectContaining({ id: 'ws-006' }), {});
    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
  });

  it('phase 4 uses isBeadThreadAlreadyClosed for full state check', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { isBeadThreadAlreadyClosed, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-040', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:400' },
    ]);
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(false);

    await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isBeadThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '400', expect.objectContaining({ id: 'ws-040' }), {});
    expect(closeBeadThread).toHaveBeenCalled();
  });

  it('phase 4 recovers archived thread with wrong name/tags', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { isBeadThreadAlreadyClosed, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-050', title: 'Stale name', status: 'closed', labels: [], external_ref: 'discord:500' },
    ]);
    // Thread is archived but has wrong name — isBeadThreadAlreadyClosed returns false
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(false);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isBeadThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '500', expect.objectContaining({ id: 'ws-050' }), {});
    expect(closeBeadThread).toHaveBeenCalled();
    expect(result.threadsArchived).toBe(1);
  });

  it('calls statusPoster.beadSyncComplete with the result when provided', async () => {
    const { bdList } = await import('./bd-cli.js');
    (bdList as any).mockResolvedValueOnce([]);

    const statusPoster = { beadSyncComplete: vi.fn(async () => {}) } as any;
    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
      statusPoster,
    } as any);

    expect(statusPoster.beadSyncComplete).toHaveBeenCalledOnce();
    expect(statusPoster.beadSyncComplete).toHaveBeenCalledWith(result);
  });

  it('works fine without statusPoster', async () => {
    const { bdList } = await import('./bd-cli.js');
    (bdList as any).mockResolvedValueOnce([]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(0);
  });

  it('tagsUpdated counter increments when updateBeadThreadTags returns true', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadThreadTags } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-020', title: 'T', status: 'open', labels: [], external_ref: 'discord:777' },
    ]);
    (updateBeadThreadTags as any).mockResolvedValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: { open: 's1' },
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(updateBeadThreadTags).toHaveBeenCalledWith(expect.anything(), '777', expect.objectContaining({ id: 'ws-020' }), { open: 's1' });
    expect(result.tagsUpdated).toBe(1);
  });

  it('warnings increment when updateBeadThreadTags throws', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadThreadTags } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-021', title: 'U', status: 'open', labels: [], external_ref: 'discord:888' },
    ]);
    (updateBeadThreadTags as any).mockRejectedValueOnce(new Error('Discord API failure'));

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBeGreaterThanOrEqual(1);
  });

  it('increments warnings counter on phase failures', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { updateBeadThreadName } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-008', title: 'H', status: 'in_progress', labels: [], external_ref: 'discord:555' },
    ]);
    (updateBeadThreadName as any).mockRejectedValueOnce(new Error('Discord API failure'));

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(1);
  });

  it('warnings counter increments when forum is not found', async () => {
    const { resolveBeadsForum } = await import('./discord-sync.js');
    (resolveBeadsForum as any).mockResolvedValueOnce(null);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBe(1);
  });

  it('accepts skipPhase5 option without error and skips phase 5', async () => {
    const { bdList } = await import('./bd-cli.js');
    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'A', status: 'closed', labels: [], external_ref: '' },
    ]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
      skipPhase5: true,
    } as any);

    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('phase 5 archives non-archived thread for closed bead and backfills external_ref', async () => {
    const { bdList, bdUpdate } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: '' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(1);
    expect(bdUpdate).toHaveBeenCalledWith('ws-001', { externalRef: 'discord:thread-100' }, '/tmp');
    expect(closeBeadThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 detects orphan threads with no matching bead', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-200', { id: 'thread-200', name: '\u{1F7E2} [999] Unknown bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.orphanThreadsFound).toBe(1);
    expect(result.threadsReconciled).toBe(0);
  });

  it('phase 5 skips threads with short-id collision (multiple beads)', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
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
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    // Collision: two beads with short ID "001" — should skip, not archive or count as orphan
    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
    // closeBeadThread should not be called from phase 5 (may be called from phase 4)
  });

  it('phase 5 skips thread when bead external_ref points to a different thread', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread, isBeadThreadAlreadyClosed } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:thread-OTHER' },
    ]);
    // Phase 4 will try to archive thread-OTHER — let it skip via already-closed check.
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    // Thread should be skipped by Phase 5 — external_ref points elsewhere.
    expect(result.threadsReconciled).toBe(0);
    // closeBeadThread should not have been called for thread-100 (Phase 5 skipped it).
    expect(closeBeadThread).not.toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.anything(), expect.anything(), expect.anything());
  });

  it('phase 5 archives thread when bead external_ref matches this thread', async () => {
    const { bdList, bdUpdate } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(1);
    // No backfill needed — external_ref already set.
    expect(bdUpdate).not.toHaveBeenCalledWith('ws-001', { externalRef: expect.anything() }, expect.anything());
    expect(closeBeadThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 still archives thread when external_ref backfill fails', async () => {
    const { bdList, bdUpdate } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: '' },
    ]);
    (bdUpdate as any).mockRejectedValueOnce(new Error('bd CLI failure'));

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    // Backfill failed but archive should still proceed.
    expect(result.warnings).toBeGreaterThanOrEqual(1);
    expect(result.threadsReconciled).toBe(1);
    expect(closeBeadThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 skips already-archived thread for closed bead when fully reconciled', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread, isBeadThreadAlreadyClosed } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4 checks isBeadThreadAlreadyClosed → true (skip).
    // Phase 5 also checks isBeadThreadAlreadyClosed for the archived thread → true (skip).
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u2705 [001] Closed bead', archived: true }],
          ]),
        })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    // Thread is already fully reconciled — no work from Phase 5.
    expect(result.threadsReconciled).toBe(0);
    // closeBeadThread should not be called (Phase 4 skipped, Phase 5 skipped via isBeadThreadAlreadyClosed).
    expect(closeBeadThread).not.toHaveBeenCalled();
  });

  it('phase 5 reconciles stale archived thread for closed bead via unarchive→edit→re-archive', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread, isBeadThreadAlreadyClosed } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4 checks isBeadThreadAlreadyClosed → true (skip Phase 4 archive).
    // Phase 5 checks isBeadThreadAlreadyClosed → false (thread is stale, needs reconcile).
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

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
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    // Phase 5 should have reconciled the stale archived thread.
    expect(result.threadsReconciled).toBe(1);
    expect(isBeadThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {});
    expect(closeBeadThread).toHaveBeenCalledWith(expect.anything(), 'thread-100', expect.objectContaining({ id: 'ws-001' }), {}, undefined);
  });

  it('phase 5 no-ops gracefully when forum has 0 threads', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Some bead', status: 'open', labels: [], external_ref: '' },
    ]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({ threads: new Map() })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('phase 5 handles fetchActive API error gracefully', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([]);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => { throw new Error('Discord API failure'); }),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(result.warnings).toBeGreaterThanOrEqual(1);
    expect(result.threadsReconciled).toBe(0);
    expect(result.orphanThreadsFound).toBe(0);
  });

  it('calls statusPoster.beadSyncComplete in forum-not-found early return', async () => {
    const { resolveBeadsForum } = await import('./discord-sync.js');
    (resolveBeadsForum as any).mockResolvedValueOnce(null);

    const statusPoster = { beadSyncComplete: vi.fn(async () => {}) } as any;
    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
      statusPoster,
    } as any);

    expect(statusPoster.beadSyncComplete).toHaveBeenCalledOnce();
    expect(statusPoster.beadSyncComplete).toHaveBeenCalledWith(result);
    expect(result.warnings).toBe(1);
  });

  it('phase 4 defers close when in-flight reply is active for that thread', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { closeBeadThread } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-005', title: 'E', status: 'closed', labels: [], external_ref: 'discord:999' },
    ]);
    (hasInFlightForChannel as any).mockReturnValueOnce(true);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
    expect(result.closesDeferred).toBe(1);
  });

  it('phase 5 defers close when in-flight reply is active for non-archived thread', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: '' },
    ]);
    // Phase 4 sees no thread (no external_ref), so hasInFlightForChannel is not called there.
    // Phase 5 finds the thread and checks in-flight.
    (hasInFlightForChannel as any).mockReturnValue(true);

    const mockForum = {
      threads: {
        create: vi.fn(async () => ({ id: 'thread-new' })),
        fetchActive: vi.fn(async () => ({
          threads: new Map([
            ['thread-100', { id: 'thread-100', name: '\u{1F7E2} [001] Closed bead', archived: false }],
          ]),
        })),
        fetchArchived: vi.fn(async () => ({ threads: new Map() })),
      },
    };
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsReconciled).toBe(0);
    expect(result.closesDeferred).toBeGreaterThanOrEqual(1);

    (hasInFlightForChannel as any).mockReturnValue(false);
  });

  it('phase 5 defers close when in-flight reply is active for archived stale thread', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { resolveBeadsForum, closeBeadThread, isBeadThreadAlreadyClosed } = await import('./discord-sync.js');
    const { hasInFlightForChannel } = await import('../discord/inflight-replies.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-001', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:thread-100' },
    ]);
    // Phase 4: already closed → skip (no hasInFlightForChannel call). Phase 5: stale → in-flight → defer.
    (isBeadThreadAlreadyClosed as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
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
    (resolveBeadsForum as any).mockResolvedValueOnce(mockForum);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsReconciled).toBe(0);
    expect(result.closesDeferred).toBe(1);
  });
});

