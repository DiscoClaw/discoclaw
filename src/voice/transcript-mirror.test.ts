import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import { TranscriptMirror, type TranscriptMirrorOpts } from './transcript-mirror.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockChannel() {
  return {
    id: 'ch-transcript',
    send: vi.fn(async () => ({})),
    isTextBased: () => true,
    isDMBased: () => false,
  };
}

function createMockClient(channel: ReturnType<typeof createMockChannel> | null = null) {
  const cache = new Map<string, unknown>();
  if (channel) cache.set(channel.id, channel);
  return {
    channels: {
      cache: {
        get: vi.fn((id: string) => cache.get(id)),
      },
      fetch: vi.fn(async (id: string) => cache.get(id) ?? null),
    },
  };
}

function createMirror(overrides: Partial<TranscriptMirrorOpts> = {}) {
  const channel = createMockChannel();
  const client = createMockClient(channel);
  const log = createLogger();
  const mirror = new TranscriptMirror({
    client: client as unknown as TranscriptMirrorOpts['client'],
    channelId: channel.id,
    log,
    ...overrides,
  });
  return { mirror, channel, client, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TranscriptMirror', () => {
  describe('postUserTranscription', () => {
    it('sends a formatted user transcription message', async () => {
      const { mirror, channel } = createMirror();

      await mirror.postUserTranscription('Alice', 'Hello world');

      expect(channel.send).toHaveBeenCalledWith({
        content: '**Alice** (voice): Hello world',
        allowedMentions: { parse: [] },
      });
    });

    it('skips empty or whitespace-only text', async () => {
      const { mirror, channel } = createMirror();

      await mirror.postUserTranscription('Alice', '');
      await mirror.postUserTranscription('Alice', '   ');

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('sanitizes markdown bold in username', async () => {
      const { mirror, channel } = createMirror();

      await mirror.postUserTranscription('**evil**', 'hi');

      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '**evil** (voice): hi',
        }),
      );
    });
  });

  describe('postBotResponse', () => {
    it('sends a formatted bot response message', async () => {
      const { mirror, channel } = createMirror();

      await mirror.postBotResponse('DiscoClaw', 'I can help with that');

      expect(channel.send).toHaveBeenCalledWith({
        content: '**DiscoClaw** (voice reply): I can help with that',
        allowedMentions: { parse: [] },
      });
    });

    it('skips empty text', async () => {
      const { mirror, channel } = createMirror();

      await mirror.postBotResponse('DiscoClaw', '');

      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  describe('channel resolution', () => {
    it('resolves channel from cache on first send', async () => {
      const { mirror, client } = createMirror();

      await mirror.postUserTranscription('Alice', 'test');

      expect(client.channels.cache.get).toHaveBeenCalledWith('ch-transcript');
    });

    it('falls back to fetch when not in cache', async () => {
      const channel = createMockChannel();
      const client = createMockClient();
      // Not in cache, but available via fetch
      client.channels.fetch.mockResolvedValue(channel);

      const log = createLogger();
      const mirror = new TranscriptMirror({
        client: client as unknown as TranscriptMirrorOpts['client'],
        channelId: channel.id,
        log,
      });

      await mirror.postUserTranscription('Alice', 'test');

      expect(client.channels.fetch).toHaveBeenCalledWith(channel.id);
      expect(channel.send).toHaveBeenCalled();
    });

    it('caches resolved channel for subsequent sends', async () => {
      const { mirror, client, channel } = createMirror();

      await mirror.postUserTranscription('Alice', 'first');
      await mirror.postUserTranscription('Alice', 'second');

      // Cache.get called only once for resolution; subsequent sends reuse
      expect(client.channels.cache.get).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it('warns and gives up when channel cannot be found', async () => {
      const client = createMockClient();
      const log = createLogger();
      const mirror = new TranscriptMirror({
        client: client as unknown as TranscriptMirrorOpts['client'],
        channelId: 'nonexistent',
        log,
      });

      await mirror.postUserTranscription('Alice', 'test');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'nonexistent' }),
        'transcript-mirror: channel not found or not text-based',
      );
    });

    it('does not retry after resolution failure', async () => {
      const client = createMockClient();
      const log = createLogger();
      const mirror = new TranscriptMirror({
        client: client as unknown as TranscriptMirrorOpts['client'],
        channelId: 'nonexistent',
        log,
      });

      await mirror.postUserTranscription('Alice', 'first');
      await mirror.postUserTranscription('Alice', 'second');

      // fetch called only once — second attempt skipped due to resolveFailed
      expect(client.channels.fetch).toHaveBeenCalledTimes(1);
    });

    it('warns when fetch throws', async () => {
      const client = createMockClient();
      client.channels.fetch.mockRejectedValue(new Error('network error'));
      const log = createLogger();
      const mirror = new TranscriptMirror({
        client: client as unknown as TranscriptMirrorOpts['client'],
        channelId: 'bad-id',
        log,
      });

      await mirror.postUserTranscription('Alice', 'test');

      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('message sending failures', () => {
    it('warns but does not throw when send fails', async () => {
      const channel = createMockChannel();
      channel.send.mockRejectedValue(new Error('Missing permissions'));
      const client = createMockClient(channel);
      const log = createLogger();
      const mirror = new TranscriptMirror({
        client: client as unknown as TranscriptMirrorOpts['client'],
        channelId: channel.id,
        log,
      });

      // Should not throw
      await mirror.postUserTranscription('Alice', 'test');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: channel.id }),
        'transcript-mirror: failed to send message',
      );
    });
  });

  describe('message truncation', () => {
    it('truncates messages exceeding 2000 characters', async () => {
      const { mirror, channel } = createMirror();
      const longText = 'x'.repeat(2100);

      await mirror.postUserTranscription('A', longText);

      const sentContent = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
      expect(sentContent.length).toBe(2000);
      expect(sentContent.endsWith('\u2026')).toBe(true);
    });
  });
});
