import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { LoggerLike } from '../../logging/logger-like.js';
import type { GeminiFunctionCall, GeminiLiveEvent } from './gemini-live-types.js';
import { GeminiLiveResponder, type GeminiLiveResponderOpts } from './gemini-live-responder.js';

// ---------------------------------------------------------------------------
// Mock @discordjs/voice
// ---------------------------------------------------------------------------

vi.mock('@discordjs/voice', () => ({
  AudioPlayerStatus: {
    Idle: 'idle',
    Playing: 'playing',
    Buffering: 'buffering',
    Paused: 'paused',
    AutoPaused: 'autopaused',
  },
  StreamType: {
    Raw: 'raw',
    Arbitrary: 'arbitrary',
    OggOpus: 'ogg/opus',
    Opus: 'opus',
    WebmOpus: 'webm/opus',
  },
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(() => ({ type: 'mock-resource' })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockPlayer() {
  const emitter = new EventEmitter();
  const player = {
    state: { status: 'idle' } as { status: string },
    play: vi.fn(() => {
      const old = { ...player.state };
      player.state = { status: 'playing' };
      emitter.emit('stateChange', old, player.state);
    }),
    stop: vi.fn(() => {
      if (player.state.status !== 'idle') {
        const old = { ...player.state };
        player.state = { status: 'idle' };
        emitter.emit('stateChange', old, player.state);
      }
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return player;
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.removeListener(event, listener);
      return player;
    }),
    _emitter: emitter,
  };
  return player;
}

function createMockConnection() {
  return {
    subscribe: vi.fn(),
  } as unknown as import('@discordjs/voice').VoiceConnection;
}

/** Mock provider that captures the onEvent listener for test injection. */
function createMockProvider() {
  let listener: ((event: GeminiLiveEvent) => void) | null = null;
  return {
    onEvent: vi.fn((cb: (event: GeminiLiveEvent) => void) => {
      listener = cb;
    }),
    /** Inject a test event into the registered listener. */
    _inject(event: GeminiLiveEvent): void {
      listener?.(event);
    },
  };
}

type ResponderKit = {
  responder: GeminiLiveResponder;
  player: ReturnType<typeof createMockPlayer>;
  log: LoggerLike;
  connection: import('@discordjs/voice').VoiceConnection;
  provider: ReturnType<typeof createMockProvider>;
};

function createResponder(overrides: Partial<GeminiLiveResponderOpts> = {}): ResponderKit {
  const player = createMockPlayer();
  const log = createLogger();
  const connection = createMockConnection();
  const provider = createMockProvider();

  const responder = new GeminiLiveResponder({
    log,
    connection,
    provider: provider as unknown as import('./gemini-live-provider.js').GeminiLiveProvider,
    createPlayer: () => player as unknown as import('@discordjs/voice').AudioPlayer,
    ...overrides,
  });

  return { responder, player, log, connection, provider };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GeminiLiveResponder', () => {
  // -----------------------------------------------------------------------
  // start()
  // -----------------------------------------------------------------------

  describe('start', () => {
    it('subscribes the player to the connection', () => {
      const { responder, connection, player } = createResponder();
      responder.start();
      expect(connection.subscribe).toHaveBeenCalledWith(player);
    });

    it('registers as the provider event listener', () => {
      const { responder, provider } = createResponder();
      responder.start();
      expect(provider.onEvent).toHaveBeenCalledWith(expect.any(Function));
    });

    it('registers error and stateChange handlers on the player', () => {
      const { responder, player } = createResponder();
      responder.start();
      expect(player.on).toHaveBeenCalledWith('stateChange', expect.any(Function));
      expect(player.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('is idempotent — second call is a no-op', () => {
      const { responder, connection } = createResponder();
      responder.start();
      responder.start();
      expect(connection.subscribe).toHaveBeenCalledTimes(1);
    });

    it('logs player errors', () => {
      const { responder, player, log } = createResponder();
      responder.start();
      const err = new Error('playback failed');
      player._emitter.emit('error', err);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'gemini-live-responder: audio player error',
      );
    });
  });

  // -----------------------------------------------------------------------
  // audio events
  // -----------------------------------------------------------------------

  describe('audio events', () => {
    it('creates a stream and starts playback on first audio chunk', () => {
      const { responder, player, provider, log } = createResponder();
      responder.start();

      // Send an audio event (4 bytes = 2 samples at 24kHz mono)
      const pcm = Buffer.alloc(4, 0x42);
      provider._inject({ type: 'audio', data: pcm });

      expect(player.play).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        {},
        'gemini-live-responder: streaming playback started',
      );
    });

    it('writes upsampled audio to the stream on subsequent chunks', () => {
      const { responder, player, provider } = createResponder();
      responder.start();

      const chunk1 = Buffer.alloc(4, 0x01);
      const chunk2 = Buffer.alloc(4, 0x02);
      provider._inject({ type: 'audio', data: chunk1 });
      provider._inject({ type: 'audio', data: chunk2 });

      // play() called only once — stream reused within same turn
      expect(player.play).toHaveBeenCalledTimes(1);
    });

    it('upsamples 24kHz mono audio to 48kHz stereo for Discord', () => {
      const { responder, provider } = createResponder();
      responder.start();

      // 2 samples at 24kHz mono = 4 bytes -> 4 frames at 48kHz stereo = 16 bytes
      const input = Buffer.alloc(4);
      input.writeInt16LE(1000, 0);
      input.writeInt16LE(2000, 2);

      // Spy on PassThrough.write to capture what's written
      const writeSpy = vi.spyOn(PassThrough.prototype, 'write');
      provider._inject({ type: 'audio', data: input });

      expect(writeSpy).toHaveBeenCalled();
      const written = writeSpy.mock.calls[0][0] as Buffer;
      expect(written.length).toBe(16); // 4 frames * 4 bytes each
      writeSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // text events
  // -----------------------------------------------------------------------

  describe('text events', () => {
    it('accumulates transcript text', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'Hello ' });
      provider._inject({ type: 'text', text: 'world' });
      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).toHaveBeenCalledWith('Hello world');
    });
  });

  // -----------------------------------------------------------------------
  // interrupted events
  // -----------------------------------------------------------------------

  describe('interrupted', () => {
    it('destroys the stream and stops the player immediately', () => {
      const { responder, player, provider, log } = createResponder();
      responder.start();

      // Start an audio stream
      provider._inject({ type: 'audio', data: Buffer.alloc(4, 0x42) });
      expect(player.play).toHaveBeenCalledTimes(1);

      // Interrupt
      provider._inject({ type: 'interrupted' });

      expect(player.stop).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        {},
        'gemini-live-responder: interrupted — stopping playback',
      );
    });

    it('clears accumulated transcript on interrupt', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'partial transcript' });
      provider._inject({ type: 'interrupted' });
      provider._inject({ type: 'turn_complete' });

      // The interrupted event should have cleared the transcript
      expect(onBotResponse).not.toHaveBeenCalled();
    });

    it('is safe when no stream is active', () => {
      const { responder, provider } = createResponder();
      responder.start();

      // Should not throw
      provider._inject({ type: 'interrupted' });
    });
  });

  // -----------------------------------------------------------------------
  // turn_complete events
  // -----------------------------------------------------------------------

  describe('turn_complete', () => {
    it('ends the stream gracefully', () => {
      const { responder, provider } = createResponder();
      responder.start();

      // Start an audio stream
      provider._inject({ type: 'audio', data: Buffer.alloc(4, 0x42) });

      // Spy on PassThrough.end
      const endSpy = vi.spyOn(PassThrough.prototype, 'end');
      provider._inject({ type: 'turn_complete' });

      expect(endSpy).toHaveBeenCalled();
      endSpy.mockRestore();
    });

    it('fires onBotResponse with accumulated transcript', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'Hello from Gemini' });
      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).toHaveBeenCalledWith('Hello from Gemini');
    });

    it('does not fire onBotResponse when transcript is empty', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).not.toHaveBeenCalled();
    });

    it('resets transcript after firing callback', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'first turn' });
      provider._inject({ type: 'turn_complete' });
      provider._inject({ type: 'text', text: 'second turn' });
      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).toHaveBeenCalledTimes(2);
      expect(onBotResponse).toHaveBeenNthCalledWith(1, 'first turn');
      expect(onBotResponse).toHaveBeenNthCalledWith(2, 'second turn');
    });

    it('does not crash when onBotResponse throws', () => {
      const onBotResponse = vi.fn(() => { throw new Error('callback error'); });
      const { responder, provider, log } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'text' });
      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'gemini-live-responder: onBotResponse callback error',
      );
    });

    it('creates a fresh stream for the next turn after turn_complete', () => {
      const { responder, player, provider } = createResponder();
      responder.start();

      // First turn
      provider._inject({ type: 'audio', data: Buffer.alloc(4, 0x01) });
      provider._inject({ type: 'turn_complete' });

      // Second turn — should create a new stream
      provider._inject({ type: 'audio', data: Buffer.alloc(4, 0x02) });

      expect(player.play).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // isPlaying
  // -----------------------------------------------------------------------

  describe('isPlaying', () => {
    it('returns false before start', () => {
      const { responder } = createResponder();
      expect(responder.isPlaying).toBe(false);
    });

    it('returns false when idle', () => {
      const { responder, player } = createResponder();
      responder.start();
      player.state = { status: 'idle' };
      expect(responder.isPlaying).toBe(false);
    });

    it('returns true when playing', () => {
      const { responder, player } = createResponder();
      responder.start();
      player.state = { status: 'playing' };
      expect(responder.isPlaying).toBe(true);
    });

    it('returns true when buffering', () => {
      const { responder, player } = createResponder();
      responder.start();
      player.state = { status: 'buffering' };
      expect(responder.isPlaying).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // stop / destroy
  // -----------------------------------------------------------------------

  describe('stop', () => {
    it('destroys active stream and stops player', () => {
      const { responder, player, provider } = createResponder();
      responder.start();

      provider._inject({ type: 'audio', data: Buffer.alloc(4, 0x42) });
      responder.stop();

      expect(player.stop).toHaveBeenCalled();
    });

    it('clears transcript', () => {
      const onBotResponse = vi.fn();
      const { responder, provider } = createResponder({ onBotResponse });
      responder.start();

      provider._inject({ type: 'text', text: 'partial' });
      responder.stop();
      provider._inject({ type: 'turn_complete' });

      expect(onBotResponse).not.toHaveBeenCalled();
    });

    it('is safe when not started', () => {
      const { responder } = createResponder();
      responder.stop(); // should not throw
    });
  });

  describe('destroy', () => {
    it('calls stop and nullifies the player', () => {
      const { responder, player } = createResponder();
      responder.start();
      responder.destroy();

      expect(player.stop).toHaveBeenCalled();
      expect(responder.isPlaying).toBe(false);
    });

    it('allows start to be called again after destroy', () => {
      const { responder, connection } = createResponder();
      responder.start();
      responder.destroy();
      responder.start();
      expect(connection.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // tool_call events
  // -----------------------------------------------------------------------

  describe('tool_call events', () => {
    it('forwards tool_call events to onToolCall callback', () => {
      const onToolCall = vi.fn();
      const { responder, provider } = createResponder({ onToolCall });
      responder.start();

      const calls: GeminiFunctionCall[] = [
        { id: 'fc-1', name: 'web_search', args: { query: 'hello' } },
      ];
      provider._inject({ type: 'tool_call', functionCalls: calls });

      expect(onToolCall).toHaveBeenCalledWith(calls);
    });

    it('forwards multiple function calls in a single event', () => {
      const onToolCall = vi.fn();
      const { responder, provider } = createResponder({ onToolCall });
      responder.start();

      const calls: GeminiFunctionCall[] = [
        { id: 'fc-1', name: 'web_search', args: { query: 'hello' } },
        { id: 'fc-2', name: 'read_file', args: { file_path: '/tmp/x' } },
      ];
      provider._inject({ type: 'tool_call', functionCalls: calls });

      expect(onToolCall).toHaveBeenCalledWith(calls);
      expect(onToolCall.mock.calls[0][0]).toHaveLength(2);
    });

    it('logs tool call receipt', () => {
      const onToolCall = vi.fn();
      const { responder, provider, log } = createResponder({ onToolCall });
      responder.start();

      provider._inject({
        type: 'tool_call',
        functionCalls: [{ id: 'fc-1', name: 'bash', args: { command: 'ls' } }],
      });

      expect(log.info).toHaveBeenCalledWith(
        { count: 1, names: 'bash' },
        'gemini-live-responder: tool call received',
      );
    });

    it('does not crash when onToolCall is not provided', () => {
      const { responder, provider } = createResponder();
      responder.start();

      // Should not throw
      provider._inject({
        type: 'tool_call',
        functionCalls: [{ id: 'fc-1', name: 'bash', args: {} }],
      });
    });

    it('does not crash when onToolCall throws', () => {
      const onToolCall = vi.fn(() => { throw new Error('callback error'); });
      const { responder, provider, log } = createResponder({ onToolCall });
      responder.start();

      provider._inject({
        type: 'tool_call',
        functionCalls: [{ id: 'fc-1', name: 'bash', args: {} }],
      });

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'gemini-live-responder: onToolCall callback error',
      );
    });
  });

  // -----------------------------------------------------------------------
  // unhandled event types
  // -----------------------------------------------------------------------

  describe('unhandled events', () => {
    it('ignores setup_complete events without error', () => {
      const { responder, provider } = createResponder();
      responder.start();
      provider._inject({ type: 'setup_complete' });
      // No crash, no log — just silently ignored
    });

    it('ignores error events without error', () => {
      const { responder, provider } = createResponder();
      responder.start();
      provider._inject({ type: 'error', error: 'some error' });
      // No crash — error handling is the provider's responsibility
    });
  });
});
