import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  registerInFlightReply,
  inFlightReplyCount,
  hasInFlightForChannel,
  isShuttingDown,
  drainInFlightReplies,
  loadOrphanedReplies,
  cleanupOrphanedReplies,
  setDataFilePath,
  _waitForPendingPersists,
  _resetForTest,
} from './inflight-replies.js';

function mockReply() {
  return { edit: vi.fn().mockResolvedValue(undefined) };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let tmpDir: string;

beforeEach(async () => {
  _resetForTest();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inflight-test-'));
});

afterEach(async () => {
  _resetForTest();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Disposer pattern
// ---------------------------------------------------------------------------

describe('registerInFlightReply', () => {
  it('returns a disposer function that unregisters the entry', () => {
    const reply = mockReply();
    const dispose = registerInFlightReply(reply, 'ch1', 'msg1', 'test');
    expect(inFlightReplyCount()).toBe(1);

    dispose();
    expect(inFlightReplyCount()).toBe(0);
  });

  it('double-dispose is a no-op', () => {
    const reply = mockReply();
    const dispose = registerInFlightReply(reply, 'ch1', 'msg1', 'test');
    expect(inFlightReplyCount()).toBe(1);

    dispose();
    dispose(); // second call should not throw or change count
    expect(inFlightReplyCount()).toBe(0);
  });

  it('tracks multiple entries independently', () => {
    const dispose1 = registerInFlightReply(mockReply(), 'ch1', 'msg1', 'a');
    const dispose2 = registerInFlightReply(mockReply(), 'ch2', 'msg2', 'b');
    expect(inFlightReplyCount()).toBe(2);

    dispose1();
    expect(inFlightReplyCount()).toBe(1);

    dispose2();
    expect(inFlightReplyCount()).toBe(0);
  });

  it('registration after drain immediately edits and returns no-op disposer', async () => {
    await drainInFlightReplies();
    expect(isShuttingDown()).toBe(true);

    const reply = mockReply();
    const dispose = registerInFlightReply(reply, 'ch1', 'msg1', 'late');

    // Should have been immediately edited.
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].content).toContain('Interrupted');

    // Disposer is a no-op; count stays 0.
    expect(inFlightReplyCount()).toBe(0);
    dispose();
    expect(inFlightReplyCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hasInFlightForChannel
// ---------------------------------------------------------------------------

describe('hasInFlightForChannel', () => {
  it('returns false with no registrations', () => {
    expect(hasInFlightForChannel('ch1')).toBe(false);
  });

  it('returns true when a reply is registered for that channelId', () => {
    registerInFlightReply(mockReply(), 'ch1', 'msg1', 'test');
    expect(hasInFlightForChannel('ch1')).toBe(true);
  });

  it('returns false for a different channelId', () => {
    registerInFlightReply(mockReply(), 'ch1', 'msg1', 'test');
    expect(hasInFlightForChannel('ch2')).toBe(false);
  });

  it('returns false after the disposer is called', () => {
    const dispose = registerInFlightReply(mockReply(), 'ch1', 'msg1', 'test');
    expect(hasInFlightForChannel('ch1')).toBe(true);
    dispose();
    expect(hasInFlightForChannel('ch1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// drainInFlightReplies
// ---------------------------------------------------------------------------

describe('drainInFlightReplies', () => {
  it('edits all registered replies with interrupted message', async () => {
    const reply1 = mockReply();
    const reply2 = mockReply();
    registerInFlightReply(reply1, 'ch1', 'msg1', 'a');
    registerInFlightReply(reply2, 'ch2', 'msg2', 'b');
    expect(inFlightReplyCount()).toBe(2);

    await drainInFlightReplies();

    expect(reply1.edit).toHaveBeenCalledOnce();
    expect(reply1.edit.mock.calls[0][0].content).toContain('Interrupted');
    expect(reply1.edit.mock.calls[0][0].content).toContain('restarting');
    expect(reply2.edit).toHaveBeenCalledOnce();
    expect(reply2.edit.mock.calls[0][0].content).toContain('Interrupted');
  });

  it('sets isShuttingDown flag to true', async () => {
    expect(isShuttingDown()).toBe(false);
    await drainInFlightReplies();
    expect(isShuttingDown()).toBe(true);
  });

  it('clears registry (second drain is a no-op)', async () => {
    const reply = mockReply();
    registerInFlightReply(reply, 'ch1', 'msg1', 'a');

    await drainInFlightReplies();
    expect(inFlightReplyCount()).toBe(0);
    expect(reply.edit).toHaveBeenCalledOnce();

    // Second drain should not edit again.
    await drainInFlightReplies();
    expect(reply.edit).toHaveBeenCalledOnce();
  });

  it('edit failures do not block other edits or throw', async () => {
    const reply1 = { edit: vi.fn().mockRejectedValue(new Error('Discord error')) };
    const reply2 = mockReply();
    registerInFlightReply(reply1, 'ch1', 'msg1', 'a');
    registerInFlightReply(reply2, 'ch2', 'msg2', 'b');

    // Should not throw.
    const log = mockLog();
    await drainInFlightReplies({ log });

    // reply2 should still have been edited.
    expect(reply2.edit).toHaveBeenCalledOnce();
    // The warning should have been logged.
    expect(log.warn).toHaveBeenCalled();
  });

  it('respects timeout (does not hang on slow edits)', async () => {
    const slowReply = {
      edit: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10_000))),
    };
    registerInFlightReply(slowReply, 'ch1', 'msg1', 'slow');

    const start = Date.now();
    await drainInFlightReplies({ timeoutMs: 100 });
    const elapsed = Date.now() - start;

    // Should complete in roughly the timeout, not 10s.
    expect(elapsed).toBeLessThan(2000);
    expect(isShuttingDown()).toBe(true);
  });

  it('drain with empty registry is a no-op', async () => {
    expect(inFlightReplyCount()).toBe(0);
    await drainInFlightReplies();
    expect(isShuttingDown()).toBe(true);
  });

  it('removes 🛑 reaction after editing', async () => {
    const removeSpy = vi.fn().mockResolvedValue(undefined);
    const reply = {
      edit: vi.fn().mockResolvedValue(undefined),
      reactions: {
        resolve: vi.fn().mockImplementation((emoji: string) =>
          emoji === '🛑' ? { remove: removeSpy } : null,
        ),
      },
    };
    registerInFlightReply(reply, 'ch1', 'msg1', 'test');

    await drainInFlightReplies();

    expect(removeSpy).toHaveBeenCalledOnce();
    expect(reply.reactions.resolve).toHaveBeenCalledWith('🛑');
  });

  it('does not throw when reply has no reactions property', async () => {
    const reply = mockReply(); // no reactions property
    registerInFlightReply(reply, 'ch1', 'msg1', 'test');

    // Should not throw.
    await drainInFlightReplies();

    expect(reply.edit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Persistent file
// ---------------------------------------------------------------------------

describe('persistent file', () => {
  it('register writes entry, dispose removes it', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    setDataFilePath(filePath);

    const dispose = registerInFlightReply(mockReply(), 'ch1', 'msg1', 'test');

    await _waitForPendingPersists();

    const raw = await fs.readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ channelId: 'ch1', messageId: 'msg1' });

    dispose();
    await _waitForPendingPersists();

    const raw2 = await fs.readFile(filePath, 'utf-8');
    const entries2 = JSON.parse(raw2);
    expect(entries2).toHaveLength(0);
  });

  it('drain clears the persistent file', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    setDataFilePath(filePath);

    registerInFlightReply(mockReply(), 'ch1', 'msg1', 'test');
    await _waitForPendingPersists();

    // File should exist.
    const stat = await fs.stat(filePath).catch(() => null);
    expect(stat).not.toBeNull();

    await drainInFlightReplies();

    // File should be removed.
    const stat2 = await fs.stat(filePath).catch(() => null);
    expect(stat2).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadOrphanedReplies
// ---------------------------------------------------------------------------

describe('loadOrphanedReplies', () => {
  it('returns entries from a valid file', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
      { channelId: 'ch2', messageId: 'msg2' },
    ]));

    const result = await loadOrphanedReplies(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ channelId: 'ch1', messageId: 'msg1' });
  });

  it('returns empty array for missing file', async () => {
    const result = await loadOrphanedReplies(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual([]);
  });

  it('returns empty array for corrupt file', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, 'not json');

    const result = await loadOrphanedReplies(filePath);
    expect(result).toEqual([]);
  });

  it('filters out malformed entries', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
      { bad: true },
      null,
      { channelId: 'ch2' }, // missing messageId
    ]));

    const result = await loadOrphanedReplies(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ channelId: 'ch1', messageId: 'msg1' });
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedReplies (cold-start recovery)
// ---------------------------------------------------------------------------

describe('cleanupOrphanedReplies', () => {
  it('fetches and edits orphaned messages, then clears file', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
    ]));

    const editFn = vi.fn().mockResolvedValue(undefined);
    const mockMessage = { edit: editFn };
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    };
    const log = mockLog();

    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    expect(client.channels.fetch).toHaveBeenCalledWith('ch1');
    expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg1');
    expect(editFn).toHaveBeenCalledOnce();
    expect(editFn.mock.calls[0][0].content).toContain('Interrupted');
    expect(editFn.mock.calls[0][0].content).toContain('was restarted');
    expect(log.info).toHaveBeenCalled();

    // File should be deleted.
    const stat = await fs.stat(filePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('is a no-op when file is missing', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.json');
    const client = {
      channels: { fetch: vi.fn() },
    };
    const log = mockLog();

    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('handles stale/unfetchable entries gracefully', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
      { channelId: 'ch2', messageId: 'msg2' },
    ]));

    const editFn = vi.fn().mockResolvedValue(undefined);
    const mockMessage = { edit: editFn };
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
    };
    const client = {
      channels: {
        fetch: vi.fn()
          .mockResolvedValueOnce(mockChannel)
          .mockRejectedValueOnce(new Error('Unknown Channel')),
      },
    };
    const log = mockLog();

    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    // First entry edited, second failed gracefully.
    expect(editFn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalled();
  });

  it('respects timeout', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
    ]));

    const client = {
      channels: {
        fetch: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10_000))),
      },
    };

    const start = Date.now();
    await cleanupOrphanedReplies({ client, dataFilePath: filePath, timeoutMs: 100 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  it('removes 🛑 via REST when client.rest.delete is available', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
    ]));

    const restDeleteSpy = vi.fn().mockResolvedValue(undefined);
    const mockMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
      reactions: {
        resolve: vi.fn().mockReturnValue({ remove: vi.fn() }),
      },
    };
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
      rest: { delete: restDeleteSpy },
    };
    const log = mockLog();

    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    expect(restDeleteSpy).toHaveBeenCalledOnce();
    expect(restDeleteSpy.mock.calls[0][0]).toContain('/channels/ch1/messages/msg1/reactions/');
    expect(restDeleteSpy.mock.calls[0][0]).toContain('/@me');
    // reactions.resolve should NOT be called when REST is available.
    expect(mockMessage.reactions.resolve).not.toHaveBeenCalled();
  });

  it('falls back to reactions.resolve when client.rest is unavailable', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
    ]));

    const removeSpy = vi.fn().mockResolvedValue(undefined);
    const mockMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
      reactions: {
        resolve: vi.fn().mockImplementation((emoji: string) =>
          emoji === '🛑' ? { remove: removeSpy } : null,
        ),
      },
    };
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    };
    const log = mockLog();

    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    expect(removeSpy).toHaveBeenCalledOnce();
    expect(mockMessage.reactions.resolve).toHaveBeenCalledWith('🛑');
  });

  it('does not throw when resolve returns null (reaction already gone)', async () => {
    const filePath = path.join(tmpDir, 'inflight.json');
    await fs.writeFile(filePath, JSON.stringify([
      { channelId: 'ch1', messageId: 'msg1' },
    ]));

    const mockMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
      reactions: {
        resolve: vi.fn().mockReturnValue(null),
      },
    };
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    };
    const log = mockLog();

    // Should not throw.
    await cleanupOrphanedReplies({ client, dataFilePath: filePath, log });

    expect(mockMessage.edit).toHaveBeenCalledOnce();
    expect(mockMessage.reactions.resolve).toHaveBeenCalledWith('🛑');
  });
});
