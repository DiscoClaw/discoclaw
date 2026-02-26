import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TtsProvider } from './types.js';
import { VoiceResponder, upsampleToDiscord, type VoiceResponderOpts } from './voice-responder.js';

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
      // Auto-transition to idle after a tick to simulate playback completion
      setImmediate(() => {
        if (player.state.status === 'playing') {
          const oldPlaying = { ...player.state };
          player.state = { status: 'idle' };
          emitter.emit('stateChange', oldPlaying, player.state);
        }
      });
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

function createMockTts(frames?: AudioFrame[]): TtsProvider {
  const defaultFrames: AudioFrame[] = [
    { buffer: Buffer.alloc(480, 0x42), sampleRate: 24000, channels: 1 },
  ];
  return {
    synthesize: vi.fn(async function* (_text: string) {
      for (const frame of frames ?? defaultFrames) {
        yield frame;
      }
    }),
  };
}

function createMockConnection() {
  return {
    subscribe: vi.fn(),
  } as unknown as import('@discordjs/voice').VoiceConnection;
}

type ResponderKit = {
  responder: VoiceResponder;
  player: ReturnType<typeof createMockPlayer>;
  log: LoggerLike;
  tts: TtsProvider;
  connection: import('@discordjs/voice').VoiceConnection;
  invokeAi: ReturnType<typeof vi.fn<(text: string) => Promise<string>>>;
};

function createResponder(overrides: Partial<VoiceResponderOpts> = {}): ResponderKit {
  const player = createMockPlayer();
  const log = createLogger();
  const tts = createMockTts();
  const connection = createMockConnection();
  const invokeAi = vi.fn(async () => 'AI says hello');

  const responder = new VoiceResponder({
    log,
    tts,
    connection,
    invokeAi,
    createPlayer: () => player as unknown as import('@discordjs/voice').AudioPlayer,
    ...overrides,
  });

  return { responder, player, log, tts, connection, invokeAi };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VoiceResponder', () => {
  describe('constructor', () => {
    it('subscribes the player to the connection', () => {
      const { connection, player } = createResponder();
      expect(connection.subscribe).toHaveBeenCalledWith(player);
    });

    it('registers an error handler on the player', () => {
      const { player } = createResponder();
      expect(player.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('logs player errors', () => {
      const { player, log } = createResponder();
      const err = new Error('playback failed');
      player._emitter.emit('error', err);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'voice-responder: audio player error',
      );
    });
  });

  describe('handleTranscription', () => {
    it('invokes AI, synthesizes TTS, and plays audio', async () => {
      const { responder, invokeAi, tts, player, log } = createResponder();

      await responder.handleTranscription('hello bot');

      expect(invokeAi).toHaveBeenCalledWith('hello bot');
      expect(tts.synthesize).toHaveBeenCalledWith('AI says hello');
      expect(player.play).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello bot' }),
        'voice-responder: invoking AI',
      );
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bufferSize: expect.any(Number) }),
        'voice-responder: playback started',
      );
      expect(log.info).toHaveBeenCalledWith(
        {},
        'voice-responder: playback complete',
      );
    });

    it('skips empty text', async () => {
      const { responder, invokeAi } = createResponder();

      await responder.handleTranscription('');
      await responder.handleTranscription('   ');

      expect(invokeAi).not.toHaveBeenCalled();
    });

    it('skips TTS when AI response is empty', async () => {
      const invokeAi = vi.fn(async () => '');
      const { responder, tts, player, log } = createResponder({ invokeAi });

      await responder.handleTranscription('hello');

      expect(invokeAi).toHaveBeenCalled();
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        {},
        'voice-responder: empty AI response, skipping TTS',
      );
    });

    it('skips TTS when AI response is whitespace-only', async () => {
      const invokeAi = vi.fn(async () => '   \n  ');
      const { responder, tts, player } = createResponder({ invokeAi });

      await responder.handleTranscription('hello');

      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
    });

    it('logs error when AI invoke throws', async () => {
      const invokeAi = vi.fn(async () => {
        throw new Error('AI error');
      });
      const { responder, log, player } = createResponder({ invokeAi });

      await responder.handleTranscription('hello');

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'voice-responder: error in response pipeline',
      );
      expect(player.play).not.toHaveBeenCalled();
    });

    it('logs error when TTS throws', async () => {
      const tts: TtsProvider = {
        synthesize: vi.fn(async function* () {
          throw new Error('TTS error');
        }),
      };
      const { responder, log, player } = createResponder({ tts });

      await responder.handleTranscription('hello');

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'voice-responder: error in response pipeline',
      );
      expect(player.play).not.toHaveBeenCalled();
    });

    it('sets isProcessing during pipeline execution', async () => {
      let resolveAi!: (value: string) => void;
      const invokeAi = vi.fn(
        () => new Promise<string>((r) => { resolveAi = r; }),
      );
      const { responder } = createResponder({ invokeAi });

      expect(responder.isProcessing).toBe(false);

      const promise = responder.handleTranscription('hello');
      expect(responder.isProcessing).toBe(true);

      resolveAi('response');
      await promise;

      expect(responder.isProcessing).toBe(false);
    });

    it('interrupts previous pipeline when new transcription arrives', async () => {
      let resolveFirst!: (value: string) => void;
      let callCount = 0;
      const invokeAi = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<string>((r) => { resolveFirst = r; });
        }
        return Promise.resolve('second response');
      });
      const { responder, tts } = createResponder({ invokeAi });

      // Start first pipeline (will hang on AI invoke)
      const first = responder.handleTranscription('first');

      // Start second pipeline (interrupts first via generation counter)
      const second = responder.handleTranscription('second');

      // Resolve the first AI call — it should be abandoned
      resolveFirst('first response');

      await Promise.all([first, second]);

      // Only the second transcription should have triggered TTS
      expect(tts.synthesize).toHaveBeenCalledTimes(1);
      expect(tts.synthesize).toHaveBeenCalledWith('second response');
    });

    it('handles multiple TTS frames', async () => {
      const frames: AudioFrame[] = [
        { buffer: Buffer.alloc(100, 0x01), sampleRate: 24000, channels: 1 },
        { buffer: Buffer.alloc(100, 0x02), sampleRate: 24000, channels: 1 },
        { buffer: Buffer.alloc(100, 0x03), sampleRate: 24000, channels: 1 },
      ];
      const tts = createMockTts(frames);
      const { responder, player } = createResponder({ tts });

      await responder.handleTranscription('hello');

      expect(player.play).toHaveBeenCalled();
    });

    it('skips playback when TTS yields no frames', async () => {
      const tts = createMockTts([]);
      const { responder, player } = createResponder({ tts });

      await responder.handleTranscription('hello');

      expect(player.play).not.toHaveBeenCalled();
    });
  });

  describe('onBotResponse', () => {
    it('fires with the AI response text after invokeAi resolves', async () => {
      const onBotResponse = vi.fn();
      const { responder } = createResponder({ onBotResponse });

      await responder.handleTranscription('hello');

      expect(onBotResponse).toHaveBeenCalledWith('AI says hello');
    });

    it('does not fire for empty AI responses', async () => {
      const onBotResponse = vi.fn();
      const invokeAi = vi.fn(async () => '');
      const { responder } = createResponder({ invokeAi, onBotResponse });

      await responder.handleTranscription('hello');

      expect(onBotResponse).not.toHaveBeenCalled();
    });

    it('does not fire when generation is superseded', async () => {
      const onBotResponse = vi.fn();
      let resolveFirst!: (value: string) => void;
      let callCount = 0;
      const invokeAi = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<string>((r) => { resolveFirst = r; });
        }
        return Promise.resolve('second response');
      });
      const { responder } = createResponder({ invokeAi, onBotResponse });

      const first = responder.handleTranscription('first');
      const second = responder.handleTranscription('second');

      resolveFirst('first response');
      await Promise.all([first, second]);

      // Only the second invocation should have triggered the callback
      expect(onBotResponse).toHaveBeenCalledTimes(1);
      expect(onBotResponse).toHaveBeenCalledWith('second response');
    });

    it('does not prevent TTS playback when callback throws', async () => {
      const onBotResponse = vi.fn(() => { throw new Error('callback error'); });
      const { responder, tts, player, log } = createResponder({ onBotResponse });

      await responder.handleTranscription('hello');

      expect(onBotResponse).toHaveBeenCalledWith('AI says hello');
      expect(tts.synthesize).toHaveBeenCalled();
      expect(player.play).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'voice-responder: onBotResponse callback error',
      );
    });
  });

  describe('stop', () => {
    it('interrupts in-flight pipeline', async () => {
      let resolveAi!: (value: string) => void;
      const invokeAi = vi.fn(
        () => new Promise<string>((r) => { resolveAi = r; }),
      );
      const { responder, tts, player } = createResponder({ invokeAi });

      const promise = responder.handleTranscription('hello');
      expect(responder.isProcessing).toBe(true);

      responder.stop();
      expect(responder.isProcessing).toBe(false);
      expect(player.stop).toHaveBeenCalled();

      // Resolve AI to let the promise settle
      resolveAi('response');
      await promise;

      // TTS should not have been called (pipeline was interrupted)
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('is safe to call when not processing', () => {
      const { responder } = createResponder();
      responder.stop(); // should not throw
      expect(responder.isProcessing).toBe(false);
    });
  });

  describe('isPlaying', () => {
    it('returns false when idle', () => {
      const { responder, player } = createResponder();
      player.state = { status: 'idle' };
      expect(responder.isPlaying).toBe(false);
    });

    it('returns true when playing', () => {
      const { responder, player } = createResponder();
      player.state = { status: 'playing' };
      expect(responder.isPlaying).toBe(true);
    });

    it('returns true when buffering', () => {
      const { responder, player } = createResponder();
      player.state = { status: 'buffering' };
      expect(responder.isPlaying).toBe(true);
    });

    it('returns false after stop', () => {
      const { responder, player } = createResponder();
      player.state = { status: 'playing' };
      expect(responder.isPlaying).toBe(true);

      responder.stop();
      // stop() calls player.stop() which transitions state to idle
      expect(responder.isPlaying).toBe(false);
    });
  });

  describe('destroy', () => {
    it('calls stop', () => {
      const { responder, player } = createResponder();
      responder.destroy();
      expect(player.stop).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// upsampleToDiscord
// ---------------------------------------------------------------------------

describe('upsampleToDiscord', () => {
  it('upsamples 24kHz mono to 48kHz stereo', () => {
    // 2 samples at 24kHz mono = 4 bytes input
    const input = Buffer.alloc(4);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(2000, 2);

    const output = upsampleToDiscord(input, 24000, 1);

    // 2 input frames * ratio 2 = 4 output frames
    // Each output frame = 4 bytes (stereo s16le)
    expect(output.length).toBe(16);

    // First two output frames duplicate sample 0 (1000)
    expect(output.readInt16LE(0)).toBe(1000);  // frame 0, left
    expect(output.readInt16LE(2)).toBe(1000);  // frame 0, right
    expect(output.readInt16LE(4)).toBe(1000);  // frame 1, left
    expect(output.readInt16LE(6)).toBe(1000);  // frame 1, right

    // Next two output frames duplicate sample 1 (2000)
    expect(output.readInt16LE(8)).toBe(2000);  // frame 2, left
    expect(output.readInt16LE(10)).toBe(2000); // frame 2, right
    expect(output.readInt16LE(12)).toBe(2000); // frame 3, left
    expect(output.readInt16LE(14)).toBe(2000); // frame 3, right
  });

  it('passes through 48kHz mono as stereo without rate change', () => {
    const input = Buffer.alloc(2);
    input.writeInt16LE(500, 0);

    const output = upsampleToDiscord(input, 48000, 1);

    // 1 frame * ratio 1 = 1 output frame, stereo = 4 bytes
    expect(output.length).toBe(4);
    expect(output.readInt16LE(0)).toBe(500); // left
    expect(output.readInt16LE(2)).toBe(500); // right
  });

  it('averages stereo channels and upsamples', () => {
    // 1 stereo frame at 24kHz = 4 bytes
    const input = Buffer.alloc(4);
    input.writeInt16LE(1000, 0); // left
    input.writeInt16LE(3000, 2); // right

    const output = upsampleToDiscord(input, 24000, 2);

    // Averaged: (1000 + 3000) / 2 = 2000
    // 1 frame * ratio 2 = 2 output frames, stereo = 8 bytes
    expect(output.length).toBe(8);
    expect(output.readInt16LE(0)).toBe(2000);
    expect(output.readInt16LE(2)).toBe(2000);
    expect(output.readInt16LE(4)).toBe(2000);
    expect(output.readInt16LE(6)).toBe(2000);
  });

  it('returns empty buffer for empty input', () => {
    const output = upsampleToDiscord(Buffer.alloc(0), 24000, 1);
    expect(output.length).toBe(0);
  });

  it('handles negative sample values', () => {
    const input = Buffer.alloc(2);
    input.writeInt16LE(-5000, 0);

    const output = upsampleToDiscord(input, 48000, 1);

    expect(output.readInt16LE(0)).toBe(-5000);
    expect(output.readInt16LE(2)).toBe(-5000);
  });
});
