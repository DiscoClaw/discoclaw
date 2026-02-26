import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TtsProvider } from './types.js';

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_SAMPLE_RATE = 24000;

export type OpenaiTtsOpts = {
  apiKey: string;
  model?: string;
  voice?: string;
  sampleRate?: number;
  log: LoggerLike;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
};

/**
 * OpenAI TTS adapter.
 *
 * POSTs to `/v1/audio/speech` requesting `pcm` format (raw 24 kHz 16-bit mono).
 * Streams the response body and yields `AudioFrame` chunks.
 */
export class OpenaiTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly sampleRate: number;
  private readonly log: LoggerLike;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: OpenaiTtsOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.voice = opts.voice ?? DEFAULT_VOICE;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async *synthesize(text: string): AsyncGenerator<AudioFrame> {
    if (!text.trim()) return;

    this.log.info(
      { model: this.model, textLength: text.length },
      'OpenAI TTS: sending synthesis request',
    );

    const response = await this.fetchFn(OPENAI_SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'pcm',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI TTS API error: ${response.status} — ${body.slice(0, 200)}`,
      );
    }

    if (!response.body) {
      throw new Error('OpenAI TTS: response has no body stream');
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          yield {
            buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
            sampleRate: this.sampleRate,
            channels: 1,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
