import type { LoggerLike } from '../logging/logger-like.js';
import type { SttProvider, VoiceConfig } from './types.js';
import { DeepgramSttProvider } from './stt-deepgram.js';

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
