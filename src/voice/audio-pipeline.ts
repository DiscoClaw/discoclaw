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
import type { SttProvider, TranscriptionResult, VoiceConfig } from './types.js';
import { AudioReceiver, type OpusDecoderFactory } from './audio-receiver.js';
import { createSttProvider } from './stt-factory.js';

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
};

type GuildPipeline = {
  sttProvider: SttProvider;
  receiver: AudioReceiver;
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
  private readonly pipelines = new Map<string, GuildPipeline>();

  constructor(opts: AudioPipelineOpts) {
    this.log = opts.log;
    this.voiceConfig = opts.voiceConfig;
    this.allowedUserIds = opts.allowedUserIds;
    this.createDecoder = opts.createDecoder;
    this.onTranscription = opts.onTranscription;
    this.createStt = opts.createStt ?? createSttProvider;
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

      if (this.onTranscription) {
        const cb = this.onTranscription;
        sttProvider.onTranscription((result) => cb(guildId, result));
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

      this.pipelines.set(guildId, { sttProvider, receiver });
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
