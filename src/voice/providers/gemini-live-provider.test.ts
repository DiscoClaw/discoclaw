import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LoggerLike } from '../../logging/logger-like.js';
import {
  GeminiLiveProvider,
  type GeminiLiveEvent,
  type GeminiLiveOpts,
} from './gemini-live-provider.js';

// ---------------------------------------------------------------------------
// Mock WebSocket (ws-library style: EventEmitter with readyState)
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    // Auto-open on next microtask so callers can attach handlers
    queueMicrotask(() => this.emit('open'));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  _receiveMessage(data: unknown): void {
    this.emit('message', JSON.stringify(data));
  }

  _triggerClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(''));
  }

  _triggerError(msg = 'test error'): void {
    this.emit('error', new Error(msg));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let lastCreatedWs: MockWebSocket | null = null;

function mockWsFactory(url: string): MockWebSocket {
  const ws = new MockWebSocket(url);
  lastCreatedWs = ws;
  return ws;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const typedWsFactory = mockWsFactory as any;

function makeProvider(
  overrides: Partial<GeminiLiveOpts> = {},
): GeminiLiveProvider {
  return new GeminiLiveProvider({
    apiKey: overrides.apiKey ?? 'test-key',
    log: overrides.log ?? createLogger(),
    wsFactory: typedWsFactory,
    ...overrides,
  });
}

/** Simulate a successful setup by sending setupComplete after connect. */
async function connectWithSetup(
  provider: GeminiLiveProvider,
): Promise<MockWebSocket> {
  const connectPromise = provider.connect();
  // Wait for microtask to open WS and send setup
  await new Promise((r) => setTimeout(r, 5));
  lastCreatedWs!._receiveMessage({ setupComplete: {} });
  await connectPromise;
  return lastCreatedWs!;
}

function collectEvents(provider: GeminiLiveProvider): GeminiLiveEvent[] {
  const events: GeminiLiveEvent[] = [];
  provider.onEvent((e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  lastCreatedWs = null;
});

describe('GeminiLiveProvider', () => {
  // -----------------------------------------------------------------------
  // Connection & setup
  // -----------------------------------------------------------------------

  it('connects with correct URL containing API key', async () => {
    const provider = makeProvider({ apiKey: 'my-api-key' });
    await connectWithSetup(provider);

    expect(lastCreatedWs).not.toBeNull();
    const url = new URL(lastCreatedWs!.url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('generativelanguage.googleapis.com');
    expect(url.searchParams.get('key')).toBe('my-api-key');
  });

  it('sends setup message with model, default config, compression, and activity handling on open', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);

    const setupMsg = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(setupMsg.setup).toBeDefined();
    expect(setupMsg.setup.model).toBe('models/gemini-2.0-flash-live-001');
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setupMsg.setup.generationConfig.contextWindowCompression).toEqual({
      slidingWindow: {},
    });
    expect(setupMsg.setup.realtimeInputConfig).toEqual({
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    });
  });

  it('sends custom model, systemInstruction, and voiceName in setup', async () => {
    const provider = makeProvider({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: 'You are a helpful assistant.',
      voiceName: 'Kore',
      responseModalities: ['AUDIO', 'TEXT'],
    });
    await connectWithSetup(provider);

    const setupMsg = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(setupMsg.setup.model).toBe('models/gemini-2.0-flash-exp');
    expect(setupMsg.setup.systemInstruction).toEqual({
      parts: [{ text: 'You are a helpful assistant.' }],
    });
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO', 'TEXT']);
    expect(setupMsg.setup.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
  });

  it('transitions to open state after setupComplete', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);

    expect(provider.state).toBe('idle');
    await connectWithSetup(provider);
    expect(provider.state).toBe('open');
    expect(events).toContainEqual({ type: 'setup_complete' });
  });

  it('connect is idempotent when already connected', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);
    const ws1 = lastCreatedWs;

    // Second connect should be a no-op
    await provider.connect();
    expect(lastCreatedWs).toBe(ws1);
  });

  // -----------------------------------------------------------------------
  // Sending audio
  // -----------------------------------------------------------------------

  it('sendAudio sends base64-encoded PCM as realtimeInput', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);

    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    provider.sendAudio(pcm);

    // sent[0] is setup, sent[1] is the audio
    const msg = JSON.parse(lastCreatedWs!.sent[1] as string);
    expect(msg.realtimeInput).toBeDefined();
    expect(msg.realtimeInput.media).toBeDefined();
    expect(msg.realtimeInput.media.mimeType).toBe('audio/pcm;rate=16000');
    expect(msg.realtimeInput.media.data).toBe(pcm.toString('base64'));
  });

  it('sendAudio throws when not connected', () => {
    const provider = makeProvider();
    expect(() => provider.sendAudio(Buffer.from([1]))).toThrow(
      'Cannot sendAudio before connect()',
    );
  });

  // -----------------------------------------------------------------------
  // Sending text
  // -----------------------------------------------------------------------

  it('sendText sends clientContent message', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);

    provider.sendText('Hello there');

    const msg = JSON.parse(lastCreatedWs!.sent[1] as string);
    expect(msg.clientContent).toBeDefined();
    expect(msg.clientContent.turns).toEqual([
      { role: 'user', parts: [{ text: 'Hello there' }] },
    ]);
    expect(msg.clientContent.turnComplete).toBe(true);
  });

  it('sendText throws when not connected', () => {
    const provider = makeProvider();
    expect(() => provider.sendText('hello')).toThrow(
      'Cannot sendText before connect()',
    );
  });

  // -----------------------------------------------------------------------
  // Receiving events
  // -----------------------------------------------------------------------

  it('emits audio events from serverContent with inlineData', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    const audioBytes = Buffer.from([10, 20, 30]);
    lastCreatedWs!._receiveMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: audioBytes.toString('base64') } }],
        },
      },
    });

    const audioEvents = events.filter((e) => e.type === 'audio');
    expect(audioEvents).toHaveLength(1);
    expect([...(audioEvents[0] as { type: 'audio'; data: Buffer }).data]).toEqual([10, 20, 30]);
  });

  it('emits text events from serverContent', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    lastCreatedWs!._receiveMessage({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Hello world' }],
        },
      },
    });

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { type: 'text'; text: string }).text).toBe('Hello world');
  });

  it('emits turn_complete event', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    lastCreatedWs!._receiveMessage({
      serverContent: { turnComplete: true },
    });

    expect(events).toContainEqual({ type: 'turn_complete' });
  });

  it('emits interrupted event', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    lastCreatedWs!._receiveMessage({
      serverContent: { interrupted: true },
    });

    expect(events).toContainEqual({ type: 'interrupted' });
  });

  it('emits error event from server error message', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    lastCreatedWs!._receiveMessage({
      error: { message: 'Rate limit exceeded', code: 429 },
    });

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { type: 'error'; error: string }).error).toBe('Rate limit exceeded');
  });

  it('handles mixed audio and text parts in a single message', async () => {
    const provider = makeProvider();
    const events = collectEvents(provider);
    await connectWithSetup(provider);

    const audioBytes = Buffer.from([1, 2]);
    lastCreatedWs!._receiveMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: audioBytes.toString('base64') } },
            { text: 'transcript' },
          ],
        },
      },
    });

    const audioEvents = events.filter((e) => e.type === 'audio');
    const textEvents = events.filter((e) => e.type === 'text');
    expect(audioEvents).toHaveLength(1);
    expect(textEvents).toHaveLength(1);
  });

  it('logs unrecognized message shapes', async () => {
    const log = createLogger();
    const provider = makeProvider({ log });
    await connectWithSetup(provider);

    lastCreatedWs!._receiveMessage({ unknownField: true });

    expect(log.warn).toHaveBeenCalledWith(
      { keys: 'unknownField' },
      'Gemini Live: unrecognized message',
    );
  });

  // -----------------------------------------------------------------------
  // Disconnect
  // -----------------------------------------------------------------------

  it('disconnect closes the WebSocket and transitions to stopped', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);
    const ws = lastCreatedWs!;

    await provider.disconnect();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(provider.state).toBe('stopped');
  });

  it('double disconnect is idempotent', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);

    await provider.disconnect();
    await provider.disconnect(); // should not throw
    expect(provider.state).toBe('stopped');
  });

  it('disconnect during connect rejects the connect promise', async () => {
    const provider = makeProvider();
    const connectPromise = provider.connect();
    // Wait for WS to open and enter setup state
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.state).toBe('setup');

    // Disconnect while setup is in progress
    await provider.disconnect();

    // The connect promise should reject, not hang
    await expect(connectPromise).rejects.toThrow('disconnect() called');
    expect(provider.state).toBe('stopped');
  });

  it('sendAudio after disconnect throws', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);
    await provider.disconnect();

    expect(() => provider.sendAudio(Buffer.from([1]))).toThrow(
      'Cannot sendAudio before connect()',
    );
  });

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  it('resets retry counter after successful reconnect so long-lived sessions survive', async () => {
    vi.useFakeTimers();
    const log = createLogger();
    const provider = makeProvider({ log });

    // Initial connect
    const connectP = provider.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastCreatedWs!._receiveMessage({ setupComplete: {} });
    await connectP;

    // Simulate 5 successive drop-then-reconnect cycles — each should succeed
    // because the retry counter resets after each successful reconnect.
    for (let i = 0; i < 5; i++) {
      lastCreatedWs!._triggerClose(1006);
      // First retry delay is always 500ms (retryCount goes 0→1, backoff = 500 * 2^0)
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      lastCreatedWs!._receiveMessage({ setupComplete: {} });
      expect(provider.state).toBe('open');
    }

    // All 5 reconnects succeeded — provider is still alive
    expect(log.error).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('exhausts retries when consecutive reconnect attempts fail', async () => {
    vi.useFakeTimers();
    const log = createLogger();

    // Factory that produces websockets which open but never complete setup
    let closeCount = 0;
    function failingWsFactory(url: string): MockWebSocket {
      const ws = new MockWebSocket(url);
      lastCreatedWs = ws;
      // After the first successful connect, make all subsequent WS connections
      // close immediately after open (simulating persistent failure)
      if (closeCount > 0) {
        const origEmit = ws.emit.bind(ws);
        ws.emit = function (event: string, ...args: unknown[]) {
          origEmit(event, ...args);
          if (event === 'open') {
            queueMicrotask(() => ws._triggerClose(1006));
          }
          return true;
        } as typeof ws.emit;
      }
      return ws;
    }

    const provider = new GeminiLiveProvider({
      apiKey: 'key',
      log,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsFactory: failingWsFactory as any,
    });

    // Initial connect succeeds
    const connectP = provider.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastCreatedWs!._receiveMessage({ setupComplete: {} });
    await connectP;

    // Trigger first unexpected close — all subsequent reconnects will fail
    closeCount = 1;
    lastCreatedWs!._triggerClose(1006);

    // Exhaust all 3 retries (500ms, 1000ms, 2000ms)
    for (const delay of [500, 1000, 2000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(provider.state).toBe('stopped');
    expect(
      vi.mocked(log.error).mock.calls.some(
        (c) => typeof c[1] === 'string' && c[1].includes('exhausted'),
      ),
    ).toBe(true);

    vi.useRealTimers();
  });

  it('does not reconnect after explicit disconnect', async () => {
    vi.useFakeTimers();
    const log = createLogger();
    const provider = makeProvider({ log });

    const connectP = provider.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastCreatedWs!._receiveMessage({ setupComplete: {} });
    await connectP;

    await provider.disconnect();

    // Trigger close — should be a no-op since state is 'stopped'
    lastCreatedWs!._triggerClose(1006);

    await vi.advanceTimersByTimeAsync(5000);
    expect(log.warn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Session resume handle
  // -----------------------------------------------------------------------

  it('captures session resume handle from server and includes it on reconnect', async () => {
    vi.useFakeTimers();
    const provider = makeProvider();

    // Initial connect
    const connectP = provider.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastCreatedWs!._receiveMessage({ setupComplete: {} });
    await connectP;

    // Server sends a session resumption update
    lastCreatedWs!._receiveMessage({
      sessionResumptionUpdate: { newHandle: 'resume-token-abc' },
    });

    // Trigger unexpected close — should reconnect with resume handle
    lastCreatedWs!._triggerClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);

    // Check the setup message on reconnect includes the resume handle
    const reconnectSetup = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(reconnectSetup.setup.sessionResumption).toEqual({
      handle: 'resume-token-abc',
    });

    lastCreatedWs!._receiveMessage({ setupComplete: {} });
    vi.useRealTimers();
  });

  it('does not include sessionResumption on first connect', async () => {
    const provider = makeProvider();
    await connectWithSetup(provider);

    const setupMsg = JSON.parse(lastCreatedWs!.sent[0] as string);
    expect(setupMsg.setup.sessionResumption).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Connection failure
  // -----------------------------------------------------------------------

  it('rejects connect() if WebSocket closes during setup', async () => {
    function failWsFactory(url: string): MockWebSocket {
      const ws = new MockWebSocket(url);
      // Override auto-open: open then immediately close before setup completes
      const origEmit = ws.emit.bind(ws);
      ws.emit = function (event: string, ...args: unknown[]) {
        origEmit(event, ...args);
        if (event === 'open') {
          queueMicrotask(() => ws._triggerClose(1006));
        }
        return true;
      } as typeof ws.emit;
      lastCreatedWs = ws;
      return ws;
    }

    const provider = new GeminiLiveProvider({
      apiKey: 'key',
      log: createLogger(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsFactory: failWsFactory as any,
    });

    await expect(provider.connect()).rejects.toThrow('closed during connect');
  });

  // -----------------------------------------------------------------------
  // WebSocket error handling
  // -----------------------------------------------------------------------

  it('logs WebSocket errors without crashing', async () => {
    const log = createLogger();
    const provider = makeProvider({ log });
    await connectWithSetup(provider);

    lastCreatedWs!._triggerError('connection reset');

    expect(log.error).toHaveBeenCalledWith(
      { err: 'connection reset' },
      'Gemini Live WebSocket error',
    );
  });

  it('handles malformed JSON messages gracefully', async () => {
    const log = createLogger();
    const provider = makeProvider({ log });
    await connectWithSetup(provider);

    // Send raw invalid JSON
    lastCreatedWs!.emit('message', 'not json at all');

    expect(log.error).toHaveBeenCalled();
    const errorCall = vi.mocked(log.error).mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Failed to parse'),
    );
    expect(errorCall).toBeDefined();
  });
});
