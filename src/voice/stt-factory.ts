import type { LoggerLike } from '../logging/logger-like.js';
import type { SttProvider, VoiceConfig } from './types.js';
import { DeepgramSttProvider } from './stt-deepgram.js';

/**
 * Create an STT provider based on the voice config.
 *
 * Currently supported: `deepgram` (Nova-3 streaming via WebSocket).
 * Planned: `whisper` (local Whisper model, Phase 2b).
 *
 * Requires `DISCOCLAW_VOICE_ENABLED=1` and a provider-specific API key
 * (e.g. `DEEPGRAM_API_KEY`). See docs/voice.md for setup.
 */
export function createSttProvider(config: VoiceConfig, log: LoggerLike): SttProvider {
  switch (config.sttProvider) {
    case 'deepgram': {
      if (!config.deepgramApiKey) {
        throw new Error('deepgramApiKey is required when sttProvider is "deepgram"');
      }
      return new DeepgramSttProvider({
        apiKey: config.deepgramApiKey,
        sampleRate: 16000,
        log,
      });
    }
    case 'whisper':
      throw new Error('Whisper STT adapter is not yet implemented (Phase 2b)');
  }
}
