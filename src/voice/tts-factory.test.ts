import { describe, it, expect, vi } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';
import type { VoiceConfig } from './types.js';
import { createTtsProvider } from './tts-factory.js';
import { CartesiaTtsProvider } from './tts-cartesia.js';
import { OpenaiTtsProvider } from './tts-openai.js';

// Stub globalThis.WebSocket so CartesiaTtsProvider constructor doesn't throw
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
    cartesiaApiKey: 'test-key',
    ...overrides,
  };
}

describe('createTtsProvider', () => {
  it('returns a CartesiaTtsProvider for cartesia config', () => {
    const provider = createTtsProvider(baseConfig(), createLogger());
    expect(provider).toBeInstanceOf(CartesiaTtsProvider);
  });

  it('throws when cartesiaApiKey is missing for cartesia provider', () => {
    expect(() =>
      createTtsProvider(baseConfig({ cartesiaApiKey: undefined }), createLogger()),
    ).toThrow('cartesiaApiKey is required');
  });

  it('returns an OpenaiTtsProvider for openai config', () => {
    const provider = createTtsProvider(
      baseConfig({ ttsProvider: 'openai', openaiApiKey: 'sk-test' }),
      createLogger(),
    );
    expect(provider).toBeInstanceOf(OpenaiTtsProvider);
  });

  it('throws when openaiApiKey is missing for openai provider', () => {
    expect(() =>
      createTtsProvider(baseConfig({ ttsProvider: 'openai' }), createLogger()),
    ).toThrow('openaiApiKey is required');
  });

  it('throws not-implemented for kokoro provider', () => {
    expect(() =>
      createTtsProvider(baseConfig({ ttsProvider: 'kokoro' }), createLogger()),
    ).toThrow('not yet implemented');
  });
});
