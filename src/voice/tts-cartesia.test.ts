import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame } from './types.js';
import { CartesiaTtsProvider } from './tts-cartesia.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventHandler = (event: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
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

  // Test helpers — sends audio as JSON with base64 (matching real Cartesia API)
  _receiveAudio(data: number[]): void {
    const b64 = Buffer.from(data).toString('base64');
    this.onmessage?.({ data: JSON.stringify({ type: 'chunk', data: b64 }) } as unknown);
  }

  _receiveJson(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) } as unknown);
  }

  _triggerClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as unknown);
  }

  _triggerError(): void {
    this.onerror?.({ type: 'error' } as unknown);
  }
}

// Make global WebSocket constants available for readyState checks
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

function makeProvider(
  overrides: Partial<{
    apiKey: string;
    voiceId: string;
    modelId: string;
    sampleRate: number;
    log: LoggerLike;
  }> = {},
) {
  return new CartesiaTtsProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    voiceId: overrides.voiceId,
    modelId: overrides.modelId,
    sampleRate: overrides.sampleRate,
    log: overrides.log ?? createLogger(),
    wsConstructor: WsConstructor,
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
  lastCreatedWs = null;
});

describe('CartesiaTtsProvider', () => {
  it('constructs correct WebSocket URL with auth params', async () => {
    const provider = makeProvider({ apiKey: 'my-api-key' });
    const iter = provider.synthesize('hello');

    // Start consuming to trigger WebSocket creation
    const framePromise = collectFrames(iter);

    // Wait for microtask to open WS
    await new Promise((r) => setTimeout(r, 10));

    expect(lastCreatedWs).not.toBeNull();
    const url = new URL(lastCreatedWs!.url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.cartesia.ai');
    expect(url.pathname).toBe('/tts/websocket');
    expect(url.searchParams.get('api_key')).toBe('my-api-key');
    expect(url.searchParams.get('cartesia_version')).toBe('2024-06-10');

    // Verify the synthesis request JSON
    expect(lastCreatedWs!.sent).toHaveLength(1);
    const req = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(req.model_id).toBe('sonic-3');
    expect(req.transcript).toBe('hello');
    expect(req.output_format.container).toBe('raw');
    expect(req.output_format.encoding).toBe('pcm_s16le');

    // End the stream cleanly
    lastCreatedWs!._receiveJson({ done: true });
    await framePromise;
  });

  it('streams multiple audio frames in correct order', async () => {
    const provider = makeProvider();
    const iter = provider.synthesize('hello world');
    const framePromise = collectFrames(iter);

    await new Promise((r) => setTimeout(r, 10));

    // Send 3 audio frames
    lastCreatedWs!._receiveAudio([1, 2, 3]);
    lastCreatedWs!._receiveAudio([4, 5, 6]);
    lastCreatedWs!._receiveAudio([7, 8, 9]);
    lastCreatedWs!._receiveJson({ done: true });

    const frames = await framePromise;
    expect(frames).toHaveLength(3);
    expect([...frames[0]!.buffer]).toEqual([1, 2, 3]);
    expect([...frames[1]!.buffer]).toEqual([4, 5, 6]);
    expect([...frames[2]!.buffer]).toEqual([7, 8, 9]);

    // Verify sample rate and channels on each frame
    for (const frame of frames) {
      expect(frame.sampleRate).toBe(24000);
      expect(frame.channels).toBe(1);
    }
  });

  it('connection failure before any frames throws', async () => {
    // Use a factory that triggers close instead of open (no auto-open)
    function failWsFactory(url: string | URL) {
      const ws = {
        url: String(url),
        readyState: 0,
        onopen: null as WsEventHandler | null,
        onmessage: null as WsEventHandler | null,
        onerror: null as WsEventHandler | null,
        onclose: null as WsEventHandler | null,
        sent: [] as unknown[],
        send: vi.fn(),
        close: vi.fn(),
      };
      queueMicrotask(() => {
        ws.readyState = 3;
        ws.onclose?.({ code: 1006 });
      });
      lastCreatedWs = ws as unknown as MockWebSocket;
      return ws;
    }

    const provider = new CartesiaTtsProvider({
      apiKey: 'key',
      log: createLogger(),
      wsConstructor: failWsFactory as unknown as new (url: string | URL) => WebSocket,
    });

    await expect(collectFrames(provider.synthesize('test'))).rejects.toThrow(
      'closed before open',
    );
  });

  it('mid-stream disconnect throws without retrying', async () => {
    const provider = makeProvider();
    const iter = provider.synthesize('hello');
    const framePromise = collectFrames(iter);

    await new Promise((r) => setTimeout(r, 10));

    // Yield one frame, then disconnect
    lastCreatedWs!._receiveAudio([1, 2, 3]);

    // Small delay to ensure the frame is consumed
    await new Promise((r) => setTimeout(r, 5));

    lastCreatedWs!._triggerClose(1006);

    await expect(framePromise).rejects.toThrow('mid-stream');
  });

  it('empty text yields no frames', async () => {
    const provider = makeProvider();

    const frames = await collectFrames(provider.synthesize(''));
    expect(frames).toHaveLength(0);

    const frames2 = await collectFrames(provider.synthesize('   '));
    expect(frames2).toHaveLength(0);

    // No WebSocket should have been created
    expect(lastCreatedWs).toBeNull();
  });

  it('cleanup on early iterator break closes socket', async () => {
    const provider = makeProvider();
    const iter = provider.synthesize('hello')[Symbol.asyncIterator]();

    // Start pulling — triggers WS creation + waitForOpen
    const nextPromise = iter.next();

    // Let the microtask fire to open WS
    await new Promise((r) => setTimeout(r, 10));

    // Now send audio data so the first next() resolves
    lastCreatedWs!._receiveAudio([1, 2, 3]);
    const first = await nextPromise;
    expect(first.done).toBe(false);
    expect([...first.value!.buffer]).toEqual([1, 2, 3]);

    // Break early via return
    await iter.return!(undefined);

    // WebSocket should be closed
    expect(lastCreatedWs!.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('constructor throws when globalThis.WebSocket unavailable and no wsConstructor', () => {
    const original = globalThis.WebSocket;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = undefined;
      expect(
        () =>
          new CartesiaTtsProvider({
            apiKey: 'key',
            log: createLogger(),
          }),
      ).toThrow('Node 22+');
    } finally {
      (globalThis as any).WebSocket = original;
    }
  });

  it('uses custom voiceId, modelId, and sampleRate', async () => {
    const provider = makeProvider({
      voiceId: 'custom-voice',
      modelId: 'sonic-4',
      sampleRate: 48000,
    });
    const iter = provider.synthesize('test');
    const framePromise = collectFrames(iter);

    await new Promise((r) => setTimeout(r, 10));

    const req = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(req.model_id).toBe('sonic-4');
    expect(req.voice.id).toBe('custom-voice');
    expect(req.output_format.sample_rate).toBe(48000);

    // Send a frame and complete
    lastCreatedWs!._receiveAudio([10, 20]);
    lastCreatedWs!._receiveJson({ done: true });

    const frames = await framePromise;
    expect(frames[0]!.sampleRate).toBe(48000);
  });
});
