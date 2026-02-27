/**
 * Voice responder — orchestrates the AI invoke -> TTS -> playback pipeline
 * for a single voice connection. Receives transcribed text, gets an AI
 * response, synthesizes speech, and plays it back into the voice channel.
 */

import { PassThrough } from 'node:stream';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import type { LoggerLike } from '../logging/logger-like.js';
import type { TtsProvider } from './types.js';

/** Discord voice transport format. */
const DISCORD_RATE = 48_000;
const DISCORD_CHANNELS = 2;

/** Callback to invoke the AI runtime and return a text response. */
export type InvokeAiFn = (text: string) => Promise<string>;

export type VoiceResponderOpts = {
  log: LoggerLike;
  tts: TtsProvider;
  connection: VoiceConnection;
  invokeAi: InvokeAiFn;
  /** Called with the AI response text after a successful invocation. */
  onBotResponse?: (text: string) => void;
  /** Override for testing — supply a custom AudioPlayer factory. */
  createPlayer?: () => AudioPlayer;
};

export class VoiceResponder {
  private readonly log: LoggerLike;
  private readonly tts: TtsProvider;
  private readonly connection: VoiceConnection;
  private readonly invokeAi: InvokeAiFn;
  private readonly onBotResponse?: (text: string) => void;
  private readonly player: AudioPlayer;
  private generation = 0;
  private _processing = false;

  constructor(opts: VoiceResponderOpts) {
    this.log = opts.log;
    this.tts = opts.tts;
    this.connection = opts.connection;
    this.invokeAi = opts.invokeAi;
    this.onBotResponse = opts.onBotResponse;
    this.player = opts.createPlayer ? opts.createPlayer() : createAudioPlayer();
    const subscription = this.connection.subscribe(this.player);
    this.log.info(
      { subscribed: !!subscription },
      'voice-responder: player subscription result',
    );

    this.player.on('stateChange', (oldState, newState) => {
      this.log.info(
        { from: oldState.status, to: newState.status },
        'voice-responder: player state change',
      );
    });

    this.player.on('error', (err: Error) => {
      this.log.error({ err }, 'voice-responder: audio player error');
    });
  }

  /**
   * Process a transcription: invoke AI -> synthesize TTS -> play audio.
   * If called while already processing, the earlier pipeline is abandoned
   * via a generation counter (newer invocation wins).
   */
  async handleTranscription(text: string): Promise<void> {
    if (!text.trim()) return;

    const gen = ++this.generation;
    this.player.stop(); // interrupt any current playback
    this._processing = true;

    try {
      // Step 1: Invoke AI runtime
      this.log.info({ text: text.slice(0, 100) }, 'voice-responder: invoking AI');
      const response = await this.invokeAi(text);
      if (gen !== this.generation) return;

      if (!response.trim()) {
        this.log.info({}, 'voice-responder: empty AI response, skipping TTS');
        return;
      }

      // Notify transcript mirror (fire-and-forget)
      try {
        this.onBotResponse?.(response);
      } catch (err) {
        this.log.warn({ err }, 'voice-responder: onBotResponse callback error');
      }

      // Step 2 & 3: Stream TTS -> upsample -> play incrementally
      this.log.info({ responseLength: response.length }, 'voice-responder: starting TTS');
      const stream = new PassThrough();
      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
      });

      this.player.play(resource);
      this.log.info({}, 'voice-responder: streaming playback started');

      let carry = Buffer.alloc(0);
      let totalBytes = 0;

      try {
        for await (const frame of this.tts.synthesize(response)) {
          if (gen !== this.generation) {
            stream.destroy();
            this.player.stop();
            return;
          }

          // PCM alignment: prepend carry-over bytes from previous chunk
          let chunk = frame.buffer;
          if (carry.length > 0) {
            chunk = Buffer.concat([carry, chunk]);
            carry = Buffer.alloc(0);
          }

          // Trailing byte from an odd-length chunk is a partial s16le sample
          const remainder = chunk.length % 2;
          if (remainder !== 0) {
            carry = chunk.subarray(chunk.length - remainder) as Buffer<ArrayBuffer>;
            chunk = chunk.subarray(0, chunk.length - remainder);
          }

          if (chunk.length > 0) {
            const upsampled = upsampleToDiscord(chunk, frame.sampleRate, 1);
            stream.write(upsampled);
            totalBytes += upsampled.length;
          }
        }

        stream.end();
      } catch (streamErr) {
        stream.destroy();
        this.player.stop();
        throw streamErr;
      }

      await waitForPlayerIdle(this.player);

      if (gen === this.generation) {
        this.log.info({ totalBytes }, 'voice-responder: playback complete');
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.log.error({ err }, 'voice-responder: error in response pipeline');
    } finally {
      if (gen === this.generation) {
        this._processing = false;
      }
    }
  }

  /** Whether a response pipeline is currently active. */
  get isProcessing(): boolean {
    return this._processing;
  }

  /** Whether the bot is audibly speaking (Playing or Buffering). */
  get isPlaying(): boolean {
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  /** Interrupt any in-flight pipeline and stop playback. */
  stop(): void {
    this.generation++;
    this.player.stop();
    this._processing = false;
  }

  /** Stop and release resources. */
  destroy(): void {
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForPlayerIdle(player: AudioPlayer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (player.state.status === AudioPlayerStatus.Idle) {
      resolve();
      return;
    }
    const onStateChange = (_oldState: unknown, newState: { status: string }) => {
      if (newState.status === AudioPlayerStatus.Idle) {
        player.removeListener('stateChange', onStateChange);
        resolve();
      }
    };
    player.on('stateChange', onStateChange);
  });
}

// ---------------------------------------------------------------------------
// PCM upsampling — TTS output -> Discord transport format (48 kHz stereo s16le)
// ---------------------------------------------------------------------------

/**
 * Upsample PCM s16le audio to 48 kHz stereo for Discord voice playback.
 * Uses simple sample duplication — adequate for voice-quality audio.
 */
export function upsampleToDiscord(
  input: Buffer,
  srcRate: number,
  srcChannels: number,
): Buffer {
  const bytesPerSample = 2; // s16le
  const srcFrameSize = bytesPerSample * srcChannels;
  const totalFrames = Math.floor(input.length / srcFrameSize);
  const ratio = DISCORD_RATE / srcRate;
  const outFrames = Math.ceil(totalFrames * ratio);
  const dstFrameSize = bytesPerSample * DISCORD_CHANNELS;
  const output = Buffer.allocUnsafe(outFrames * dstFrameSize);

  for (let i = 0; i < outFrames; i++) {
    const srcFrame = Math.min(Math.floor(i / ratio), totalFrames - 1);
    const srcOffset = srcFrame * srcFrameSize;

    let mono: number;
    if (srcChannels === 1) {
      mono = input.readInt16LE(srcOffset);
    } else {
      const left = input.readInt16LE(srcOffset);
      const right = input.readInt16LE(srcOffset + bytesPerSample);
      mono = Math.round((left + right) / 2);
    }

    const outOffset = i * dstFrameSize;
    output.writeInt16LE(mono, outOffset);
    output.writeInt16LE(mono, outOffset + bytesPerSample);
  }

  return output;
}
