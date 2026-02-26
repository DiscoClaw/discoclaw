import type { LoggerLike } from '../logging/logger-like.js';
import type { TtsProvider, VoiceConfig } from './types.js';
import { CartesiaTtsProvider } from './tts-cartesia.js';

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
