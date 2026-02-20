import { describe, expect, it, vi } from 'vitest';
import type { InitializeBeadsOpts } from './initialize.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./discord-sync.js', () => ({
  loadTagMap: vi.fn().mockResolvedValue({ bug: '111', feature: '222' }),
}));

vi.mock('./forum-guard.js', () => ({
  initBeadsForumGuard: vi.fn(),
}));

vi.mock('./bead-sync-coordinator.js', () => ({
  BeadSyncCoordinator: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { initBeadsForumGuard } from './forum-guard.js';
import { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import { initializeBeadsContext, wireBeadsSync } from './initialize.js';
import { TaskStore } from '../tasks/store.js';

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function baseOpts(overrides: Partial<InitializeBeadsOpts> = {}): InitializeBeadsOpts {
  return {
    enabled: true,
    beadsCwd: '/tmp/beads',
    beadsForum: 'forum-123',
    beadsTagMapPath: '/tmp/tag-map.json',
    beadsSidebar: false,
    beadsAutoTag: true,
    beadsAutoTagModel: 'haiku',
    runtime: {} as any,
    log: fakeLog(),
    ...overrides,
  };
}

describe('initializeBeadsContext', () => {
  it('returns undefined with no warnings when disabled', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ enabled: false, log }));
    expect(result.beadCtx).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns when no forum resolved', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
      beadsForum: '',
      systemBeadsForumId: undefined,
      log,
    }));
    expect(result.beadCtx).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no forum resolved'),
    );
  });

  it('returns BeadContext when all prerequisites met', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ log }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.forumId).toBe('forum-123');
    expect(result.beadCtx!.autoTag).toBe(true);
  });

  it('resolves forum from systemBeadsForumId when beadsForum is empty', async () => {
    const result = await initializeBeadsContext(baseOpts({
      beadsForum: '',
      systemBeadsForumId: 'system-forum-456',
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.forumId).toBe('system-forum-456');
  });

  it('sets sidebarMentionUserId when sidebar enabled with mention user', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
      beadsSidebar: true,
      beadsMentionUser: 'user-789',
      log,
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.sidebarMentionUserId).toBe('user-789');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when sidebar enabled but mention user not set', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
      beadsSidebar: true,
      beadsMentionUser: undefined,
      log,
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.sidebarMentionUserId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('sidebar mentions will be inactive'),
    );
  });

  it('does not set sidebarMentionUserId when sidebar disabled', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
      beadsSidebar: false,
      beadsMentionUser: 'user-789',
      log,
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.sidebarMentionUserId).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('propagates tagMapPath to BeadContext', async () => {
    const result = await initializeBeadsContext(baseOpts({
      beadsTagMapPath: '/my/custom/tag-map.json',
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.tagMapPath).toBe('/my/custom/tag-map.json');
  });

  it('uses provided store instead of creating a new one', async () => {
    const store = new TaskStore();
    const result = await initializeBeadsContext(baseOpts({ store }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.store).toBe(store);
  });
});

describe('wireBeadsSync', () => {
  it('wires forum guard, coordinator, and store event listeners', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      store,
      log,
    } as any;
    const client = {} as any;
    const guild = {} as any;

    const result = await wireBeadsSync({
      beadCtx,
      client,
      guild,
      guildId: 'guild-1',
      beadsCwd: '/tmp/beads',
      sidebarMentionUserId: 'user-1',
      log,
    });

    expect(initBeadsForumGuard).toHaveBeenCalledWith({
      client,
      forumId: 'forum-123',
      log,
      store,
      tagMap: { bug: '111' },
    });
    expect(BeadSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        guild,
        forumId: 'forum-123',
        mentionUserId: 'user-1',
      }),
    );
    // The coordinator's sync() should have been called (fire-and-forget startup sync).
    const coordinatorInstance = vi.mocked(BeadSyncCoordinator).mock.results[0]?.value;
    expect(coordinatorInstance.sync).toHaveBeenCalled();
    expect(beadCtx.syncCoordinator).toBeDefined();
    expect(result).toHaveProperty('stop');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ beadsCwd: '/tmp/beads' }),
      'beads:store-event watcher started',
    );
  });

  it('store events trigger coordinator sync', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(BeadSyncCoordinator).mockClear();

    await wireBeadsSync({
      beadCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      beadsCwd: '/tmp/beads',
      log,
    });

    const coordinatorInstance = vi.mocked(BeadSyncCoordinator).mock.results[0]?.value;
    const callsBefore = coordinatorInstance.sync.mock.calls.length;

    // Trigger a store mutation — the event listener should call coordinator.sync()
    store.create({ title: 'Test task' });

    expect(coordinatorInstance.sync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('stop() removes store event listeners', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(BeadSyncCoordinator).mockClear();

    const result = await wireBeadsSync({
      beadCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      beadsCwd: '/tmp/beads',
      log,
    });

    result.stop();

    const coordinatorInstance = vi.mocked(BeadSyncCoordinator).mock.results[0]?.value;
    const callsAfterStop = coordinatorInstance.sync.mock.calls.length;

    // After stop(), store mutations should NOT trigger additional syncs
    store.create({ title: 'Another task' });
    expect(coordinatorInstance.sync.mock.calls.length).toBe(callsAfterStop);
  });

  it('skips forum guard when skipForumGuard is true', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(initBeadsForumGuard).mockClear();

    await wireBeadsSync({
      beadCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      beadsCwd: '/tmp/beads',
      log,
      skipForumGuard: true,
    });

    expect(initBeadsForumGuard).not.toHaveBeenCalled();
    // Coordinator should still be wired
    expect(BeadSyncCoordinator).toHaveBeenCalled();
  });

  it('propagates tagMapPath to CoordinatorOptions', async () => {
    const log = fakeLog();
    const tagMap = { bug: '111' };
    const store = new TaskStore();
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap,
      tagMapPath: '/config/tag-map.json',
      store,
      log,
    } as any;

    await wireBeadsSync({
      beadCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      beadsCwd: '/tmp/beads',
      log,
    });

    expect(BeadSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        tagMapPath: '/config/tag-map.json',
        tagMap,
      }),
    );
  });
});
