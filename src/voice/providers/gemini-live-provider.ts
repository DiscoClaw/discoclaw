/**
 * GeminiLiveProvider — bidirectional WebSocket session wrapper for the
 * Gemini Multimodal Live API.
 *
 * Phase 1.1: standalone session management with a clean interface.
 * Phase 1.2 (GeminiLiveResponder) and Phase 1.3 (pipeline integration)
 * will consume this class.
 *
 * The provider manages:
 * - WebSocket connection lifecycle (connect / disconnect)
 * - Session setup (model, generation config, system instruction)
 * - Sending audio input (PCM → base64-encoded chunks)
 * - Receiving server events (audio output, text, turn completion, errors)
 * - Reconnection with exponential backoff
 *
 * Audio format: Gemini Live expects 16 kHz mono PCM s16le input and
 * returns 24 kHz mono PCM s16le output (configurable via responseModalities).
 */

import WebSocket from 'ws';
import type { LoggerLike } from '../../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeminiLiveState = 'idle' | 'connecting' | 'setup' | 'open' | 'stopped';

export type GeminiLiveEvent =
  | { type: 'audio'; data: Buffer }
  | { type: 'text'; text: string }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'setup_complete' }
  | { type: 'error'; error: string };

export type GeminiLiveOpts = {
  apiKey: string;
  log: LoggerLike;
  /** Model ID. Defaults to 'gemini-2.0-flash-live-001'. */
  model?: string;
  /** System instruction text. */
  systemInstruction?: string;
  /** Response modalities. Defaults to ['AUDIO']. */
  responseModalities?: Array<'AUDIO' | 'TEXT'>;
  /** Speech config voice name. */
  voiceName?: string;
  /** Override WebSocket constructor for testing. */
  wsFactory?: (url: string) => WebSocket;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GeminiLiveProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly log: LoggerLike;
  private readonly systemInstruction?: string;
  private readonly responseModalities: Array<'AUDIO' | 'TEXT'>;
  private readonly voiceName?: string;
  private readonly wsFactory: (url: string) => WebSocket;

  private ws: WebSocket | null = null;
  private _state: GeminiLiveState = 'idle';
  private retryCount = 0;
  private listener: ((event: GeminiLiveEvent) => void) | null = null;

  constructor(opts: GeminiLiveOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.log = opts.log;
    this.systemInstruction = opts.systemInstruction;
    this.responseModalities = opts.responseModalities ?? ['AUDIO'];
    this.voiceName = opts.voiceName;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
  }

  /** Current connection state. */
  get state(): GeminiLiveState {
    return this._state;
  }

  /** Register a listener for server events. Only one listener at a time. */
  onEvent(callback: (event: GeminiLiveEvent) => void): void {
    this.listener = callback;
  }

  /** Connect to the Gemini Live API and perform session setup. */
  async connect(): Promise<void> {
    if (this._state === 'open' || this._state === 'connecting' || this._state === 'setup') return;
    this._state = 'connecting';
    this.retryCount = 0;
    await this.doConnect();
  }

  /**
   * Send a chunk of PCM audio to the session.
   * The buffer is base64-encoded and sent as a realtimeInput message.
   */
  sendAudio(pcm: Buffer): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendAudio before connect() completes or after disconnect()');
    }
    this.ws!.send(JSON.stringify({
      realtimeInput: {
        media: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcm.toString('base64'),
        },
      },
    }));
  }

  /** Send a text message to the session. */
  sendText(text: string): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendText before connect() completes or after disconnect()');
    }
    this.ws!.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }

  /** Disconnect the session and release resources. */
  async disconnect(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'idle') return;
    this._state = 'stopped';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client disconnect');
    }
    this.ws = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private buildUrl(): string {
    return `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
  }

  private buildSetupMessage(): object {
    const generationConfig: Record<string, unknown> = {
      responseModalities: this.responseModalities,
    };
    if (this.voiceName) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
      };
    }

    const setup: Record<string, unknown> = {
      model: `models/${this.model}`,
      generationConfig,
    };

    if (this.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: this.systemInstruction }],
      };
    }

    return { setup };
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const ws = this.wsFactory(url);
      this.ws = ws;

      ws.on('open', () => {
        this._state = 'setup';
        this.log.info({ model: this.model }, 'Gemini Live WebSocket connected, sending setup');
        ws.send(JSON.stringify(this.buildSetupMessage()));
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data, resolve);
      });

      ws.on('error', (err: Error) => {
        this.log.error({ err: err.message }, 'Gemini Live WebSocket error');
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (this._state === 'stopped') return;

        if (this._state === 'connecting' || this._state === 'setup') {
          reject(
            new Error(`Gemini Live WebSocket closed during connect: code=${code} reason=${reason.toString()}`),
          );
          return;
        }

        this.handleUnexpectedClose();
      });
    });
  }

  private handleMessage(data: WebSocket.Data, onSetupComplete?: (value: void) => void): void {
    try {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;

      // Setup complete acknowledgement
      if (parsed.setupComplete != null) {
        this._state = 'open';
        this.log.info('Gemini Live session setup complete');
        this.emit({ type: 'setup_complete' });
        onSetupComplete?.();
        return;
      }

      // Server content (audio, text, turn signals)
      if (parsed.serverContent != null) {
        const sc = parsed.serverContent as Record<string, unknown>;

        // Interrupted signal
        if (sc.interrupted === true) {
          this.emit({ type: 'interrupted' });
          return;
        }

        // Turn complete signal
        if (sc.turnComplete === true) {
          this.emit({ type: 'turn_complete' });
        }

        // Model turn with parts
        const modelTurn = sc.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined;
        if (modelTurn?.parts) {
          for (const part of modelTurn.parts) {
            if (part.inlineData != null) {
              const inline = part.inlineData as { data?: string };
              if (inline.data) {
                this.emit({ type: 'audio', data: Buffer.from(inline.data, 'base64') });
              }
            }
            if (typeof part.text === 'string') {
              this.emit({ type: 'text', text: part.text as string });
            }
          }
        }
        return;
      }

      // Error from server
      if (parsed.error != null) {
        const err = parsed.error as { message?: string; code?: number };
        const errMsg = err.message ?? `code ${err.code ?? 'unknown'}`;
        this.log.error({ error: parsed.error }, 'Gemini Live server error');
        this.emit({ type: 'error', error: errMsg });
        return;
      }

      // Unknown message shape — log for debugging
      this.log.warn(
        { keys: Object.keys(parsed).join(',') },
        'Gemini Live: unrecognized message',
      );
    } catch (err) {
      this.log.error({ err }, 'Failed to parse Gemini Live message');
    }
  }

  private handleUnexpectedClose(): void {
    if (this.retryCount >= MAX_RETRIES) {
      this.log.error(
        { retries: this.retryCount },
        'Gemini Live exhausted reconnect retries',
      );
      this._state = 'stopped';
      this.emit({ type: 'error', error: 'exhausted reconnect retries' });
      return;
    }

    this.retryCount++;
    const delay = BASE_BACKOFF_MS * 2 ** (this.retryCount - 1);
    this.log.warn(
      { attempt: this.retryCount, maxRetries: MAX_RETRIES, delayMs: delay },
      'Gemini Live reconnecting after unexpected close',
    );

    setTimeout(() => {
      if (this._state === 'stopped') return;
      this._state = 'connecting';
      this.doConnect().catch((err) => {
        this.log.error({ err }, 'Gemini Live reconnect failed');
        this.handleUnexpectedClose();
      });
    }, delay);
  }

  private emit(event: GeminiLiveEvent): void {
    this.listener?.(event);
  }
}
