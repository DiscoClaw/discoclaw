import type { LoggerLike } from '../logging/logger-like.js';
import type { TtsProvider, VoiceConfig } from './types.js';
import { CartesiaTtsProvider } from './tts-cartesia.js';

/**
 * Create a TTS provider based on the voice config.
 *
 * Currently supported: `cartesia` (Sonic-3 streaming via WebSocket, 24 kHz PCM).
 * Planned: `kokoro` (local Kokoro model, Phase 3b).
 *
 * Requires `DISCOCLAW_VOICE_ENABLED=1` and a provider-specific API key
 * (e.g. `CARTESIA_API_KEY`). See docs/voice.md for setup.
 */
export function createTtsProvider(config: VoiceConfig, log: LoggerLike): TtsProvider {
  switch (config.ttsProvider) {
    case 'cartesia': {
      if (!config.cartesiaApiKey) {
        throw new Error('cartesiaApiKey is required when ttsProvider is "cartesia"');
      }
      return new CartesiaTtsProvider({
        apiKey: config.cartesiaApiKey,
        log,
      });
    }
    case 'kokoro':
      throw new Error('Kokoro TTS adapter is not yet implemented (Phase 3b)');
  }
}
