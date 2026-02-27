import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, SttProvider } from './types.js';
import { AudioReceiver, downsample, type OpusDecoder, type AudioReceiverOpts } from './audio-receiver.js';

// ---------------------------------------------------------------------------
// Mock @discordjs/voice — we only need EndBehaviorType and the shape of
// VoiceConnection.receiver.
// ---------------------------------------------------------------------------

vi.mock('@discordjs/voice', () => ({
  EndBehaviorType: { Manual: 0, AfterSilence: 1, AfterInactivity: 2 },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockStt(): SttProvider & { fed: AudioFrame[] } {
  const fed: AudioFrame[] = [];
  return {
    fed,
    start: vi.fn(async () => {}),
    feedAudio: vi.fn((frame: AudioFrame) => fed.push(frame)),
    onTranscription: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

function createMockDecoder(): OpusDecoder & { calls: Buffer[] } {
  const calls: Buffer[] = [];
  return {
    calls,
    decode: vi.fn((packet: Buffer) => {
      calls.push(packet);
      // Return a fake 48 kHz stereo PCM frame: 960 stereo frames = 3840 bytes
      // (20 ms at 48 kHz, 2 channels, 2 bytes/sample)
      const pcm = Buffer.alloc(960 * 2 * 2); // 3840 bytes
      // Write a recognizable sample value in L + R
      for (let i = 0; i < 960; i++) {
        pcm.writeInt16LE(1000, i * 4);     // L
        pcm.writeInt16LE(2000, i * 4 + 2); // R
      }
      return pcm;
    }),
    destroy: vi.fn(),
  };
}

/** Create a mock audio receive stream (EventEmitter that acts like a Readable). */
function createMockStream() {
  return new EventEmitter();
}

/**
 * Create a mock VoiceConnection with a controllable receiver.
 * `speakingEmitter` fires 'start'/'end' events.
 * `subscribeFn` is called when receiver.subscribe() is invoked.
 */
function createMockConnection() {
  const speakingEmitter = new EventEmitter();
  const subscriptions = new Map<string, unknown>();
  const streams = new Map<string, EventEmitter>();

  const subscribeFn = vi.fn((userId: string) => {
    const stream = createMockStream();
    streams.set(userId, stream);
    subscriptions.set(userId, stream);
    return stream;
  });

  const connection = {
    receiver: {
      speaking: speakingEmitter,
      subscriptions,
      subscribe: subscribeFn,
    },
  };

  return { connection: connection as unknown as import('@discordjs/voice').VoiceConnection, speakingEmitter, subscribeFn, subscriptions, streams };
}

function createReceiverOpts(overrides: Partial<AudioReceiverOpts> = {}) {
  const { connection } = createMockConnection();
  const decoder = createMockDecoder();
  return {
    connection,
    allowedUserIds: new Set(['111', '222']),
    sttProvider: createMockStt(),
    log: createLogger(),
    createDecoder: () => decoder,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AudioReceiver', () => {
  it('start sets isRunning to true', () => {
    const opts = createReceiverOpts();
    const recv = new AudioReceiver(opts);

    expect(recv.isRunning).toBe(false);
    recv.start();
    expect(recv.isRunning).toBe(true);
  });

  it('double start is a no-op', () => {
    const opts = createReceiverOpts();
    const recv = new AudioReceiver(opts);

    recv.start();
    recv.start(); // should not throw or change state
    expect(recv.isRunning).toBe(true);
  });

  it('stop sets isRunning to false', () => {
    const opts = createReceiverOpts();
    const recv = new AudioReceiver(opts);

    recv.start();
    recv.stop();
    expect(recv.isRunning).toBe(false);
  });

  it('stop before start is a no-op', () => {
    const opts = createReceiverOpts();
    const recv = new AudioReceiver(opts);

    recv.stop(); // should not throw
    expect(recv.isRunning).toBe(false);
  });

  it('subscribes to allowlisted user when they start speaking', () => {
    const { connection, speakingEmitter, subscribeFn } = createMockConnection();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log: createLogger(),
      createDecoder: createMockDecoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    expect(subscribeFn).toHaveBeenCalledWith('111', expect.objectContaining({
      end: expect.objectContaining({ behavior: 1 }), // AfterSilence
    }));
  });

  it('ignores non-allowlisted user', () => {
    const { connection, speakingEmitter, subscribeFn } = createMockConnection();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log,
      createDecoder: createMockDecoder,
    });

    recv.start();
    speakingEmitter.emit('start', '999');

    expect(subscribeFn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { userId: '999' },
      'ignoring audio from non-allowlisted user',
    );
  });

  it('rejects all users when allowlist is empty (fail closed)', () => {
    const { connection, speakingEmitter, subscribeFn } = createMockConnection();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(),
      sttProvider: createMockStt(),
      log,
      createDecoder: createMockDecoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    expect(subscribeFn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { userId: '111' },
      'ignoring audio from non-allowlisted user',
    );
  });

  it('does not double-subscribe when user is already subscribed', () => {
    const { connection, speakingEmitter, subscribeFn, subscriptions } = createMockConnection();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log: createLogger(),
      createDecoder: createMockDecoder,
    });

    recv.start();

    // First speaking event — subscribes
    speakingEmitter.emit('start', '111');
    expect(subscribeFn).toHaveBeenCalledTimes(1);

    // Second speaking event — already in subscriptions map, no re-subscribe
    speakingEmitter.emit('start', '111');
    expect(subscribeFn).toHaveBeenCalledTimes(1);
  });

  it('decodes Opus, downsamples, and feeds audio to STT', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const stt = createMockStt();
    const decoder = createMockDecoder();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: stt,
      log: createLogger(),
      createDecoder: () => decoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    // Simulate an Opus packet arriving on the stream
    const opusPacket = Buffer.from([0x01, 0x02, 0x03]);
    const stream = streams.get('111')!;
    stream.emit('data', opusPacket);

    // Decoder should have been called with the Opus packet
    expect(decoder.decode).toHaveBeenCalledWith(opusPacket);

    // STT should have received a 16 kHz mono frame
    expect(stt.feedAudio).toHaveBeenCalledTimes(1);
    const frame = stt.fed[0];
    expect(frame.sampleRate).toBe(16_000);
    expect(frame.channels).toBe(1);
    // 960 frames at 48 kHz → 320 frames at 16 kHz → 640 bytes (mono s16le)
    expect(frame.buffer.length).toBe(320 * 2);
  });

  it('cleans up decoder on stream end', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const decoder = createMockDecoder();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log,
      createDecoder: () => decoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    const stream = streams.get('111')!;
    stream.emit('end');

    expect(decoder.destroy).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ userId: '111' }, 'cleaned up user audio decoder');
  });

  it('cleans up decoder on stream error', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const decoder = createMockDecoder();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log,
      createDecoder: () => decoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    const stream = streams.get('111')!;
    const err = new Error('test error');
    stream.emit('error', err);

    expect(decoder.destroy).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { err, userId: '111' },
      'audio receive stream error',
    );
  });

  it('logs DAVE DecryptionFailed error at warn and cleans up user', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const decoder = createMockDecoder();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log,
      createDecoder: () => decoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    const stream = streams.get('111')!;
    const err = new Error('DecryptionFailed(UnencryptedWhenPassthroughDisabled)');
    stream.emit('error', err);

    // Should log at warn, not error
    expect(log.warn).toHaveBeenCalledWith(
      { err, userId: '111' },
      'audio receive stream DAVE decryption error (stream cleaned up)',
    );
    expect(log.error).not.toHaveBeenCalled();
    // Cleanup still happens
    expect(decoder.destroy).toHaveBeenCalled();
  });

  it('logs non-DAVE stream error at error level and cleans up user', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const decoder = createMockDecoder();
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log,
      createDecoder: () => decoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    const stream = streams.get('111')!;
    const err = new Error('socket hang up');
    stream.emit('error', err);

    // Should log at error
    expect(log.error).toHaveBeenCalledWith(
      { err, userId: '111' },
      'audio receive stream error',
    );
    expect(log.warn).not.toHaveBeenCalled();
    // Cleanup still happens
    expect(decoder.destroy).toHaveBeenCalled();
  });

  it('logs decode errors without crashing', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const stt = createMockStt();
    const badDecoder: OpusDecoder = {
      decode: vi.fn(() => { throw new Error('decode failed'); }),
      destroy: vi.fn(),
    };
    const log = createLogger();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: stt,
      log,
      createDecoder: () => badDecoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    const stream = streams.get('111')!;
    stream.emit('data', Buffer.from([0x01]));

    // Should not crash — error is logged
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '111' }),
      'failed to decode/feed audio packet',
    );
    expect(stt.feedAudio).not.toHaveBeenCalled();
  });

  it('ignores audio data after stop', () => {
    const { connection, speakingEmitter, streams } = createMockConnection();
    const stt = createMockStt();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: stt,
      log: createLogger(),
      createDecoder: createMockDecoder,
    });

    recv.start();
    speakingEmitter.emit('start', '111');

    recv.stop();

    const stream = streams.get('111')!;
    stream.emit('data', Buffer.from([0x01]));

    expect(stt.feedAudio).not.toHaveBeenCalled();
  });

  it('stop destroys all active decoders', () => {
    const { connection, speakingEmitter } = createMockConnection();
    const decoders: OpusDecoder[] = [];
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111', '222']),
      sttProvider: createMockStt(),
      log: createLogger(),
      createDecoder: () => {
        const d = createMockDecoder();
        decoders.push(d);
        return d;
      },
    });

    recv.start();
    speakingEmitter.emit('start', '111');
    speakingEmitter.emit('start', '222');

    expect(decoders).toHaveLength(2);

    recv.stop();

    for (const d of decoders) {
      expect(d.destroy).toHaveBeenCalled();
    }
  });

  it('ignores speaking events after stop', () => {
    const { connection, speakingEmitter, subscribeFn } = createMockConnection();
    const recv = new AudioReceiver({
      connection,
      allowedUserIds: new Set(['111']),
      sttProvider: createMockStt(),
      log: createLogger(),
      createDecoder: createMockDecoder,
    });

    recv.start();
    recv.stop();

    speakingEmitter.emit('start', '111');
    expect(subscribeFn).not.toHaveBeenCalled();
  });

  describe('onUserSpeaking callback', () => {
    it('fires for allowlisted user on speaking start', () => {
      const { connection, speakingEmitter } = createMockConnection();
      const onUserSpeaking = vi.fn();
      const recv = new AudioReceiver({
        connection,
        allowedUserIds: new Set(['111']),
        sttProvider: createMockStt(),
        log: createLogger(),
        createDecoder: createMockDecoder,
        onUserSpeaking,
      });

      recv.start();
      speakingEmitter.emit('start', '111');

      expect(onUserSpeaking).toHaveBeenCalledWith('111');
    });

    it('fires even when user is already subscribed', () => {
      const { connection, speakingEmitter } = createMockConnection();
      const onUserSpeaking = vi.fn();
      const recv = new AudioReceiver({
        connection,
        allowedUserIds: new Set(['111']),
        sttProvider: createMockStt(),
        log: createLogger(),
        createDecoder: createMockDecoder,
        onUserSpeaking,
      });

      recv.start();
      speakingEmitter.emit('start', '111'); // subscribes
      speakingEmitter.emit('start', '111'); // already subscribed

      expect(onUserSpeaking).toHaveBeenCalledTimes(2);
    });

    it('does not fire for non-allowlisted user', () => {
      const { connection, speakingEmitter } = createMockConnection();
      const onUserSpeaking = vi.fn();
      const recv = new AudioReceiver({
        connection,
        allowedUserIds: new Set(['111']),
        sttProvider: createMockStt(),
        log: createLogger(),
        createDecoder: createMockDecoder,
        onUserSpeaking,
      });

      recv.start();
      speakingEmitter.emit('start', '999');

      expect(onUserSpeaking).not.toHaveBeenCalled();
    });

    it('does not fire after stop', () => {
      const { connection, speakingEmitter } = createMockConnection();
      const onUserSpeaking = vi.fn();
      const recv = new AudioReceiver({
        connection,
        allowedUserIds: new Set(['111']),
        sttProvider: createMockStt(),
        log: createLogger(),
        createDecoder: createMockDecoder,
        onUserSpeaking,
      });

      recv.start();
      recv.stop();
      speakingEmitter.emit('start', '111');

      expect(onUserSpeaking).not.toHaveBeenCalled();
    });

    it('does not block subscription if callback throws', () => {
      const { connection, speakingEmitter, subscribeFn } = createMockConnection();
      const log = createLogger();
      const onUserSpeaking = vi.fn(() => { throw new Error('callback boom'); });
      const recv = new AudioReceiver({
        connection,
        allowedUserIds: new Set(['111']),
        sttProvider: createMockStt(),
        log,
        createDecoder: createMockDecoder,
        onUserSpeaking,
      });

      recv.start();
      speakingEmitter.emit('start', '111');

      // Callback threw but subscription should still proceed
      expect(subscribeFn).toHaveBeenCalledWith('111', expect.anything());
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ userId: '111' }),
        'onUserSpeaking callback error',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// downsample
// ---------------------------------------------------------------------------

describe('downsample', () => {
  it('downsamples 48 kHz stereo to 16 kHz mono', () => {
    // Create 960 stereo frames at 48 kHz (20 ms)
    const input = Buffer.alloc(960 * 4); // 2 channels * 2 bytes/sample
    for (let i = 0; i < 960; i++) {
      input.writeInt16LE(1000, i * 4);     // L
      input.writeInt16LE(2000, i * 4 + 2); // R
    }

    const output = downsample(input, 48_000, 2, 16_000);

    // 960 / 3 = 320 output frames, each 2 bytes
    expect(output.length).toBe(320 * 2);

    // Each output sample should be average of L+R = (1000+2000)/2 = 1500
    for (let i = 0; i < 320; i++) {
      expect(output.readInt16LE(i * 2)).toBe(1500);
    }
  });

  it('downsamples 48 kHz mono to 16 kHz mono', () => {
    const input = Buffer.alloc(960 * 2);
    for (let i = 0; i < 960; i++) {
      input.writeInt16LE(500, i * 2);
    }

    const output = downsample(input, 48_000, 1, 16_000);

    expect(output.length).toBe(320 * 2);
    for (let i = 0; i < 320; i++) {
      expect(output.readInt16LE(i * 2)).toBe(500);
    }
  });

  it('returns empty buffer for empty input', () => {
    const output = downsample(Buffer.alloc(0), 48_000, 2, 16_000);
    expect(output.length).toBe(0);
  });

  it('handles non-3x ratio (e.g. 48 kHz → 8 kHz = 6x)', () => {
    const input = Buffer.alloc(480 * 4); // 480 stereo frames
    for (let i = 0; i < 480; i++) {
      input.writeInt16LE(300, i * 4);
      input.writeInt16LE(300, i * 4 + 2);
    }

    const output = downsample(input, 48_000, 2, 8_000);

    // 480 / 6 = 80 output frames
    expect(output.length).toBe(80 * 2);
    for (let i = 0; i < 80; i++) {
      expect(output.readInt16LE(i * 2)).toBe(300);
    }
  });
});
