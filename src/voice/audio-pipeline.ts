/**
 * Per-guild audio pipeline orchestrator — bridges the VoiceConnectionManager
 * with the AudioReceiver and SttProvider components.
 *
 * When attached to a VoiceConnection, it automatically:
 *  - Starts the STT provider + AudioReceiver when the connection reaches Ready
 *  - Stops and cleans up both when the connection is Destroyed
 */

import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { LoggerLike } from '../logging/logger-like.js';
import type { SttProvider, TtsProvider, TranscriptionResult, VoiceConfig } from './types.js';
import { AudioReceiver, type OpusDecoderFactory } from './audio-receiver.js';
import { createSttProvider } from './stt-factory.js';
import { createTtsProvider } from './tts-factory.js';
import { VoiceResponder, type InvokeAiFn } from './voice-responder.js';
import type { TranscriptMirrorLike } from './transcript-mirror.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioPipelineOpts = {
  log: LoggerLike;
  voiceConfig: VoiceConfig;
  allowedUserIds: Set<string>;
  createDecoder: OpusDecoderFactory;
  /** Optional callback for transcription results (all guilds). */
  onTranscription?: (guildId: string, result: TranscriptionResult) => void;
  /** Override STT provider creation for testing. */
  createStt?: (config: VoiceConfig, log: LoggerLike) => SttProvider;
  /** AI runtime invocation for voice responses. When provided, enables the full conversation loop. */
  invokeAi?: InvokeAiFn;
  /** AI runtime identifier (e.g. 'claude-code', 'openai'). Gates voice-response creation. */
  runtime?: string;
  /** Model to use for the AI runtime. */
  runtimeModel?: string;
  /** Working directory for the AI runtime. */
  runtimeCwd?: string;
  /** Timeout in milliseconds for AI runtime invocations. */
  runtimeTimeoutMs?: number;
  /** Override TTS provider creation for testing. */
  createTts?: (config: VoiceConfig, log: LoggerLike) => TtsProvider;
  /** Optional transcript mirror for posting voice conversation text to a Discord channel. */
  transcriptMirror?: TranscriptMirrorLike;
  /** Bot display name for transcript mirror messages. */
  botDisplayName?: string;
};

type GuildPipeline = {
  connection: VoiceConnection;
  sttProvider: SttProvider;
  receiver: AudioReceiver;
  responder?: VoiceResponder;
};

// ---------------------------------------------------------------------------
// AudioPipelineManager
// ---------------------------------------------------------------------------

export class AudioPipelineManager {
  private readonly log: LoggerLike;
  private voiceConfig: VoiceConfig;
  private readonly allowedUserIds: Set<string>;
  private readonly createDecoder: OpusDecoderFactory;
  private readonly onTranscription?: (guildId: string, result: TranscriptionResult) => void;
  private readonly createStt: (config: VoiceConfig, log: LoggerLike) => SttProvider;
  private readonly invokeAi?: InvokeAiFn;
  private readonly runtime?: string;
  private readonly runtimeModel?: string;
  private readonly runtimeCwd?: string;
  private readonly runtimeTimeoutMs?: number;
  private readonly createTts: (config: VoiceConfig, log: LoggerLike) => TtsProvider;
  private readonly transcriptMirror?: TranscriptMirrorLike;
  private readonly botDisplayName: string;
  private readonly pipelines = new Map<string, GuildPipeline>();
  /** Re-entrancy guard: VoiceConnection.subscribe() can synchronously fire stateChange→Ready. */
  private readonly starting = new Set<string>();

  constructor(opts: AudioPipelineOpts) {
    this.log = opts.log;
    this.voiceConfig = opts.voiceConfig;
    this.allowedUserIds = opts.allowedUserIds;
    this.createDecoder = opts.createDecoder;
    this.onTranscription = opts.onTranscription;
    this.createStt = opts.createStt ?? createSttProvider;
    this.invokeAi = opts.invokeAi;
    this.runtime = opts.runtime;
    this.runtimeModel = opts.runtimeModel;
    this.runtimeCwd = opts.runtimeCwd;
    this.runtimeTimeoutMs = opts.runtimeTimeoutMs;
    this.createTts = opts.createTts ?? createTtsProvider;
    this.transcriptMirror = opts.transcriptMirror;
    this.botDisplayName = opts.botDisplayName ?? 'Bot';
  }

  /**
   * Attach to a VoiceConnection and auto-manage the audio pipeline
   * based on connection state transitions.
   */
  attach(guildId: string, connection: VoiceConnection): void {
    this.log.info({ guildId }, 'attaching audio pipeline to voice connection');

    connection.on('stateChange', async (_oldState, newState) => {
      const status = newState.status;

      if (status === VoiceConnectionStatus.Ready) {
        await this.startPipeline(guildId, connection);
      }

      if (status === VoiceConnectionStatus.Destroyed) {
        await this.stopPipeline(guildId);
      }
    });
  }

  /** Start the audio receive pipeline for a guild. */
  async startPipeline(guildId: string, connection: VoiceConnection): Promise<void> {
    // Re-entrancy guard: VoiceConnection.subscribe() (called when wiring the
    // AudioPlayer) synchronously fires a stateChange→Ready event, which would
    // re-invoke startPipeline and recurse infinitely.
    if (this.starting.has(guildId)) return;
    this.starting.add(guildId);

    // Stop any existing pipeline first
    if (this.pipelines.has(guildId)) {
      this.log.info({ guildId }, 'stopping existing pipeline before restart');
      await this.stopPipeline(guildId);
    }

    try {
      const sttProvider = this.createStt(this.voiceConfig, this.log);
      const mirror = this.transcriptMirror;

      // Create VoiceResponder for the full conversation loop if invokeAi is configured
      let responder: VoiceResponder | undefined;
      if (this.invokeAi) {
        try {
          const tts = this.createTts(this.voiceConfig, this.log);
          const botName = this.botDisplayName;
          responder = new VoiceResponder({
            log: this.log,
            tts,
            connection,
            invokeAi: this.invokeAi,
            onBotResponse: mirror
              ? (text) => {
                  mirror.postBotResponse(botName, text).catch((err) => {
                    this.log.warn({ guildId, err }, 'transcript-mirror: failed to post bot response');
                  });
                }
              : undefined,
          });
          this.log.info({ guildId }, 'voice responder created');
        } catch (err) {
          this.log.warn({ guildId, err }, 'failed to create voice responder — continuing with STT-only mode');
        }
      }

      // Wire transcription callback — fires the external callback, transcript mirror, and responder
      const onTranscriptionCb = this.onTranscription;
      if (onTranscriptionCb || responder || mirror) {
        sttProvider.onTranscription((result) => {
          if (onTranscriptionCb) {
            onTranscriptionCb(guildId, result);
          }
          // STT-confirmed barge-in: any transcription (interim or final) with
          // non-empty text stops ongoing playback. Echo produces empty
          // transcriptions; real speech produces non-empty ones.
          if (result.text.trim() && responder?.isPlaying) {
            this.log.info({ guildId }, 'barge-in detected');
            responder.stop();
          }
          if (result.isFinal && result.text.trim()) {
            if (mirror) {
              mirror.postUserTranscription('User', result.text).catch((err) => {
                this.log.warn({ guildId, err }, 'transcript-mirror: failed to post user transcription');
              });
            }
            if (responder) {
              responder.handleTranscription(result.text).catch((err) => {
                this.log.error({ guildId, err }, 'voice-responder: handleTranscription failed');
              });
            }
          }
        });
      }

      await sttProvider.start();

      const receiver = new AudioReceiver({
        connection,
        allowedUserIds: this.allowedUserIds,
        sttProvider,
        log: this.log,
        createDecoder: this.createDecoder,
        onUserSpeaking: (_userId) => {
          // Barge-in is now gated on STT transcription (see onTranscription
          // callback above). This callback is kept for AudioReceiver
          // subscription management.
        },
      });

      receiver.start();

      this.pipelines.set(guildId, { connection, sttProvider, receiver, responder });
      this.log.info({ guildId }, 'audio pipeline started');
    } catch (err) {
      this.log.error({ guildId, err }, 'failed to start audio pipeline');
    } finally {
      this.starting.delete(guildId);
    }
  }

  /** Stop and clean up the audio pipeline for a guild. */
  async stopPipeline(guildId: string): Promise<void> {
    const pipeline = this.pipelines.get(guildId);
    if (!pipeline) return;

    this.pipelines.delete(guildId);

    pipeline.responder?.destroy();
    pipeline.receiver.stop();

    try {
      await pipeline.sttProvider.stop();
    } catch (err) {
      this.log.error({ guildId, err }, 'error stopping STT provider');
    }

    this.log.info({ guildId }, 'audio pipeline stopped');
  }

  /** Stop all active pipelines. */
  async stopAll(): Promise<void> {
    const guildIds = [...this.pipelines.keys()];
    await Promise.all(guildIds.map((id) => this.stopPipeline(id)));
  }

  /** Whether a pipeline is active for a guild. */
  hasPipeline(guildId: string): boolean {
    return this.pipelines.has(guildId);
  }

  /** Number of active pipelines. */
  get activePipelineCount(): number {
    return this.pipelines.size;
  }

  /** Current Deepgram TTS voice model name. */
  get ttsVoice(): string | undefined {
    return this.voiceConfig.deepgramTtsVoice;
  }

  /**
   * Update the Deepgram TTS voice and restart all active pipelines so the
   * new voice takes effect immediately.
   * @returns The number of pipelines that were restarted.
   */
  async setTtsVoice(voice: string): Promise<number> {
    this.voiceConfig = { ...this.voiceConfig, deepgramTtsVoice: voice };
    this.log.info({ voice }, 'TTS voice updated — restarting active pipelines');

    const entries = [...this.pipelines.entries()];
    await Promise.all(entries.map(([guildId, pipeline]) => this.startPipeline(guildId, pipeline.connection)));
    return entries.length;
  }
}
