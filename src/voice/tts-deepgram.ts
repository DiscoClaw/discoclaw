import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TtsProvider } from './types.js';

const DEEPGRAM_SPEECH_URL = 'https://api.deepgram.com/v1/speak';
const DEFAULT_MODEL = 'aura-2-asteria-en';
const DEFAULT_SAMPLE_RATE = 24000;
export const DEEPGRAM_MAX_CHARS = 2000;

export type DeepgramTtsOpts = {
  apiKey: string;
  model?: string;
  sampleRate?: number;
  /** TTS playback speed in range [0.5, 1.5]. Defaults to Deepgram's default (1.0). */
  speed?: number;
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
  private readonly speed: number | undefined;
  private readonly log: LoggerLike;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: DeepgramTtsOpts) {
    if (opts.speed !== undefined && (opts.speed < 0.5 || opts.speed > 1.5)) {
      throw new RangeError(
        `DeepgramTtsProvider: speed must be in range [0.5, 1.5], got ${opts.speed}`,
      );
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.speed = opts.speed;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async *synthesize(text: string): AsyncGenerator<AudioFrame> {
    if (!text.trim()) return;

    if (text.length > DEEPGRAM_MAX_CHARS) {
      const originalLength = text.length;
      const slice = text.slice(0, DEEPGRAM_MAX_CHARS);
      const sentenceEnd = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('.\n'),
        slice.lastIndexOf('!\n'),
        slice.lastIndexOf('?\n'),
      );
      text = sentenceEnd > 0 ? slice.slice(0, sentenceEnd + 1) : (slice.lastIndexOf(' ') > 0 ? slice.slice(0, slice.lastIndexOf(' ')) : slice);
      this.log.warn(
        { originalLength, truncatedLength: text.length },
        'Deepgram TTS: text truncated to prevent HTTP 413',
      );
    }

    const params = new URLSearchParams({
      model: this.model,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      container: 'none',
    });
    if (this.speed !== undefined) {
      params.set('speed', String(this.speed));
    }
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
