import WebSocket from 'ws';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, SttProvider, TranscriptionResult } from './types.js';

const DEEPGRAM_STREAMING_URL = 'wss://api.deepgram.com/v1/listen';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export type DeepgramSttOpts = {
  apiKey: string;
  sampleRate: number;
  log: LoggerLike;
  /** Deepgram STT model name. Defaults to 'nova-3-general'. */
  model?: string;
  /** Override WebSocket constructor for testing. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
};

export class DeepgramSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly sampleRate: number;
  private readonly model: string;
  private readonly log: LoggerLike;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => WebSocket;

  private ws: WebSocket | null = null;
  private callback: ((result: TranscriptionResult) => void) | null = null;
  private state: 'idle' | 'starting' | 'open' | 'stopped' = 'idle';
  private retryCount = 0;
  private feedCount = 0;

  constructor(opts: DeepgramSttOpts) {
    this.apiKey = opts.apiKey;
    this.sampleRate = opts.sampleRate;
    this.model = opts.model ?? 'nova-3-general';
    this.log = opts.log;
    this.wsFactory =
      opts.wsFactory ?? ((url, headers) => new WebSocket(url, { headers }));
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
    this.feedCount++;
    if (this.feedCount === 1 || this.feedCount % 100 === 0) {
      this.log.info({ feedCount: this.feedCount, bufferSize: frame.buffer.length }, 'stt:feedAudio');
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
      model: this.model,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
    });
    return `${DEEPGRAM_STREAMING_URL}?${params.toString()}`;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const ws = this.wsFactory(url, {
        Authorization: `Token ${this.apiKey}`,
      });
      this.ws = ws;

      ws.on('open', () => {
        this.state = 'open';
        this.log.info({ url: DEEPGRAM_STREAMING_URL }, 'Deepgram STT connected');
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      ws.on('error', (err: Error) => {
        this.log.error({ err: err.message }, 'Deepgram STT WebSocket error');
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (this.state === 'stopped') return;

        // If we were still in the initial connect, reject
        if (this.state === 'starting') {
          reject(
            new Error(
              `WebSocket closed during connect: code=${code} reason=${reason.toString()}`,
            ),
          );
          return;
        }

        this.handleUnexpectedClose();
      });
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(String(data));

      // Log all Deepgram messages for debugging
      const alt = parsed?.channel?.alternatives?.[0];
      const transcript = alt?.transcript ?? '';
      this.log.info(
        {
          type: parsed.type,
          isFinal: parsed.is_final,
          speechFinal: parsed.speech_final,
          transcript: transcript.slice(0, 80),
        },
        'stt:deepgram message',
      );

      if (!this.callback) return;
      if (!alt) return;

      const result: TranscriptionResult = {
        text: transcript,
        confidence: alt.confidence,
        isFinal: Boolean(parsed.is_final && parsed.speech_final),
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
