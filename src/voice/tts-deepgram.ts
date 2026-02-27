import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TtsProvider } from './types.js';

const DEEPGRAM_SPEECH_URL = 'https://api.deepgram.com/v1/speak';
const DEFAULT_MODEL = 'aura-2-asteria-en';
const DEFAULT_SAMPLE_RATE = 24000;

export type DeepgramTtsOpts = {
  apiKey: string;
  model?: string;
  sampleRate?: number;
  log: LoggerLike;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
};

/**
 * Deepgram Aura TTS adapter.
 *
 * POSTs to `/v1/speak` requesting `linear16` encoding with `container=none`
 * (raw PCM s16le). Streams the response body and yields `AudioFrame` chunks.
 */
export class DeepgramTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly sampleRate: number;
  private readonly log: LoggerLike;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: DeepgramTtsOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async *synthesize(text: string): AsyncGenerator<AudioFrame> {
    if (!text.trim()) return;

    const params = new URLSearchParams({
      model: this.model,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      container: 'none',
    });
    const url = `${DEEPGRAM_SPEECH_URL}?${params.toString()}`;

    this.log.info(
      { model: this.model, textLength: text.length },
      'Deepgram TTS: sending synthesis request',
    );

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Deepgram TTS API error: ${response.status} — ${body.slice(0, 200)}`,
      );
    }

    if (!response.body) {
      throw new Error('Deepgram TTS: response has no body stream');
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
