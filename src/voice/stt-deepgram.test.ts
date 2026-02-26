import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TranscriptionResult } from './types.js';
import { DeepgramSttProvider } from './stt-deepgram.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventHandler = (event: unknown) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  onopen: WsEventHandler | null = null;
  onmessage: WsEventHandler | null = null;
  onerror: WsEventHandler | null = null;
  onclose: WsEventHandler | null = null;

  sent: unknown[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    // Auto-open on next microtask so callers can attach handlers
    queueMicrotask(() => this.onopen?.({ type: 'open' }));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  _receiveMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as unknown);
  }

  _triggerClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as unknown);
  }

  _triggerError(): void {
    this.onerror?.({ type: 'error' } as unknown);
  }
}

// Patch class-level constants onto prototype for readyState comparisons
// (WebSocket.OPEN is used in the provider)
Object.defineProperty(MockWebSocket, 'OPEN', { value: 1 });
Object.defineProperty(MockWebSocket, 'CLOSED', { value: 3 });

// We also need to make the global WebSocket constants available since the
// provider references WebSocket.OPEN for readyState checks.
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let lastCreatedWs: MockWebSocket | null = null;

function wsFactory(url: string | URL): MockWebSocket {
  const ws = new MockWebSocket(url);
  lastCreatedWs = ws;
  return ws;
}

const WsConstructor = wsFactory as unknown as new (url: string | URL) => WebSocket;

function makeProvider(overrides: Partial<{ apiKey: string; sampleRate: number; log: LoggerLike }> = {}) {
  return new DeepgramSttProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    sampleRate: overrides.sampleRate ?? 16000,
    log: overrides.log ?? createLogger(),
    wsConstructor: WsConstructor,
  });
}

function makeFrame(data: number[] = [0, 1, 2, 3]): AudioFrame {
  return { buffer: Buffer.from(data), sampleRate: 16000, channels: 1 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  lastCreatedWs = null;
});

describe('DeepgramSttProvider', () => {
  it('start opens connection with correct URL including query params', async () => {
    const provider = makeProvider({ apiKey: 'my-key', sampleRate: 48000 });
    await provider.start();

    expect(lastCreatedWs).not.toBeNull();
    const url = new URL(lastCreatedWs!.url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('48000');
    expect(url.searchParams.get('token')).toBe('my-key');
  });

  it('feedAudio sends binary data', async () => {
    const provider = makeProvider();
    await provider.start();

    const frame = makeFrame([10, 20, 30]);
    provider.feedAudio(frame);

    expect(lastCreatedWs!.sent).toHaveLength(1);
    expect(lastCreatedWs!.sent[0]).toEqual(frame.buffer);
  });

  it('parses Deepgram JSON into TranscriptionResult for interim results', async () => {
    const provider = makeProvider();
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    lastCreatedWs!._receiveMessage({
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: 'hello', confidence: 0.85 }] },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ text: 'hello', confidence: 0.85, isFinal: false });
  });

  it('parses Deepgram JSON into TranscriptionResult for final results', async () => {
    const provider = makeProvider();
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    lastCreatedWs!._receiveMessage({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'hello world', confidence: 0.97 }] },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ text: 'hello world', confidence: 0.97, isFinal: true });
  });

  it('isFinal requires both is_final and speech_final', async () => {
    const provider = makeProvider();
    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));
    await provider.start();

    // is_final true but speech_final false → not final
    lastCreatedWs!._receiveMessage({
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: 'partial', confidence: 0.9 }] },
    });

    expect(results[0]!.isFinal).toBe(false);
  });

  it('stop sends CloseStream message', async () => {
    const provider = makeProvider();
    await provider.start();
    const ws = lastCreatedWs!;

    await provider.stop();

    const closeMsg = ws.sent.find(
      (m) => typeof m === 'string' && JSON.parse(m).type === 'CloseStream',
    );
    expect(closeMsg).toBeDefined();
  });

  it('double stop is idempotent', async () => {
    const provider = makeProvider();
    await provider.start();

    await provider.stop();
    // Should not throw
    await provider.stop();
  });

  it('feedAudio before start throws', () => {
    const provider = makeProvider();
    expect(() => provider.feedAudio(makeFrame())).toThrow(
      'Cannot feedAudio before start() or after stop()',
    );
  });

  it('reconnect fires on unexpected close up to retry limit', async () => {
    vi.useFakeTimers();
    const log = createLogger();
    const provider = makeProvider({ log });
    await provider.start();

    // Trigger unexpected close — should schedule reconnect
    lastCreatedWs!._triggerClose(1006);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toContain('reconnecting');

    // Advance past first retry (500ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(lastCreatedWs).not.toBeNull();

    // Trigger another close
    lastCreatedWs!._triggerClose(1006);
    expect(log.warn).toHaveBeenCalledTimes(2);

    // Advance past second retry (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    // Trigger third close
    lastCreatedWs!._triggerClose(1006);
    expect(log.warn).toHaveBeenCalledTimes(3);

    // Advance past third retry (2000ms)
    await vi.advanceTimersByTimeAsync(2000);

    // Fourth close — retries exhausted
    lastCreatedWs!._triggerClose(1006);
    expect(log.error).toHaveBeenCalled();
    expect(vi.mocked(log.error).mock.calls.some(
      (c) => typeof c[1] === 'string' && c[1].includes('exhausted'),
    )).toBe(true);

    vi.useRealTimers();
  });

  it('error is logged after retries exhausted', async () => {
    vi.useFakeTimers();
    const log = createLogger();
    const provider = makeProvider({ log });
    await provider.start();

    // Exhaust all 3 retries
    for (let i = 0; i < 3; i++) {
      lastCreatedWs!._triggerClose(1006);
      await vi.advanceTimersByTimeAsync(BASE_BACKOFF_MS * 2 ** i);
    }
    // Final close after all retries
    lastCreatedWs!._triggerClose(1006);

    const errorCalls = vi.mocked(log.error).mock.calls;
    const exhaustedCall = errorCalls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('exhausted reconnect retries'),
    );
    expect(exhaustedCall).toBeDefined();

    vi.useRealTimers();
  });

  it('constructor throws if WebSocket is unavailable and no wsConstructor given', () => {
    const original = globalThis.WebSocket;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = undefined;
      expect(
        () =>
          new DeepgramSttProvider({
            apiKey: 'key',
            sampleRate: 16000,
            log: createLogger(),
          }),
      ).toThrow('Node 22+');
    } finally {
      (globalThis as any).WebSocket = original;
    }
  });
});

// Re-export for the retry test's backoff calculation
const BASE_BACKOFF_MS = 500;
