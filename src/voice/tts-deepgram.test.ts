import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame } from './types.js';
import { DeepgramTtsProvider, DEEPGRAM_MAX_CHARS } from './tts-deepgram.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Build a mock ReadableStream that yields the given byte arrays, then closes. */
function mockStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetch(
  chunks: Uint8Array[] = [new Uint8Array([1, 2, 3, 4])],
  ok = true,
  status = 200,
): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue({
    ok,
    status,
    body: ok ? mockStream(chunks) : null,
    text: async () => 'API error body',
  } as unknown as Response);
}

function makeProvider(
  overrides: Partial<{
    apiKey: string;
    model: string;
    sampleRate: number;
    speed: number;
    log: LoggerLike;
    fetchFn: typeof globalThis.fetch;
  }> = {},
) {
  return new DeepgramTtsProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    model: overrides.model,
    sampleRate: overrides.sampleRate,
    speed: overrides.speed,
    log: overrides.log ?? createLogger(),
    fetchFn: overrides.fetchFn ?? mockFetch(),
  });
}

async function collectFrames(iter: AsyncIterable<AudioFrame>): Promise<AudioFrame[]> {
  const frames: AudioFrame[] = [];
  for await (const frame of iter) {
    frames.push(frame);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeepgramTtsProvider', () => {
  it('sends correct API request with default model and linear16 encoding', async () => {
    const fetchFn = mockFetch([new Uint8Array([10, 20])]);
    const provider = makeProvider({ fetchFn, apiKey: 'dg-my-key' });

    await collectFrames(provider.synthesize('hello'));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toContain('https://api.deepgram.com/v1/speak');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=24000');
    expect(url).toContain('container=none');
    expect(url).toContain('model=aura-2-asteria-en');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Token dg-my-key',
    );
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );

    const body = JSON.parse(init!.body as string);
    expect(body.text).toBe('hello');
  });

  it('uses custom model and sampleRate', async () => {
    const fetchFn = mockFetch([new Uint8Array([1])]);
    const provider = makeProvider({
      fetchFn,
      model: 'aura-2-luna-en',
      sampleRate: 48000,
    });

    const frames = await collectFrames(provider.synthesize('test'));

    const [url] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toContain('model=aura-2-luna-en');
    expect(url).toContain('sample_rate=48000');
    expect(frames[0]!.sampleRate).toBe(48000);
  });

  it('streams multiple audio frames with correct metadata', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];
    const fetchFn = mockFetch(chunks);
    const provider = makeProvider({ fetchFn });

    const frames = await collectFrames(provider.synthesize('hello world'));

    expect(frames).toHaveLength(3);
    expect([...frames[0]!.buffer]).toEqual([1, 2, 3]);
    expect([...frames[1]!.buffer]).toEqual([4, 5, 6]);
    expect([...frames[2]!.buffer]).toEqual([7, 8, 9]);

    for (const frame of frames) {
      expect(frame.sampleRate).toBe(24000);
      expect(frame.channels).toBe(1);
    }
  });

  it('empty text yields no frames and does not call API', async () => {
    const fetchFn = mockFetch();
    const provider = makeProvider({ fetchFn });

    const frames = await collectFrames(provider.synthesize(''));
    expect(frames).toHaveLength(0);

    const frames2 = await collectFrames(provider.synthesize('   '));
    expect(frames2).toHaveLength(0);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws on non-OK HTTP response', async () => {
    const fetchFn = mockFetch([], false, 429);
    const provider = makeProvider({ fetchFn });

    await expect(collectFrames(provider.synthesize('test'))).rejects.toThrow(
      'Deepgram TTS API error: 429',
    );
  });

  it('throws when response has no body stream', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => '',
    } as unknown as Response);
    const provider = makeProvider({ fetchFn });

    await expect(collectFrames(provider.synthesize('test'))).rejects.toThrow(
      'response has no body stream',
    );
  });

  describe('text truncation', () => {
    it('passes through text under the limit unchanged', async () => {
      const fetchFn = mockFetch();
      const provider = makeProvider({ fetchFn });
      const shortText = 'a'.repeat(DEEPGRAM_MAX_CHARS - 1);

      await collectFrames(provider.synthesize(shortText));

      const [, init] = vi.mocked(fetchFn).mock.calls[0]!;
      expect(JSON.parse(init!.body as string).text).toBe(shortText);
    });

    it('passes through text exactly at the limit unchanged', async () => {
      const fetchFn = mockFetch();
      const provider = makeProvider({ fetchFn });
      const exactText = 'a'.repeat(DEEPGRAM_MAX_CHARS);

      await collectFrames(provider.synthesize(exactText));

      const [, init] = vi.mocked(fetchFn).mock.calls[0]!;
      expect(JSON.parse(init!.body as string).text).toBe(exactText);
    });

    it('truncates text over the limit to at most DEEPGRAM_MAX_CHARS chars', async () => {
      const fetchFn = mockFetch();
      const provider = makeProvider({ fetchFn });
      const longText = 'a'.repeat(DEEPGRAM_MAX_CHARS + 500);

      await collectFrames(provider.synthesize(longText));

      const [, init] = vi.mocked(fetchFn).mock.calls[0]!;
      const sentText = JSON.parse(init!.body as string).text as string;
      expect(sentText.length).toBeLessThanOrEqual(DEEPGRAM_MAX_CHARS);
    });

    it('cuts at the last sentence boundary when truncating', async () => {
      const fetchFn = mockFetch();
      const log = createLogger();
      const provider = makeProvider({ fetchFn, log });
      // Build text with a sentence boundary well before the limit
      const prefix = 'Hello world. ';
      const filler = 'x'.repeat(DEEPGRAM_MAX_CHARS - prefix.length + 100);
      const longText = prefix + filler;

      await collectFrames(provider.synthesize(longText));

      const [, init] = vi.mocked(fetchFn).mock.calls[0]!;
      const sentText = JSON.parse(init!.body as string).text as string;
      expect(sentText).toBe('Hello world.');
      expect(sentText.length).toBeLessThanOrEqual(DEEPGRAM_MAX_CHARS);
    });

    it('logs a warning with original and truncated lengths when truncating', async () => {
      const fetchFn = mockFetch();
      const log = createLogger();
      const provider = makeProvider({ fetchFn, log });
      const longText = 'a'.repeat(DEEPGRAM_MAX_CHARS + 100);

      await collectFrames(provider.synthesize(longText));

      expect(log.warn).toHaveBeenCalledTimes(1);
      const [meta, msg] = vi.mocked(log.warn).mock.calls[0]!;
      expect((meta as Record<string, unknown>).originalLength).toBe(longText.length);
      expect((meta as Record<string, unknown>).truncatedLength).toBeLessThanOrEqual(DEEPGRAM_MAX_CHARS);
      expect(msg).toContain('truncated');
    });

    it('does not log a warning for text within the limit', async () => {
      const fetchFn = mockFetch();
      const log = createLogger();
      const provider = makeProvider({ fetchFn, log });

      await collectFrames(provider.synthesize('short text'));

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('speed parameter', () => {
    it('includes speed in the URL when set', async () => {
      const fetchFn = mockFetch([new Uint8Array([1])]);
      const provider = makeProvider({ fetchFn, speed: 1.2 });

      await collectFrames(provider.synthesize('hello'));

      const [url] = vi.mocked(fetchFn).mock.calls[0]!;
      expect(url).toContain('speed=1.2');
    });

    it('omits speed from the URL when not set', async () => {
      const fetchFn = mockFetch([new Uint8Array([1])]);
      const provider = makeProvider({ fetchFn });

      await collectFrames(provider.synthesize('hello'));

      const [url] = vi.mocked(fetchFn).mock.calls[0]!;
      expect(url).not.toContain('speed=');
    });

    it('throws RangeError when speed is below 0.5', () => {
      expect(() => makeProvider({ speed: 0.4 })).toThrow(RangeError);
    });

    it('throws RangeError when speed is above 1.5', () => {
      expect(() => makeProvider({ speed: 1.6 })).toThrow(RangeError);
    });
  });

  it('single large chunk yields one frame', async () => {
    const big = new Uint8Array(16384);
    big.fill(42);
    const fetchFn = mockFetch([big]);
    const provider = makeProvider({ fetchFn });

    const frames = await collectFrames(provider.synthesize('long text'));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.buffer.length).toBe(16384);
    expect(frames[0]!.sampleRate).toBe(24000);
    expect(frames[0]!.channels).toBe(1);
  });
});
