import type { LoggerLike } from '../logging/logger-like.js';
import type { SttProvider, VoiceConfig } from './types.js';
import { DeepgramSttProvider } from './stt-deepgram.js';
import { OpenaiSttProvider } from './stt-openai.js';

/**
 * Create an STT provider based on the voice config.
 *
 * Currently supported: `deepgram` (Nova-3 General streaming via WebSocket),
 * `openai` (Whisper API via REST).
 * Planned: `whisper` (local Whisper model, Phase 2b).
 *
 * Requires `DISCOCLAW_VOICE_ENABLED=1` and a provider-specific API key
 * (e.g. `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`). See docs/voice.md for setup.
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
        model: config.deepgramSttModel,
        log,
      });
    }
    case 'openai': {
      if (!config.openaiApiKey) {
        throw new Error('openaiApiKey is required when sttProvider is "openai"');
      }
      return new OpenaiSttProvider({
        apiKey: config.openaiApiKey,
        sampleRate: 16000,
        log,
      });
    }
    case 'whisper':
      throw new Error('Whisper STT adapter is not yet implemented (Phase 2b)');
  }
}
