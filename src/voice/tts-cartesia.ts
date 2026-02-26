import crypto from 'node:crypto';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, TtsProvider } from './types.js';

const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const DEFAULT_MODEL_ID = 'sonic-3';
const DEFAULT_SAMPLE_RATE = 24000;

type WsConstructor = new (url: string | URL) => WebSocket;

export type CartesiaTtsOpts = {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  sampleRate?: number;
  log: LoggerLike;
  /** Override WebSocket constructor for testing. */
  wsConstructor?: WsConstructor;
};

export class CartesiaTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly sampleRate: number;
  private readonly log: LoggerLike;
  private readonly WsCtor: WsConstructor;

  constructor(opts: CartesiaTtsOpts) {
    if (typeof globalThis.WebSocket === 'undefined' && !opts.wsConstructor) {
      throw new Error(
        'globalThis.WebSocket is not available. ' +
          'Node 22+ includes WebSocket natively. ' +
          'Upgrade to Node 22+ or pass a wsConstructor option.',
      );
    }
    this.apiKey = opts.apiKey;
    this.voiceId = opts.voiceId ?? 'a0e99841-438c-4a64-b679-ae501e7d6091';
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.log = opts.log;
    this.WsCtor = opts.wsConstructor ?? globalThis.WebSocket;
  }

  async *synthesize(text: string): AsyncGenerator<AudioFrame> {
    if (!text.trim()) return;

    const url = this.buildUrl();
    const ws = new this.WsCtor(url);
    let hasYielded = false;

    try {
      await this.waitForOpen(ws);
      this.log.info({ model: this.modelId, textLength: text.length }, 'Cartesia TTS WebSocket connected, sending request');

      ws.send(
        JSON.stringify({
          context_id: crypto.randomUUID().replace(/-/g, ''),
          model_id: this.modelId,
          transcript: text,
          voice: { mode: 'id', id: this.voiceId },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: this.sampleRate,
          },
        }),
      );

      yield* this.receiveFrames(ws, () => {
        hasYielded = true;
      });
    } catch (err) {
      if (hasYielded) {
        throw new Error('Cartesia TTS stream disconnected mid-stream', { cause: err });
      }
      throw err;
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      cartesia_version: '2024-06-10',
    });
    return `${CARTESIA_WS_URL}?${params.toString()}`;
  }

  private waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (event: Event) => {
        this.log.error({ error: event }, 'Cartesia TTS WebSocket error');
      };
      ws.onclose = (event: CloseEvent) => {
        reject(new Error(`Cartesia TTS WebSocket closed before open: code=${event.code}`));
      };
    });
  }

  private receiveFrames(
    ws: WebSocket,
    onYield: () => void,
  ): AsyncGenerator<AudioFrame> {
    const sampleRate = this.sampleRate;
    const log = this.log;

    // Buffer for frames received before the consumer pulls them
    const pending: AudioFrame[] = [];
    let done = false;
    let error: Error | null = null;
    let notify: (() => void) | null = null;

    function wake(): void {
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      // Cartesia sends JSON messages with base64-encoded audio in msg.data
      try {
        const msg = JSON.parse(String(event.data));

        // Handle error responses from Cartesia
        if (msg.error || msg.status_code) {
          log.error({ cartesiaError: msg.error, statusCode: msg.status_code }, 'Cartesia TTS error response');
          error = new Error(`Cartesia TTS error: ${msg.error ?? `status ${msg.status_code}`}`);
          done = true;
          wake();
          return;
        }

        if (msg.data) {
          pending.push({
            buffer: Buffer.from(msg.data, 'base64'),
            sampleRate,
            channels: 1,
          });
          wake();
        }
        if (msg.done) {
          done = true;
          wake();
        }

        // Log unrecognized messages that have no data/done/error fields
        if (!msg.data && !msg.done && !msg.error && !msg.status_code) {
          log.warn({ msgType: msg.type, keys: Object.keys(msg).join(',') }, 'Cartesia TTS: unrecognized message');
        }
      } catch {
        // Fallback: raw binary frame (future-proofing)
        if (event.data instanceof ArrayBuffer) {
          pending.push({
            buffer: Buffer.from(event.data),
            sampleRate,
            channels: 1,
          });
          wake();
        } else {
          log.error('Unexpected Cartesia TTS message format');
        }
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!done) {
        error = new Error(`Cartesia TTS WebSocket closed unexpectedly: code=${event.code}`);
      }
      done = true;
      wake();
    };

    ws.onerror = (event: Event) => {
      log.error({ error: event }, 'Cartesia TTS WebSocket error');
    };

    async function* generate(): AsyncGenerator<AudioFrame> {
      while (true) {
        // Drain pending frames
        while (pending.length > 0) {
          onYield();
          yield pending.shift()!;
        }

        if (done) {
          if (error) throw error;
          return;
        }

        // Wait for new data
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    }

    return generate();
  }
}
