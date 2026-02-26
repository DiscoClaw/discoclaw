import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TranscriptionResult } from './types.js';
import { OpenaiSttProvider, buildWav } from './stt-openai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeFrame(data: number[] = [0, 1, 2, 3]): AudioFrame {
  return { buffer: Buffer.from(data), sampleRate: 16000, channels: 1 };
}

function mockFetch(text = 'hello world', ok = true, status = 200): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue({
    ok,
    status,
    json: async () => ({ text }),
    text: async () => (ok ? JSON.stringify({ text }) : 'API error'),
  } as Response);
}

function makeProvider(
  overrides: Partial<{
    apiKey: string;
    sampleRate: number;
    log: LoggerLike;
    silenceThresholdMs: number;
    fetchFn: typeof globalThis.fetch;
  }> = {},
) {
  return new OpenaiSttProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    sampleRate: overrides.sampleRate ?? 16000,
    log: overrides.log ?? createLogger(),
    silenceThresholdMs: overrides.silenceThresholdMs ?? 200,
    fetchFn: overrides.fetchFn ?? mockFetch(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenaiSttProvider', () => {
  // -- Lifecycle --

  it('start transitions to running state', async () => {
    const provider = makeProvider();
    await provider.start();
    // Should not throw when feeding after start
    provider.feedAudio(makeFrame());
  });

  it('double start is idempotent', async () => {
    const log = createLogger();
    const provider = makeProvider({ log });
    await provider.start();
    await provider.start();
    // info called once for the first start only
    expect(vi.mocked(log.info).mock.calls.filter((c) => c[0] === 'OpenAI Whisper STT started')).toHaveLength(1);
  });

  it('feedAudio before start throws', () => {
    const provider = makeProvider();
    expect(() => provider.feedAudio(makeFrame())).toThrow(
      'Cannot feedAudio before start() or after stop()',
    );
  });

  it('feedAudio after stop throws', async () => {
    const provider = makeProvider();
    await provider.start();
    await provider.stop();
    expect(() => provider.feedAudio(makeFrame())).toThrow(
      'Cannot feedAudio before start() or after stop()',
    );
  });

  it('stop is idempotent', async () => {
    const provider = makeProvider();
    await provider.start();
    await provider.stop();
    await provider.stop(); // should not throw
  });

  // -- Silence detection --

  it('triggers transcription after silence threshold', async () => {
    const fetchFn = mockFetch('hello');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 200 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame([1, 2, 3, 4]));

    // Advance past silence threshold
    await vi.advanceTimersByTimeAsync(200);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ text: 'hello', isFinal: true });
  });

  it('resets silence timer on new audio', async () => {
    const fetchFn = mockFetch('hello');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 200 });
    await provider.start();

    provider.feedAudio(makeFrame());

    // Advance partway (150ms < 200ms threshold)
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchFn).not.toHaveBeenCalled();

    // Feed more audio — resets timer
    provider.feedAudio(makeFrame());

    // Advance another 150ms (total 300ms from start, but only 150ms from last audio)
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchFn).not.toHaveBeenCalled();

    // Advance the remaining 50ms to hit threshold from last audio
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not trigger transcription when buffer is empty', async () => {
    const fetchFn = mockFetch();
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    await provider.start();

    // Feed then trigger silence so buffer is consumed
    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Now wait again — no new audio, so no second call
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // -- Buffer cleanup --

  it('clears buffer after transcription', async () => {
    const fetchFn = mockFetch('first');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame([1, 2]));
    await vi.advanceTimersByTimeAsync(100);
    expect(results).toHaveLength(1);

    // Feed new audio — should only contain the new data
    vi.mocked(fetchFn).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'second' }),
      text: async () => JSON.stringify({ text: 'second' }),
    } as Response);

    provider.feedAudio(makeFrame([3, 4]));
    await vi.advanceTimersByTimeAsync(100);

    expect(results).toHaveLength(2);
    expect(results[1]!.text).toBe('second');
  });

  it('stop transcribes remaining buffer', async () => {
    const fetchFn = mockFetch('final words');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 5000 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame([10, 20, 30]));

    // Stop before silence threshold — should flush remaining buffer
    await provider.stop();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('final words');
  });

  it('stop with empty buffer does not call API', async () => {
    const fetchFn = mockFetch();
    const provider = makeProvider({ fetchFn });
    await provider.start();
    await provider.stop();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // -- API request format --

  it('sends correct Authorization header and model', async () => {
    const fetchFn = mockFetch('test');
    const provider = makeProvider({ fetchFn, apiKey: 'sk-my-key', silenceThresholdMs: 100 });
    await provider.start();

    provider.feedAudio(makeFrame([1, 2, 3, 4]));
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-my-key');

    // Verify FormData contains model field
    const body = init!.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    // File should be present
    expect(body.get('file')).toBeTruthy();
  });

  it('sends audio as WAV file in FormData', async () => {
    const fetchFn = mockFetch('test');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    await provider.start();

    provider.feedAudio(makeFrame([10, 20, 30, 40]));
    await vi.advanceTimersByTimeAsync(100);

    const [, init] = vi.mocked(fetchFn).mock.calls[0]!;
    const body = init!.body as FormData;
    const file = body.get('file') as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/wav');

    // Verify it's a valid WAV (starts with RIFF header)
    const arrayBuf = await file.arrayBuffer();
    const header = Buffer.from(arrayBuf).subarray(0, 4).toString('ascii');
    expect(header).toBe('RIFF');
  });

  // -- Callback behavior --

  it('skips callback for empty transcription', async () => {
    const fetchFn = mockFetch('');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(0);
  });

  it('skips callback for whitespace-only transcription', async () => {
    const fetchFn = mockFetch('   ');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);

    expect(results).toHaveLength(0);
  });

  it('fires callback without onTranscription registered (no crash)', async () => {
    const fetchFn = mockFetch('hello');
    const provider = makeProvider({ fetchFn, silenceThresholdMs: 100 });
    // deliberately not calling onTranscription
    await provider.start();
    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);
    // Should not throw
  });

  // -- Error handling --

  it('logs error on non-OK API response', async () => {
    const fetchFn = mockFetch('', false, 401);
    const log = createLogger();
    const provider = makeProvider({ fetchFn, log, silenceThresholdMs: 100 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);

    expect(results).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      'OpenAI Whisper API error',
    );
  });

  it('logs error on fetch rejection', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('network down'));
    const log = createLogger();
    const provider = makeProvider({ fetchFn, log, silenceThresholdMs: 100 });
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    provider.feedAudio(makeFrame());
    await vi.advanceTimersByTimeAsync(100);

    expect(results).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'OpenAI Whisper transcription request failed',
    );
  });
});

// ---------------------------------------------------------------------------
// WAV header construction
// ---------------------------------------------------------------------------

describe('buildWav', () => {
  it('produces a valid 44-byte header + PCM data', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = buildWav(pcm, 16000, 1);

    expect(wav.length).toBe(44 + 4);

    // RIFF header
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 4); // ChunkSize
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

    // fmt sub-chunk
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16); // Subchunk1Size
    expect(wav.readUInt16LE(20)).toBe(1); // AudioFormat (PCM)
    expect(wav.readUInt16LE(22)).toBe(1); // NumChannels
    expect(wav.readUInt32LE(24)).toBe(16000); // SampleRate
    expect(wav.readUInt32LE(28)).toBe(32000); // ByteRate (16000 * 1 * 2)
    expect(wav.readUInt16LE(32)).toBe(2); // BlockAlign (1 * 2)
    expect(wav.readUInt16LE(34)).toBe(16); // BitsPerSample

    // data sub-chunk
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4); // data size

    // PCM data follows
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('handles stereo at 48kHz', () => {
    const pcm = Buffer.alloc(960); // some audio data
    const wav = buildWav(pcm, 48000, 2);

    expect(wav.readUInt16LE(22)).toBe(2); // NumChannels
    expect(wav.readUInt32LE(24)).toBe(48000); // SampleRate
    expect(wav.readUInt32LE(28)).toBe(192000); // ByteRate (48000 * 2 * 2)
    expect(wav.readUInt16LE(32)).toBe(4); // BlockAlign (2 * 2)
  });
});
