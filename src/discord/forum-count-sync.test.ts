import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ForumCountSync, stripCountSuffix } from './forum-count-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChannel(name: string) {
  return {
    name,
    type: 15, // ChannelType.GuildForum
    setName: vi.fn(async () => {}),
  };
}

function makeClient(channel: ReturnType<typeof mockChannel>) {
  return {
    channels: {
      cache: {
        get: vi.fn(() => channel),
      },
    },
  } as any;
}

// ---------------------------------------------------------------------------
// stripCountSuffix
// ---------------------------------------------------------------------------

describe('stripCountSuffix', () => {
  it('strips count suffix from "beads ・ 12"', () => {
    expect(stripCountSuffix('beads ・ 12')).toBe('beads');
  });

  it('no-ops on name without suffix', () => {
    expect(stripCountSuffix('crons')).toBe('crons');
  });

  it('strips count suffix from "my forum ・ 0"', () => {
    expect(stripCountSuffix('my forum ・ 0')).toBe('my forum');
  });

  it('handles multiple spaces around separator', () => {
    expect(stripCountSuffix('beads  ・  5')).toBe('beads');
  });
});

// ---------------------------------------------------------------------------
// ForumCountSync
// ---------------------------------------------------------------------------

describe('ForumCountSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces multiple rapid requestUpdate() calls into single setName()', async () => {
    const channel = mockChannel('beads');
    const client = makeClient(channel);
    const countFn = vi.fn(() => 5);

    const sync = new ForumCountSync(client, 'forum-1', countFn);

    sync.requestUpdate();
    sync.requestUpdate();
    sync.requestUpdate();

    // Advance past debounce (10s).
    await vi.advanceTimersByTimeAsync(10_000);

    expect(countFn).toHaveBeenCalledTimes(1);
    expect(channel.setName).toHaveBeenCalledTimes(1);
    expect(channel.setName).toHaveBeenCalledWith('beads ・ 5');

    sync.stop();
  });

  it('rate-limits: second call within 5min defers to remaining time', async () => {
    const channel = mockChannel('beads');
    const client = makeClient(channel);
    let count = 3;
    const countFn = vi.fn(() => count);

    const sync = new ForumCountSync(client, 'forum-1', countFn);

    // First update.
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.setName).toHaveBeenCalledTimes(1);
    expect(channel.setName).toHaveBeenCalledWith('beads ・ 3');

    // Second update shortly after.
    count = 4;
    // Update the channel mock name to reflect last setName.
    channel.name = 'beads ・ 3';
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000); // debounce fires, but rate limit defers

    // Should not have made a second setName yet (rate-limited).
    expect(channel.setName).toHaveBeenCalledTimes(1);

    // Advance to remaining time (~5min - 20s = ~280s).
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(channel.setName).toHaveBeenCalledTimes(2);
    expect(channel.setName).toHaveBeenLastCalledWith('beads ・ 4');

    sync.stop();
  });

  it('no-op does not consume rate budget', async () => {
    const channel = mockChannel('beads ・ 5');
    const client = makeClient(channel);
    const countFn = vi.fn(() => 5);

    const sync = new ForumCountSync(client, 'forum-1', countFn);

    // First update: name unchanged, no setName call.
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(countFn).toHaveBeenCalledTimes(1);
    expect(channel.setName).not.toHaveBeenCalled();

    // Second update shortly after with different count — should execute immediately
    // (no rate limit since lastUpdateMs was never set).
    countFn.mockReturnValue(6);
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.setName).toHaveBeenCalledTimes(1);
    expect(channel.setName).toHaveBeenCalledWith('beads ・ 6');

    sync.stop();
  });

  it('deferred timer fires and executes the update', async () => {
    const channel = mockChannel('beads');
    const client = makeClient(channel);
    let count = 1;
    const countFn = vi.fn(() => count);
    const log = { info: vi.fn(), warn: vi.fn() };

    const sync = new ForumCountSync(client, 'forum-1', countFn, log as any);

    // First update to set lastUpdateMs.
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.setName).toHaveBeenCalledTimes(1);

    // Request another update (will be deferred).
    count = 2;
    channel.name = 'beads ・ 1';
    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000); // debounce fires

    // Should have logged deferred.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ forumId: 'forum-1' }),
      expect.stringContaining('deferred'),
    );

    // Advance past the remaining rate limit time.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(channel.setName).toHaveBeenCalledTimes(2);

    sync.stop();
  });

  it('countFn error is logged and does not throw or call setName', async () => {
    const channel = mockChannel('beads');
    const client = makeClient(channel);
    const countFn = vi.fn(() => { throw new Error('count failed'); });
    const log = { info: vi.fn(), warn: vi.fn() };

    const sync = new ForumCountSync(client, 'forum-1', countFn, log as any);

    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ forumId: 'forum-1' }),
      expect.stringContaining('countFn failed'),
    );
    expect(channel.setName).not.toHaveBeenCalled();

    sync.stop();
  });

  it('429 error reschedules at retry_after duration', async () => {
    const channel = mockChannel('beads');
    const rateLimitError = Object.assign(new Error('rate limited'), { retryAfter: 30 });
    channel.setName = vi.fn(async () => { throw rateLimitError; });
    const client = makeClient(channel);
    const countFn = vi.fn(() => 5);
    const log = { info: vi.fn(), warn: vi.fn() };

    const sync = new ForumCountSync(client, 'forum-1', countFn, log as any);

    sync.requestUpdate();
    await vi.advanceTimersByTimeAsync(10_000); // debounce fires, setName throws 429

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ forumId: 'forum-1', retryAfter: 30 }),
      expect.stringContaining('rate limited'),
    );

    // Fix setName for retry.
    channel.setName = vi.fn(async () => {});
    await vi.advanceTimersByTimeAsync(30_000); // retry_after fires

    expect(channel.setName).toHaveBeenCalledWith('beads ・ 5');

    sync.stop();
  });

  it('stop() cancels all pending timers', async () => {
    const channel = mockChannel('beads');
    const client = makeClient(channel);
    const countFn = vi.fn(() => 5);

    const sync = new ForumCountSync(client, 'forum-1', countFn);

    sync.requestUpdate();
    sync.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(countFn).not.toHaveBeenCalled();
    expect(channel.setName).not.toHaveBeenCalled();
  });
});
