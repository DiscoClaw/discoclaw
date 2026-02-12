import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CronSyncCoordinator } from './cron-sync-coordinator.js';
import type { CronSyncCoordinatorOptions } from './cron-sync-coordinator.js';
import type { CronSyncResult } from './cron-sync.js';

// Mock the dependencies
vi.mock('./tag-map.js', () => ({
  reloadCronTagMapInPlace: vi.fn(async () => 2),
}));

vi.mock('./cron-sync.js', () => ({
  runCronSync: vi.fn(async () => ({
    tagsApplied: 1,
    namesUpdated: 0,
    statusMessagesUpdated: 1,
    orphansDetected: 0,
  } satisfies CronSyncResult)),
}));

import { reloadCronTagMapInPlace } from './tag-map.js';
import { runCronSync } from './cron-sync.js';

const mockReload = vi.mocked(reloadCronTagMapInPlace);
const mockRunCronSync = vi.mocked(runCronSync);

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeOpts(overrides?: Partial<CronSyncCoordinatorOptions>): CronSyncCoordinatorOptions {
  return {
    client: {} as any,
    forumId: 'forum-1',
    scheduler: {} as any,
    statsStore: {} as any,
    runtime: {} as any,
    tagMap: { monitoring: 'tag-1', daily: 'tag-2' },
    tagMapPath: '/tmp/tags.json',
    autoTag: true,
    autoTagModel: 'haiku',
    cwd: '/tmp',
    log: mockLog(),
    ...overrides,
  };
}

describe('CronSyncCoordinator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReload.mockResolvedValue(2);
    mockRunCronSync.mockResolvedValue({
      tagsApplied: 1, namesUpdated: 0, statusMessagesUpdated: 1, orphansDetected: 0,
    });
  });

  it('reloads tag map before sync when tagMapPath is set', async () => {
    const opts = makeOpts();
    const coordinator = new CronSyncCoordinator(opts);
    await coordinator.sync();
    expect(mockReload).toHaveBeenCalledWith('/tmp/tags.json', opts.tagMap);
  });

  it('falls back to cached map on reload failure', async () => {
    mockReload.mockRejectedValue(new Error('ENOENT'));
    const opts = makeOpts();
    const coordinator = new CronSyncCoordinator(opts);
    const result = await coordinator.sync();
    expect(result).not.toBeNull();
    expect(opts.log?.warn).toHaveBeenCalled();
    expect(mockRunCronSync).toHaveBeenCalled();
  });

  it('passes snapshot to runCronSync (same values, different ref)', async () => {
    const opts = makeOpts();
    const coordinator = new CronSyncCoordinator(opts);
    await coordinator.sync();
    const callArgs = mockRunCronSync.mock.calls[0][0];
    expect(callArgs.tagMap).toEqual(opts.tagMap);
    expect(callArgs.tagMap).not.toBe(opts.tagMap);
  });

  it('coalesced concurrent sync returns null', async () => {
    let resolveSync!: () => void;
    mockRunCronSync.mockImplementation(() => new Promise((resolve) => {
      resolveSync = () => resolve({ tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, orphansDetected: 0 });
    }));

    const coordinator = new CronSyncCoordinator(makeOpts());
    const first = coordinator.sync();
    const second = coordinator.sync();
    expect(await second).toBeNull();
    resolveSync();
    const firstResult = await first;
    expect(firstResult).not.toBeNull();
  });

  it('fires follow-up after coalesced sync', async () => {
    let resolveSync!: () => void;
    let callCount = 0;
    mockRunCronSync.mockImplementation(() => new Promise((resolve) => {
      callCount++;
      if (callCount === 1) {
        resolveSync = () => resolve({ tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, orphansDetected: 0 });
      } else {
        resolve({ tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, orphansDetected: 0 });
      }
    }));

    const coordinator = new CronSyncCoordinator(makeOpts());
    const first = coordinator.sync();
    // Let the reload await resolve so runCronSync gets called and resolveSync is assigned
    await new Promise((r) => setTimeout(r, 10));
    coordinator.sync(); // coalesced
    resolveSync();
    await first;
    // Wait for follow-up fire-and-forget
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRunCronSync).toHaveBeenCalledTimes(2);
  });

  it('calls forumCountSync.requestUpdate on success', async () => {
    const forumCountSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    const coordinator = new CronSyncCoordinator(makeOpts({ forumCountSync: forumCountSync as any }));
    await coordinator.sync();
    expect(forumCountSync.requestUpdate).toHaveBeenCalled();
  });
});
