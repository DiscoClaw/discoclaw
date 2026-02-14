import { describe, expect, it, vi } from 'vitest';
import type { InitializeBeadsOpts } from './initialize.js';

// ---------------------------------------------------------------------------
// Mock bd-cli so we can control availability without a real binary
// ---------------------------------------------------------------------------

vi.mock('./bd-cli.js', () => ({
  checkBdAvailable: vi.fn(),
  ensureBdDatabaseReady: vi.fn(),
}));

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

vi.mock('./bead-sync-watcher.js', () => ({
  startBeadSyncWatcher: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

import { checkBdAvailable, ensureBdDatabaseReady } from './bd-cli.js';
import { initBeadsForumGuard } from './forum-guard.js';
import { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import { startBeadSyncWatcher } from './bead-sync-watcher.js';
import { initializeBeadsContext, wireBeadsSync } from './initialize.js';

const mockCheckBd = vi.mocked(checkBdAvailable);
const mockEnsureDbReady = vi.mocked(ensureBdDatabaseReady);

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
    expect(result.bdAvailable).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns when bd CLI not available', async () => {
    mockCheckBd.mockResolvedValue({ available: false });
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ log }));
    expect(result.beadCtx).toBeUndefined();
    expect(result.bdAvailable).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('bd CLI not found'),
    );
  });

  it('returns undefined and errors when database not ready', async () => {
    mockCheckBd.mockResolvedValue({ available: true, version: '1.0.0' });
    mockEnsureDbReady.mockResolvedValue({ ready: false });
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ log }));
    expect(result.beadCtx).toBeUndefined();
    expect(result.bdAvailable).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ beadsCwd: '/tmp/beads' }),
      expect.stringContaining('database not initialized'),
    );
  });

  it('returns undefined and warns when no forum resolved', async () => {
    mockCheckBd.mockResolvedValue({ available: true, version: '1.0.0' });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
      beadsForum: '',
      systemBeadsForumId: undefined,
      log,
    }));
    expect(result.beadCtx).toBeUndefined();
    expect(result.bdAvailable).toBe(true);
    expect(result.bdVersion).toBe('1.0.0');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no forum resolved'),
    );
  });

  it('returns BeadContext when all prerequisites met', async () => {
    mockCheckBd.mockResolvedValue({ available: true, version: '1.2.3' });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ log }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.forumId).toBe('forum-123');
    expect(result.beadCtx!.autoTag).toBe(true);
    expect(result.bdAvailable).toBe(true);
    expect(result.bdVersion).toBe('1.2.3');
  });

  it('resolves forum from systemBeadsForumId when beadsForum is empty', async () => {
    mockCheckBd.mockResolvedValue({ available: true });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
    const result = await initializeBeadsContext(baseOpts({
      beadsForum: '',
      systemBeadsForumId: 'system-forum-456',
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.forumId).toBe('system-forum-456');
  });

  it('sets sidebarMentionUserId when sidebar enabled with mention user', async () => {
    mockCheckBd.mockResolvedValue({ available: true });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
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
    mockCheckBd.mockResolvedValue({ available: true });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
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
    mockCheckBd.mockResolvedValue({ available: true });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
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
    mockCheckBd.mockResolvedValue({ available: true });
    mockEnsureDbReady.mockResolvedValue({ ready: true, prefix: 'test' });
    const result = await initializeBeadsContext(baseOpts({
      beadsTagMapPath: '/my/custom/tag-map.json',
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.tagMapPath).toBe('/my/custom/tag-map.json');
  });
});

describe('wireBeadsSync', () => {
  it('wires forum guard, coordinator, and sync watcher', async () => {
    const log = fakeLog();
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
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
    expect(startBeadSyncWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        beadsCwd: '/tmp/beads',
        log,
      }),
    );
    expect(beadCtx.syncCoordinator).toBeDefined();
    expect(result.syncWatcher).toBeDefined();
    expect(result.syncWatcher).toHaveProperty('stop');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ beadsCwd: '/tmp/beads' }),
      'beads:file-watcher started',
    );
  });

  it('propagates tagMapPath to CoordinatorOptions and watcher', async () => {
    const log = fakeLog();
    const tagMap = { bug: '111' };
    const beadCtx = {
      beadsCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap,
      tagMapPath: '/config/tag-map.json',
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
    expect(startBeadSyncWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        tagMapPath: '/config/tag-map.json',
        tagMap,
      }),
    );
  });
});
