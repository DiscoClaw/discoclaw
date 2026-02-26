/**
 * Opus decoder factory — wraps @discordjs/opus OpusEncoder to produce
 * OpusDecoder instances compatible with AudioReceiver.
 *
 * Discord sends 48 kHz stereo Opus packets. This factory creates decoders
 * pre-configured for that format.
 */

import { OpusEncoder } from '@discordjs/opus';
import type { OpusDecoder, OpusDecoderFactory } from './audio-receiver.js';

/** Discord native Opus decode rate. */
const DISCORD_RATE = 48_000;
/** Discord Opus frames decode to stereo. */
const DISCORD_CHANNELS = 2;

/**
 * Create an OpusDecoder backed by @discordjs/opus.
 *
 * The returned decoder produces PCM s16le at 48 kHz stereo — matching
 * Discord's native format. Downstream consumers (AudioReceiver) handle
 * downsampling to STT-friendly rates.
 */
export function createOpusDecoder(): OpusDecoder {
  const encoder = new OpusEncoder(DISCORD_RATE, DISCORD_CHANNELS);
  let destroyed = false;

  return {
    decode(packet: Buffer): Buffer {
      if (destroyed) {
        throw new Error('OpusDecoder has been destroyed');
      }
      return encoder.decode(packet);
    },
    destroy(): void {
      destroyed = true;
    },
  };
}

/** Factory function matching the OpusDecoderFactory type. */
export const opusDecoderFactory: OpusDecoderFactory = createOpusDecoder;
