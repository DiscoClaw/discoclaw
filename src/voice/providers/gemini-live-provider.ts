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
import type { GeminiFunctionCall, GeminiLiveEvent, GeminiLiveOpts, GeminiLiveState } from './gemini-live-types.js';
import type { GeminiToolsConfig } from './gemini-tool-mapper.js';

export type { GeminiFunctionCall, GeminiLiveEvent, GeminiLiveOpts, GeminiLiveState } from './gemini-live-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
/** Default session rotation threshold — 13 minutes (Gemini sessions cap at ~15 min). */
const DEFAULT_SESSION_ROTATION_MS = 780_000;
/** Resume handles are valid for ~2 minutes server-side; expire locally at 90s to avoid racing. */
const RESUME_HANDLE_TTL_MS = 90_000;

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
  private readonly tools?: GeminiToolsConfig;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly sessionRotationMs: number;

  private ws: WebSocket | null = null;
  private _state: GeminiLiveState = 'idle';
  private retryCount = 0;
  private resumeHandle: string | null = null;
  private resumeHandleUpdatedAt = 0;
  private listener: ((event: GeminiLiveEvent) => void) | null = null;
  private sessionStartedAt = 0;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GeminiLiveOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.log = opts.log;
    this.systemInstruction = opts.systemInstruction;
    this.responseModalities = opts.responseModalities ?? ['AUDIO'];
    this.voiceName = opts.voiceName;
    this.tools = opts.tools;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.sessionRotationMs = opts.sessionRotationMs ?? DEFAULT_SESSION_ROTATION_MS;
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

  /**
   * Send tool execution results back to the session.
   * Each response is matched to its original function call by `id`.
   */
  sendToolResponse(responses: Array<{ id: string; output: string }>): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendToolResponse before connect() completes or after disconnect()');
    }
    this.ws!.send(JSON.stringify({
      toolResponse: {
        functionResponses: responses.map((r) => ({
          id: r.id,
          response: { output: r.output },
        })),
      },
    }));
  }

  /** Disconnect the session and release resources. */
  async disconnect(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'idle') return;
    this._state = 'stopped';
    this.cancelRotationTimer();
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
      contextWindowCompression: { slidingWindow: {} },
    };
    if (this.voiceName) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
      };
    }

    const setup: Record<string, unknown> = {
      model: `models/${this.model}`,
      generationConfig,
      realtimeInputConfig: {
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
    };

    if (this.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: this.systemInstruction }],
      };
    }

    if (this.tools) {
      setup.tools = [this.tools];
      // NON_BLOCKING: model continues generating audio/text while tools execute.
      // The client sends toolResponse asynchronously when results are ready.
      setup.toolConfig = {
        functionCallingConfig: { mode: 'AUTO' },
      };
    }

    if (this.resumeHandle) {
      const age = Date.now() - this.resumeHandleUpdatedAt;
      if (age < RESUME_HANDLE_TTL_MS) {
        setup.sessionResumption = { handle: this.resumeHandle };
      } else {
        this.log.warn({ ageMs: age, ttlMs: RESUME_HANDLE_TTL_MS }, 'Gemini Live resume handle expired — starting fresh session');
        this.resumeHandle = null;
      }
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
        if (this._state === 'stopped') {
          reject(new Error('Gemini Live WebSocket closed: disconnect() called'));
          return;
        }

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
        const wasReconnect = this.retryCount > 0;
        const attempt = this.retryCount;
        this._state = 'open';
        this.retryCount = 0;
        this.sessionStartedAt = Date.now();
        this.scheduleRotation();
        this.log.info('Gemini Live session setup complete');
        if (wasReconnect) {
          this.emit({ type: 'reconnected', attempt });
        }
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

      // Tool call from server — model wants to invoke a function
      if (parsed.toolCall != null) {
        const tc = parsed.toolCall as { functionCalls?: Array<Record<string, unknown>> };
        if (Array.isArray(tc.functionCalls) && tc.functionCalls.length > 0) {
          const calls: GeminiFunctionCall[] = tc.functionCalls.map((fc) => ({
            id: String(fc.id ?? ''),
            name: String(fc.name ?? ''),
            args: (fc.args as Record<string, unknown>) ?? {},
          }));
          this.log.info(
            { count: calls.length, names: calls.map((c) => c.name).join(',') },
            'Gemini Live tool call received',
          );
          this.emit({ type: 'tool_call', functionCalls: calls });
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

      // Session resumption update — store handle for reconnection
      if (parsed.sessionResumptionUpdate != null) {
        const update = parsed.sessionResumptionUpdate as { newHandle?: string };
        if (update.newHandle) {
          this.resumeHandle = update.newHandle;
          this.resumeHandleUpdatedAt = Date.now();
          this.log.info('Gemini Live session resume handle updated');
        }
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
    this.cancelRotationTimer();
    if (this.retryCount >= MAX_RETRIES) {
      this.log.error(
        { retries: this.retryCount },
        'Gemini Live exhausted reconnect retries',
      );
      this._state = 'stopped';
      this.emit({ type: 'reconnect_failed', attempts: this.retryCount });
      this.emit({ type: 'error', error: 'exhausted reconnect retries' });
      return;
    }

    this.retryCount++;
    const delay = BASE_BACKOFF_MS * 2 ** (this.retryCount - 1);
    this.log.warn(
      { attempt: this.retryCount, maxRetries: MAX_RETRIES, delayMs: delay },
      'Gemini Live reconnecting after unexpected close',
    );
    this.emit({
      type: 'reconnecting',
      attempt: this.retryCount,
      maxRetries: MAX_RETRIES,
      hasResumeHandle: this.resumeHandle != null && (Date.now() - this.resumeHandleUpdatedAt) < RESUME_HANDLE_TTL_MS,
    });

    setTimeout(() => {
      if (this._state === 'stopped') return;
      this._state = 'connecting';
      this.doConnect().catch((err) => {
        this.log.error({ err }, 'Gemini Live reconnect failed');
        this.handleUnexpectedClose();
      });
    }, delay);
  }

  private scheduleRotation(): void {
    this.cancelRotationTimer();
    if (!this.sessionRotationMs) return;
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      this.initiateGracefulReconnect();
    }, this.sessionRotationMs);
  }

  private cancelRotationTimer(): void {
    if (this.rotationTimer != null) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  private initiateGracefulReconnect(): void {
    if (this._state !== 'open') return;
    this.log.info({ sessionAgeMs: Date.now() - this.sessionStartedAt }, 'Gemini Live session rotation — initiating graceful reconnect');
    this.emit({ type: 'session_rotating', sessionAgeMs: Date.now() - this.sessionStartedAt });
    // Close the WebSocket; handleUnexpectedClose will reconnect with the resume handle.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'session rotation');
    }
  }

  private emit(event: GeminiLiveEvent): void {
    this.listener?.(event);
  }
}
