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
  isBeadThreadAlreadyClosed: vi.fn(async () => false),
  updateBeadThreadName: vi.fn(async () => true),
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

    expect(isBeadThreadAlreadyClosed).toHaveBeenCalledWith(expect.anything(), '888', expect.objectContaining({ id: 'ws-006' }));
    expect(closeBeadThread).not.toHaveBeenCalled();
    expect(result.threadsArchived).toBe(0);
  });

  it('archives threads for tombstone beads in phase 4', async () => {
    const { bdList } = await import('./bd-cli.js');
    const { closeBeadThread } = await import('./discord-sync.js');

    (bdList as any).mockResolvedValueOnce([
      { id: 'ws-007', title: 'G', status: 'tombstone', labels: [], external_ref: 'discord:777' },
    ]);

    const result = await runBeadSync({
      client: makeClient(),
      guild: makeGuild(),
      forumId: 'forum',
      tagMap: {},
      beadsCwd: '/tmp',
      throttleMs: 0,
    } as any);

    expect(closeBeadThread).toHaveBeenCalledWith(expect.anything(), '777', expect.objectContaining({ id: 'ws-007', status: 'tombstone' }));
    expect(result.threadsArchived).toBe(1);
  });
});

