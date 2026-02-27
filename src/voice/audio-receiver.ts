/**
 * Audio receive bridge — subscribes to allowlisted users in a Discord voice
 * connection, decodes Opus packets to PCM, downsamples to 16 kHz mono, and
 * feeds the result into an SttProvider.
 */

import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import type { Readable } from 'node:stream';
import type { LoggerLike } from '../logging/logger-like.js';
import type { SttProvider } from './types.js';

/** Discord native Opus decode rate. */
const DISCORD_RATE = 48_000;
/** Discord Opus frames decode to stereo. */
const DISCORD_CHANNELS = 2;
/** Target sample rate for STT providers. */
const STT_RATE = 16_000;
/** Silence timeout before ending a per-user receive stream (ms). */
const SILENCE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// OpusDecoder — injectable Opus → PCM bridge
// ---------------------------------------------------------------------------

export interface OpusDecoder {
  /** Decode a single Opus packet to PCM s16le (48 kHz stereo by default). */
  decode(packet: Buffer): Buffer;
  /** Release native resources. */
  destroy(): void;
}

export type OpusDecoderFactory = () => OpusDecoder;

// ---------------------------------------------------------------------------
// AudioReceiverOpts
// ---------------------------------------------------------------------------

export type AudioReceiverOpts = {
  connection: VoiceConnection;
  allowedUserIds: Set<string>;
  sttProvider: SttProvider;
  log: LoggerLike;
  /** Factory to create per-user Opus decoders. Required — no built-in default. */
  createDecoder: OpusDecoderFactory;
  /** Called every time an allowlisted user begins a speaking burst (barge-in signal). */
  onUserSpeaking?: (userId: string) => void;
};

// ---------------------------------------------------------------------------
// AudioReceiver
// ---------------------------------------------------------------------------

export class AudioReceiver {
  private readonly connection: VoiceConnection;
  private readonly allowed: Set<string>;
  private readonly stt: SttProvider;
  private readonly log: LoggerLike;
  private readonly createDecoder: OpusDecoderFactory;
  private readonly onUserSpeaking?: (userId: string) => void;
  private readonly decoders = new Map<string, OpusDecoder>();
  private running = false;

  constructor(opts: AudioReceiverOpts) {
    this.connection = opts.connection;
    this.allowed = opts.allowedUserIds;
    this.stt = opts.sttProvider;
    this.log = opts.log;
    this.createDecoder = opts.createDecoder;
    this.onUserSpeaking = opts.onUserSpeaking;
  }

  /** Begin listening for audio from allowlisted users. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
    this.log.info({}, 'audio receiver started');
  }

  /** Stop listening and release all decoders. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.connection.receiver.speaking.removeListener('start', this.onSpeakingStart);

    for (const [userId, decoder] of this.decoders) {
      decoder.destroy();
      this.decoders.delete(userId);
    }

    this.log.info({}, 'audio receiver stopped');
  }

  /** Whether the receiver is currently listening. */
  get isRunning(): boolean {
    return this.running;
  }

  // -- private ---------------------------------------------------------------

  private readonly onSpeakingStart = (userId: string): void => {
    if (!this.running) return;

    // Allowlist gate — fail closed
    if (this.allowed.size === 0 || !this.allowed.has(userId)) {
      this.log.info({ userId }, 'ignoring audio from non-allowlisted user');
      return;
    }

    // Barge-in signal — fires every speaking burst, even if already subscribed
    try {
      this.onUserSpeaking?.(userId);
    } catch (err) {
      this.log.error({ err, userId }, 'onUserSpeaking callback error');
    }

    // Don't double-subscribe
    if (this.connection.receiver.subscriptions.has(userId)) return;

    this.subscribeUser(userId);
  };

  private subscribeUser(userId: string): void {
    const stream: Readable = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SILENCE_TIMEOUT_MS,
      },
    });

    const decoder = this.createDecoder();
    this.decoders.set(userId, decoder);

    this.log.info({ userId }, 'subscribed to user audio');

    stream.on('data', (opusPacket: Buffer) => {
      if (!this.running) return;
      try {
        const pcm48 = decoder.decode(opusPacket);
        const pcm16 = downsample(pcm48, DISCORD_RATE, DISCORD_CHANNELS, STT_RATE);
        this.stt.feedAudio({
          buffer: pcm16,
          sampleRate: STT_RATE,
          channels: 1,
        });
      } catch (err) {
        this.log.error({ err, userId }, 'failed to decode/feed audio packet');
      }
    });

    stream.on('end', () => {
      this.cleanupUser(userId);
    });

    stream.on('error', (err: Error) => {
      this.log.error({ err, userId }, 'audio receive stream error');
      this.cleanupUser(userId);
    });
  }

  private cleanupUser(userId: string): void {
    const decoder = this.decoders.get(userId);
    if (decoder) {
      decoder.destroy();
      this.decoders.delete(userId);
      this.log.info({ userId }, 'cleaned up user audio decoder');
    }
  }
}

// ---------------------------------------------------------------------------
// PCM downsampling — 48 kHz stereo s16le → 16 kHz mono s16le
// ---------------------------------------------------------------------------

/**
 * Downsample PCM s16le audio from srcRate/srcChannels to dstRate mono.
 * Uses simple decimation (pick every Nth frame, average channels) which is
 * adequate for voice-quality audio headed to an STT engine.
 */
export function downsample(
  input: Buffer,
  srcRate: number,
  srcChannels: number,
  dstRate: number,
): Buffer {
  const bytesPerSample = 2; // s16le
  const frameSize = bytesPerSample * srcChannels;
  const totalFrames = Math.floor(input.length / frameSize);
  const ratio = srcRate / dstRate;
  const outFrames = Math.floor(totalFrames / ratio);
  const output = Buffer.allocUnsafe(outFrames * bytesPerSample); // mono output

  for (let i = 0; i < outFrames; i++) {
    const srcFrame = Math.floor(i * ratio);
    const srcOffset = srcFrame * frameSize;

    if (srcChannels === 1) {
      output.writeInt16LE(input.readInt16LE(srcOffset), i * bytesPerSample);
    } else {
      // Average L + R for mono mixdown
      const left = input.readInt16LE(srcOffset);
      const right = input.readInt16LE(srcOffset + bytesPerSample);
      const mono = Math.round((left + right) / 2);
      output.writeInt16LE(mono, i * bytesPerSample);
    }
  }

  return output;
}
