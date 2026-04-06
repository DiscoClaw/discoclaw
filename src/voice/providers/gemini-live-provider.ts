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
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiFunctionCall,
  type GeminiLiveEvent,
  type GeminiLiveOpts,
  type GeminiLiveState,
  supportsGeminiLiveIncrementalClientContent,
} from './gemini-live-types.js';
import type { GeminiToolsConfig } from './gemini-tool-mapper.js';
import { GeminiLiveTokenEstimator } from './gemini-live-token-estimator.js';

export type { GeminiFunctionCall, GeminiLiveEvent, GeminiLiveOpts, GeminiLiveState } from './gemini-live-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
/** Default session rotation threshold — 13 minutes (Gemini sessions cap at ~15 min). */
const DEFAULT_SESSION_ROTATION_MS = 780_000;
/** Resume handles are valid for ~2 minutes server-side; expire locally at 90s to avoid racing. */
const RESUME_HANDLE_TTL_MS = 90_000;

type GeminiFunctionResponseScheduling = 'INTERRUPT' | 'WHEN_IDLE' | 'SILENT';

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
  private readonly tokenEstimator: GeminiLiveTokenEstimator;
  /** Tool call IDs dispatched in the current session but not yet responded to. */
  private readonly inflightToolCalls = new Set<string>();

  constructor(opts: GeminiLiveOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_GEMINI_LIVE_MODEL;
    this.log = opts.log;
    this.systemInstruction = opts.systemInstruction;
    this.responseModalities = opts.responseModalities ?? ['AUDIO'];
    this.voiceName = opts.voiceName;
    this.tools = opts.tools;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.sessionRotationMs = opts.sessionRotationMs ?? DEFAULT_SESSION_ROTATION_MS;
    this.tokenEstimator = new GeminiLiveTokenEstimator(opts.tokenBudget);
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
    this.tokenEstimator.addInputAudio(pcm.length);
    this.checkTokenThreshold();
    this.ws!.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcm.toString('base64'),
        },
      },
    }));
  }

  /** Signal that the current realtime audio stream has ended so Gemini can flush buffered input. */
  sendAudioStreamEnd(): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendAudioStreamEnd before connect() completes or after disconnect()');
    }
    this.ws!.send(JSON.stringify({
      realtimeInput: {
        audioStreamEnd: true,
      },
    }));
  }

  /** Send a text message to the session. */
  sendText(text: string): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendText before connect() completes or after disconnect()');
    }
    this.tokenEstimator.addText(text);
    this.checkTokenThreshold();
    if (supportsGeminiLiveIncrementalClientContent(this.model)) {
      this.ws!.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }));
      return;
    }
    this.ws!.send(JSON.stringify({
      realtimeInput: {
        text,
      },
    }));
  }

  /**
   * Send tool execution results back to the session.
   * Each response is matched to its original function call by `id`.
   * Silently drops responses for IDs that are no longer in-flight
   * (e.g. from a previous session after rotation).
   */
  sendToolResponse(
    responses: Array<{ id: string; name: string; output: string; scheduling?: GeminiFunctionResponseScheduling }>,
  ): void {
    if (this._state !== 'open') {
      throw new Error('Cannot sendToolResponse before connect() completes or after disconnect()');
    }

    // Filter to only in-flight calls — stale responses from a previous session are dropped
    const valid = responses.filter((r) => {
      if (this.inflightToolCalls.has(r.id)) {
        this.inflightToolCalls.delete(r.id);
        this.tokenEstimator.addToolResponse(r.output);
        return true;
      }
      this.log.warn({ id: r.id }, 'Gemini Live: dropping stale tool response (not in-flight)');
      return false;
    });

    if (valid.length === 0) return;

    this.checkTokenThreshold();
    this.ws!.send(JSON.stringify({
      toolResponse: {
        functionResponses: valid.map((r) => ({
          id: r.id,
          name: r.name,
          response: {
            result: r.output,
            ...(r.scheduling ? { scheduling: r.scheduling } : {}),
          },
        })),
      },
    }));
  }

  /** Disconnect the session and release resources. */
  async disconnect(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'idle') return;
    this._state = 'stopped';
    this.cancelRotationTimer();
    this.inflightToolCalls.clear();
    this.tokenEstimator.reset();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client disconnect');
    }
    this.ws = null;
  }

  /** Number of tool calls currently in-flight (dispatched but not yet responded). */
  get inflightToolCallCount(): number {
    return this.inflightToolCalls.size;
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
      contextWindowCompression: { slidingWindow: {} },
      realtimeInputConfig: {
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (this.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: this.systemInstruction }],
      };
    }

    if (this.tools) {
      setup.tools = [this.tools];
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
        this.tokenEstimator.reset();
        this.inflightToolCalls.clear();
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
        }

        // Input audio transcription (server-side STT of user speech)
        const inputTranscription = this.extractTranscriptionText(sc.inputTranscription);
        if (inputTranscription) {
          this.emit({ type: 'input_transcript', text: inputTranscription });
        }

        // Output transcription mirrors audio-only model replies without requiring TEXT modality.
        // Do not count these as text tokens; the audio output is already accounted separately.
        const outputTranscription = this.extractTranscriptionText(sc.outputTranscription);
        if (outputTranscription) {
          this.emit({ type: 'text', text: outputTranscription });
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
                const buf = Buffer.from(inline.data, 'base64');
                this.tokenEstimator.addOutputAudio(buf.length);
                this.emit({ type: 'audio', data: buf });
              }
            }
            if (typeof part.text === 'string') {
              this.tokenEstimator.addText(part.text as string);
              this.emit({ type: 'text', text: part.text as string });
            }
          }
          this.checkTokenThreshold();
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
          // Track in-flight IDs and estimate tokens
          for (const call of calls) {
            this.inflightToolCalls.add(call.id);
            this.tokenEstimator.addToolCall(call.name, call.args);
          }
          this.log.info(
            { count: calls.length, names: calls.map((c) => c.name).join(','), inflight: this.inflightToolCalls.size },
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
    this.inflightToolCalls.clear();
    if (this.retryCount >= MAX_RETRIES) {
      this.log.error(
        { retries: this.retryCount },
        'Gemini Live exhausted reconnect retries',
      );
      this._state = 'stopped';
      this.emit({ type: 'reconnect_failed', attempts: this.retryCount });
      this.emit({ type: 'fallback_recommended', reason: 'exhausted reconnect retries' });
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
    const sessionAgeMs = Date.now() - this.sessionStartedAt;
    this.log.info({ sessionAgeMs }, 'Gemini Live session rotation — initiating graceful reconnect');
    this.emit({ type: 'session_rotating', sessionAgeMs });
    // Close the WebSocket; handleUnexpectedClose will reconnect with the resume handle.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'session rotation');
    }
  }

  /** Check token thresholds and emit warnings when newly crossed. */
  private checkTokenThreshold(): void {
    const threshold = this.tokenEstimator.checkThreshold();
    if (threshold) {
      const est = this.tokenEstimator.estimate;
      this.log.warn(
        { threshold, estimatedTokens: est.total, text: est.textTokens, audio: est.audioTokens, tool: est.toolTokens },
        'Gemini Live token threshold crossed',
      );
      this.emit({ type: 'token_warning', estimatedTokens: est.total, threshold });

      // At the compress threshold, proactively trigger session rotation
      // to prevent server-side sliding window from silently dropping context.
      if (threshold === 'compress' && this._state === 'open') {
        this.log.info({ estimatedTokens: est.total }, 'Gemini Live: compress threshold reached — initiating proactive rotation');
        this.initiateGracefulReconnect();
      }
    }
  }

  private emit(event: GeminiLiveEvent): void {
    this.listener?.(event);
  }

  private extractTranscriptionText(value: unknown): string | null {
    if (value == null || typeof value !== 'object') return null;
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' && text !== '' ? text : null;
  }
}
