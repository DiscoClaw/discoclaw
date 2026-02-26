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
  /** Override TTS provider creation for testing. */
  createTts?: (config: VoiceConfig, log: LoggerLike) => TtsProvider;
};

type GuildPipeline = {
  sttProvider: SttProvider;
  receiver: AudioReceiver;
  responder?: VoiceResponder;
};

// ---------------------------------------------------------------------------
// AudioPipelineManager
// ---------------------------------------------------------------------------

export class AudioPipelineManager {
  private readonly log: LoggerLike;
  private readonly voiceConfig: VoiceConfig;
  private readonly allowedUserIds: Set<string>;
  private readonly createDecoder: OpusDecoderFactory;
  private readonly onTranscription?: (guildId: string, result: TranscriptionResult) => void;
  private readonly createStt: (config: VoiceConfig, log: LoggerLike) => SttProvider;
  private readonly invokeAi?: InvokeAiFn;
  private readonly createTts: (config: VoiceConfig, log: LoggerLike) => TtsProvider;
  private readonly pipelines = new Map<string, GuildPipeline>();

  constructor(opts: AudioPipelineOpts) {
    this.log = opts.log;
    this.voiceConfig = opts.voiceConfig;
    this.allowedUserIds = opts.allowedUserIds;
    this.createDecoder = opts.createDecoder;
    this.onTranscription = opts.onTranscription;
    this.createStt = opts.createStt ?? createSttProvider;
    this.invokeAi = opts.invokeAi;
    this.createTts = opts.createTts ?? createTtsProvider;
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
    // Stop any existing pipeline first
    if (this.pipelines.has(guildId)) {
      this.log.info({ guildId }, 'stopping existing pipeline before restart');
      await this.stopPipeline(guildId);
    }

    try {
      const sttProvider = this.createStt(this.voiceConfig, this.log);

      // Create VoiceResponder for the full conversation loop if invokeAi is configured
      let responder: VoiceResponder | undefined;
      if (this.invokeAi) {
        try {
          const tts = this.createTts(this.voiceConfig, this.log);
          responder = new VoiceResponder({
            log: this.log,
            tts,
            connection,
            invokeAi: this.invokeAi,
          });
          this.log.info({ guildId }, 'voice responder created');
        } catch (err) {
          this.log.error({ guildId, err }, 'failed to create voice responder (continuing without TTS)');
        }
      }

      // Wire transcription callback — fires both the external callback and the responder
      const onTranscriptionCb = this.onTranscription;
      if (onTranscriptionCb || responder) {
        sttProvider.onTranscription((result) => {
          if (onTranscriptionCb) {
            onTranscriptionCb(guildId, result);
          }
          if (responder && result.isFinal && result.text.trim()) {
            responder.handleTranscription(result.text).catch((err) => {
              this.log.error({ guildId, err }, 'voice-responder: handleTranscription failed');
            });
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
      });

      receiver.start();

      this.pipelines.set(guildId, { sttProvider, receiver, responder });
      this.log.info({ guildId }, 'audio pipeline started');
    } catch (err) {
      this.log.error({ guildId, err }, 'failed to start audio pipeline');
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
}
