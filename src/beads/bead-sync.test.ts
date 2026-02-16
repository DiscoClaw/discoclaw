import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBeadSync } from './bead-sync.js';

vi.mock('./bd-cli.js', () => ({
  bdList: vi.fn(async () => []),
  bdUpdate: vi.fn(async () => {}),
}));

vi.mock('./discord-sync.js', () => ({
  resolveBeadsForum: vi.fn(async () => ({})),
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

  it('skips already-archived closed bead threads in phase 4', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { closeBeadThread, isThreadArchived } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-006', title: 'F', status: 'closed', labels: [], external_ref: 'discord:888' },
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

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '888');
    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
  });

  it('phase 4 uses isThreadArchived, not isBeadThreadAlreadyClosed', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { isThreadArchived, isBeadThreadAlreadyClosed, closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-040', title: 'Closed bead', status: 'closed', labels: [], external_ref: 'discord:400' },
    ]);
    (isThreadArchived as any).mockResolvedValueOnce(false);

    await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(isThreadArchived).toHaveBeenCalledWith(expect.anything(), '400');
    expect(isBeadThreadAlreadyClosed).not.toHaveBeenCalled();
    expect(closeBeadThread).toHaveBeenCalled();
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
});

