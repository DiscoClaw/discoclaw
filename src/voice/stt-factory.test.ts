import { describe, it, expect, vi } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { VoiceConfig } from './types.js';
import { createSttProvider } from './stt-factory.js';
import { DeepgramSttProvider } from './stt-deepgram.js';
import { OpenaiSttProvider } from './stt-openai.js';

// Stub globalThis.WebSocket so DeepgramSttProvider constructor doesn't throw
class StubWebSocket {
  onopen: ((e: unknown) => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.({ type: 'open' }));
  }
  send() {}
  close() {}
}
(globalThis as Record<string, unknown>).WebSocket = StubWebSocket;

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    sttProvider: 'deepgram',
    ttsProvider: 'cartesia',
    deepgramApiKey: 'test-key',
    ...overrides,
  };
}

describe('createSttProvider', () => {
  it('returns a DeepgramSttProvider for deepgram config', () => {
    const provider = createSttProvider(baseConfig(), createLogger());
    expect(provider).toBeInstanceOf(DeepgramSttProvider);
  });

  it('throws when deepgramApiKey is missing for deepgram provider', () => {
    expect(() =>
      createSttProvider(baseConfig({ deepgramApiKey: undefined }), createLogger()),
    ).toThrow('deepgramApiKey is required');
  });

  it('returns an OpenaiSttProvider for openai config', () => {
    const provider = createSttProvider(
      baseConfig({ sttProvider: 'openai', openaiApiKey: 'sk-test' }),
      createLogger(),
    );
    expect(provider).toBeInstanceOf(OpenaiSttProvider);
  });

  it('throws when openaiApiKey is missing for openai provider', () => {
    expect(() =>
      createSttProvider(baseConfig({ sttProvider: 'openai' }), createLogger()),
    ).toThrow('openaiApiKey is required');
  });

  it('throws not-implemented for whisper provider', () => {
    expect(() =>
      createSttProvider(baseConfig({ sttProvider: 'whisper' }), createLogger()),
    ).toThrow('not yet implemented');
  });
});
