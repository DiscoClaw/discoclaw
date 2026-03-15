import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame } from './types.js';
import { OpenaiTtsProvider } from './tts-openai.js';

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
    voice: string;
    sampleRate: number;
    log: LoggerLike;
    fetchFn: typeof globalThis.fetch;
  }> = {},
) {
  return new OpenaiTtsProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    model: overrides.model,
    voice: overrides.voice,
    sampleRate: overrides.sampleRate,
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

describe('OpenaiTtsProvider', () => {
  it('sends correct API request with default model, voice, and pcm format', async () => {
    const fetchFn = mockFetch([new Uint8Array([10, 20])]);
    const provider = makeProvider({ fetchFn, apiKey: 'sk-my-key' });

    await collectFrames(provider.synthesize('hello'));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-my-key',
    );
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('tts-1');
    expect(body.voice).toBe('alloy');
    expect(body.input).toBe('hello');
    expect(body.response_format).toBe('pcm');
  });

  it('uses custom model, voice, and sampleRate', async () => {
    const fetchFn = mockFetch([new Uint8Array([1])]);
    const provider = makeProvider({
      fetchFn,
      model: 'tts-1-hd',
      voice: 'nova',
      sampleRate: 48000,
    });

    const frames = await collectFrames(provider.synthesize('test'));

    const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('tts-1-hd');
    expect(body.voice).toBe('nova');

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
      'OpenAI TTS API error: 429',
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
