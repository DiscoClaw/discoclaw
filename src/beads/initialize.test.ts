import { describe, expect, it, vi } from 'vitest';
import type { InitializeBeadsOpts } from './initialize.js';

// ---------------------------------------------------------------------------
// Mock bd-cli so we can control availability without a real binary
// ---------------------------------------------------------------------------

vi.mock('./bd-cli.js', () => ({
  checkBdAvailable: vi.fn(),
}));

vi.mock('./discord-sync.js', () => ({
  loadTagMap: vi.fn().mockResolvedValue({ bug: '111', feature: '222' }),
}));

vi.mock('./forum-guard.js', () => ({
  initBeadsForumGuard: vi.fn(),
}));

import { checkBdAvailable } from './bd-cli.js';
import { initializeBeadsContext } from './initialize.js';

const mockCheckBd = vi.mocked(checkBdAvailable);

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

  it('returns undefined and warns when no forum resolved', async () => {
    mockCheckBd.mockResolvedValue({ available: true, version: '1.0.0' });
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
    const result = await initializeBeadsContext(baseOpts({
      beadsForum: '',
      systemBeadsForumId: 'system-forum-456',
    }));
    expect(result.beadCtx).toBeDefined();
    expect(result.beadCtx!.forumId).toBe('system-forum-456');
  });
});
