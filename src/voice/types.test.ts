import { describe, it, expect } from 'vitest';
import type {
  VoiceConfig,
  AudioFrame,
  TranscriptionResult,
  SttProvider,
  TtsProvider,
} from './types.js';

describe('Voice types', () => {
  // Compile-time checks: if these compile, the interfaces are well-formed.

  it('VoiceConfig is assignable in expected shape', () => {
    const cfg: VoiceConfig = {
      enabled: true,
      sttProvider: 'deepgram',
      ttsProvider: 'cartesia',
      transcriptChannel: '123456789',
      deepgramApiKey: 'key-dg',
      cartesiaApiKey: 'key-cart',
    };
    const cfg2: VoiceConfig = cfg;
    expect(cfg2).toBe(cfg);
  });

  it('VoiceConfig accepts minimal shape (optional fields omitted)', () => {
    const cfg: VoiceConfig = {
      enabled: false,
      sttProvider: 'whisper',
      ttsProvider: 'kokoro',
    };
    expect(cfg.transcriptChannel).toBeUndefined();
    expect(cfg.deepgramApiKey).toBeUndefined();
    expect(cfg.cartesiaApiKey).toBeUndefined();
  });

  it('AudioFrame is assignable in expected shape', () => {
    const frame: AudioFrame = {
      buffer: Buffer.alloc(320),
      sampleRate: 16000,
      channels: 1,
    };
    const frame2: AudioFrame = frame;
    expect(frame2).toBe(frame);
  });

  it('TranscriptionResult is assignable in expected shape', () => {
    const result: TranscriptionResult = {
      text: 'hello world',
      confidence: 0.95,
      isFinal: true,
    };
    const result2: TranscriptionResult = result;
    expect(result2).toBe(result);
  });

  it('TranscriptionResult works without optional confidence', () => {
    const result: TranscriptionResult = {
      text: 'partial',
      isFinal: false,
    };
    expect(result.confidence).toBeUndefined();
  });

  it('mock SttProvider satisfies the interface', async () => {
    let cb: ((result: TranscriptionResult) => void) | undefined;

    const provider: SttProvider = {
      start: async () => {},
      feedAudio: () => {},
      onTranscription: (callback) => { cb = callback; },
      stop: async () => {},
    };

    await provider.start();

    const frame: AudioFrame = { buffer: Buffer.alloc(160), sampleRate: 16000, channels: 1 };
    provider.feedAudio(frame);

    const results: TranscriptionResult[] = [];
    provider.onTranscription((r) => results.push(r));

    // Simulate a transcription arriving
    cb!({ text: 'test', isFinal: true });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('test');

    await provider.stop();
  });

  it('mock TtsProvider satisfies the interface', async () => {
    const provider: TtsProvider = {
      async *synthesize(_text: string) {
        yield { buffer: Buffer.alloc(320), sampleRate: 24000, channels: 1 } satisfies AudioFrame;
        yield { buffer: Buffer.alloc(320), sampleRate: 24000, channels: 1 } satisfies AudioFrame;
      },
    };

    const frames: AudioFrame[] = [];
    for await (const frame of provider.synthesize('hello')) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0].sampleRate).toBe(24000);
  });
});
