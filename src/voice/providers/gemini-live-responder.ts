/**
 * GeminiLiveResponder — Discord audio output bridge for the Gemini Live voice path.
 *
 * Phase 1.2: receives audio/text events from GeminiLiveProvider, upsamples
 * audio to Discord's 48 kHz stereo format, manages an AudioPlayer + PassThrough
 * stream pipeline, and handles barge-in via Gemini's interrupted/turn_complete events.
 */

import { PassThrough } from 'node:stream';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import type { LoggerLike } from '../../logging/logger-like.js';
import type { GeminiLiveProvider } from './gemini-live-provider.js';
import type { GeminiFunctionCall, GeminiLiveEvent } from './gemini-live-types.js';
import { upsampleToDiscord } from '../voice-responder.js';

// Gemini Live returns 24 kHz mono PCM s16le
const GEMINI_OUTPUT_RATE = 24_000;
const GEMINI_OUTPUT_CHANNELS = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeminiLiveResponderOpts = {
  log: LoggerLike;
  connection: VoiceConnection;
  provider: GeminiLiveProvider;
  /** Called with accumulated transcript text when a turn completes. */
  onBotResponse?: (text: string) => void;
  /** Called when Gemini requests tool execution. */
  onToolCall?: (calls: GeminiFunctionCall[]) => void;
  /** Override for testing — supply a custom AudioPlayer factory. */
  createPlayer?: () => AudioPlayer;
};

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export class GeminiLiveResponder {
  private readonly log: LoggerLike;
  private readonly connection: VoiceConnection;
  private readonly provider: GeminiLiveProvider;
  private readonly onBotResponse?: (text: string) => void;
  private readonly onToolCall?: (calls: GeminiFunctionCall[]) => void;
  private readonly playerFactory: () => AudioPlayer;

  private player: AudioPlayer | null = null;
  private stream: PassThrough | null = null;
  private transcript = '';
  private started = false;

  constructor(opts: GeminiLiveResponderOpts) {
    this.log = opts.log;
    this.connection = opts.connection;
    this.provider = opts.provider;
    this.onBotResponse = opts.onBotResponse;
    this.onToolCall = opts.onToolCall;
    this.playerFactory = opts.createPlayer ?? (() => createAudioPlayer());
  }

  /** Create the player, subscribe to the connection, and listen for provider events. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.player = this.playerFactory();
    const subscription = this.connection.subscribe(this.player);
    this.log.info(
      { subscribed: !!subscription },
      'gemini-live-responder: player subscription result',
    );

    this.player.on('stateChange', (oldState, newState) => {
      this.log.info(
        { from: oldState.status, to: newState.status },
        'gemini-live-responder: player state change',
      );
    });

    this.player.on('error', (err: Error) => {
      this.log.error({ err }, 'gemini-live-responder: audio player error');
    });

    this.provider.onEvent((event) => this.handleEvent(event));
  }

  /** Whether the bot is audibly speaking (Playing or Buffering). */
  get isPlaying(): boolean {
    if (!this.player) return false;
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  /** Stop playback and tear down the stream. */
  stop(): void {
    this.destroyStream();
    this.player?.stop();
    this.transcript = '';
  }

  /** Stop and release all resources. */
  destroy(): void {
    this.stop();
    this.started = false;
    this.player = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleEvent(event: GeminiLiveEvent): void {
    switch (event.type) {
      case 'audio':
        this.handleAudio(event.data);
        break;
      case 'text':
        this.transcript += event.text;
        break;
      case 'interrupted':
        this.handleInterrupted();
        break;
      case 'turn_complete':
        this.handleTurnComplete();
        break;
      case 'tool_call':
        this.handleToolCall(event.functionCalls);
        break;
      default:
        // setup_complete, error — not handled here
        break;
    }
  }

  private handleAudio(data: Buffer): void {
    // Lazily create the stream + resource on the first audio chunk of a turn
    if (!this.stream) {
      this.stream = new PassThrough();
      const resource = createAudioResource(this.stream, {
        inputType: StreamType.Raw,
      });
      this.player!.play(resource);
      this.log.info({}, 'gemini-live-responder: streaming playback started');
    }

    const upsampled = upsampleToDiscord(data, GEMINI_OUTPUT_RATE, GEMINI_OUTPUT_CHANNELS);
    this.stream.write(upsampled);
  }

  private handleInterrupted(): void {
    this.log.info({}, 'gemini-live-responder: interrupted — stopping playback');
    this.destroyStream();
    this.player?.stop();
    this.transcript = '';
  }

  private handleToolCall(calls: GeminiFunctionCall[]): void {
    this.log.info(
      { count: calls.length, names: calls.map((c) => c.name).join(',') },
      'gemini-live-responder: tool call received',
    );
    if (this.onToolCall) {
      try {
        this.onToolCall(calls);
      } catch (err) {
        this.log.warn({ err }, 'gemini-live-responder: onToolCall callback error');
      }
    }
  }

  private handleTurnComplete(): void {
    this.log.info({}, 'gemini-live-responder: turn complete');

    // End the stream gracefully so remaining buffered audio plays out
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    // Fire the transcript callback
    const text = this.transcript;
    this.transcript = '';
    if (text) {
      try {
        this.onBotResponse?.(text);
      } catch (err) {
        this.log.warn({ err }, 'gemini-live-responder: onBotResponse callback error');
      }
    }
  }

  private destroyStream(): void {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
  }
}
