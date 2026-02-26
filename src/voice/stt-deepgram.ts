import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, SttProvider, TranscriptionResult } from './types.js';

const DEEPGRAM_STREAMING_URL = 'wss://api.deepgram.com/v1/listen';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

type WsConstructor = new (url: string | URL) => WebSocket;

export type DeepgramSttOpts = {
  apiKey: string;
  sampleRate: number;
  log: LoggerLike;
  /** Override WebSocket constructor for testing. */
  wsConstructor?: WsConstructor;
};

export class DeepgramSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly sampleRate: number;
  private readonly log: LoggerLike;
  private readonly WsCtor: WsConstructor;

  private ws: WebSocket | null = null;
  private callback: ((result: TranscriptionResult) => void) | null = null;
  private state: 'idle' | 'starting' | 'open' | 'stopped' = 'idle';
  private retryCount = 0;

  constructor(opts: DeepgramSttOpts) {
    if (typeof globalThis.WebSocket === 'undefined' && !opts.wsConstructor) {
      throw new Error(
        'globalThis.WebSocket is not available. ' +
          'Node 22+ includes WebSocket natively. ' +
          'Upgrade to Node 22+ or pass a wsConstructor option.',
      );
    }
    this.apiKey = opts.apiKey;
    this.sampleRate = opts.sampleRate;
    this.log = opts.log;
    this.WsCtor = opts.wsConstructor ?? globalThis.WebSocket;
  }

  async start(): Promise<void> {
    if (this.state === 'open' || this.state === 'starting') return;
    this.state = 'starting';
    this.retryCount = 0;
    await this.connect();
  }

  feedAudio(frame: AudioFrame): void {
    if (this.state !== 'open') {
      throw new Error('Cannot feedAudio before start() or after stop()');
    }
    this.ws!.send(frame.buffer);
  }

  onTranscription(callback: (result: TranscriptionResult) => void): void {
    this.callback = callback;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this.state = 'stopped';

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
    }
    this.ws = null;
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      token: this.apiKey,
    });
    return `${DEEPGRAM_STREAMING_URL}?${params.toString()}`;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const ws = new this.WsCtor(url);
      this.ws = ws;

      ws.onopen = () => {
        this.state = 'open';
        this.log.info({ url: DEEPGRAM_STREAMING_URL }, 'Deepgram STT connected');
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      ws.onerror = (event: Event) => {
        this.log.error({ error: event }, 'Deepgram STT WebSocket error');
      };

      ws.onclose = (event: CloseEvent) => {
        if (this.state === 'stopped') return;

        // If we were still in the initial connect, reject
        if (this.state === 'starting') {
          reject(new Error(`WebSocket closed during connect: code=${event.code}`));
          return;
        }

        this.handleUnexpectedClose();
      };
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.callback) return;
    try {
      const data = JSON.parse(String(event.data));
      const alt = data?.channel?.alternatives?.[0];
      if (!alt) return;

      const result: TranscriptionResult = {
        text: alt.transcript ?? '',
        confidence: alt.confidence,
        isFinal: Boolean(data.is_final && data.speech_final),
      };
      this.callback(result);
    } catch (err) {
      this.log.error({ err }, 'Failed to parse Deepgram STT message');
    }
  }

  private handleUnexpectedClose(): void {
    if (this.retryCount >= MAX_RETRIES) {
      this.log.error(
        { retries: this.retryCount },
        'Deepgram STT exhausted reconnect retries',
      );
      this.state = 'stopped';
      return;
    }

    this.retryCount++;
    const delay = BASE_BACKOFF_MS * 2 ** (this.retryCount - 1);
    this.log.warn(
      { attempt: this.retryCount, maxRetries: MAX_RETRIES, delayMs: delay },
      'Deepgram STT reconnecting after unexpected close',
    );

    setTimeout(() => {
      if (this.state === 'stopped') return;
      this.state = 'starting';
      this.connect().catch((err) => {
        this.log.error({ err }, 'Deepgram STT reconnect failed');
        this.handleUnexpectedClose();
      });
    }, delay);
  }
}
