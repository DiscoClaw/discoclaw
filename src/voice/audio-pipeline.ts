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
import type { SttProvider, TtsProvider, TranscriptionResult, VoiceConfig, VoicePipelineMode } from './types.js';
import { AudioReceiver, type OpusDecoderFactory } from './audio-receiver.js';
import { createSttProvider } from './stt-factory.js';
import { createTtsProvider } from './tts-factory.js';
import { VoiceResponder, type InvokeAiFn } from './voice-responder.js';
import type { TranscriptMirrorLike } from './transcript-mirror.js';
import { ConversationBuffer, type Turn } from './conversation-buffer.js';
import { GeminiLiveProvider } from './providers/gemini-live-provider.js';
import { GeminiLiveResponder } from './providers/gemini-live-responder.js';
import { buildGeminiToolDeclarations, buildToolSchemas } from '../runtime/openai-tool-schemas.js';
import { executeToolCall } from '../runtime/openai-tool-exec.js';

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
  /** Optional async callback that returns initial turn pairs for conversation history backfill on join. */
  backfill?: () => Promise<Turn[]>;
  /** Voice provider mode: 'pipeline' (default STT/TTS) or 'gemini-live' (Gemini Live WebSocket). */
  voiceProvider?: VoicePipelineMode;
  /** API key for Gemini Live (required when voiceProvider is 'gemini-live'). */
  geminiApiKey?: string;
  /** Enabled tool names for Gemini Live tool use (e.g. ['Read', 'Bash']). */
  enabledTools?: string[];
  /** Timer-based session rotation interval in ms for Gemini Live (default 13 min). */
  sessionRotationMs?: number;
  /** Called when a guild's pipeline falls back from gemini-live to standard pipeline mode. */
  onFallbackTriggered?: (guildId: string, toMode: VoicePipelineMode) => void;
};

type GuildPipeline = {
  connection: VoiceConnection;
  sttProvider: SttProvider;
  receiver: AudioReceiver;
  responder?: VoiceResponder;
  buffer?: ConversationBuffer;
  geminiProvider?: GeminiLiveProvider;
  geminiResponder?: GeminiLiveResponder;
  /** Active mode — may differ from the manager's configured mode during fallback. */
  mode: VoicePipelineMode;
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
  private readonly backfill?: () => Promise<Turn[]>;
  private readonly voiceProvider: VoicePipelineMode;
  private readonly geminiApiKey?: string;
  private readonly enabledTools: string[];
  private readonly sessionRotationMs?: number;
  private readonly onFallbackTriggered?: (guildId: string, toMode: VoicePipelineMode) => void;
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
    this.backfill = opts.backfill;
    this.voiceProvider = opts.voiceProvider ?? 'pipeline';
    this.geminiApiKey = opts.geminiApiKey;
    this.enabledTools = opts.enabledTools ?? [];
    this.sessionRotationMs = opts.sessionRotationMs;
    this.onFallbackTriggered = opts.onFallbackTriggered;

    this.log.info({ voiceProvider: this.voiceProvider }, 'audio pipeline manager initialized');
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

  /** Start the audio receive pipeline for a guild. Pass `forceMode` to override the configured provider (used during fallback). */
  async startPipeline(guildId: string, connection: VoiceConnection, forceMode?: VoicePipelineMode): Promise<void> {
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

    const effectiveMode = forceMode ?? this.voiceProvider;

    try {
      // ----- gemini-live mode: skip STT/TTS, use GeminiLiveProvider directly -----
      if (effectiveMode === 'gemini-live') {
        const apiKey = this.geminiApiKey;
        if (!apiKey) throw new Error('geminiApiKey is required for gemini-live voice provider');

        const tools = buildGeminiToolDeclarations(this.enabledTools);
        const provider = new GeminiLiveProvider({
          apiKey,
          log: this.log,
          responseModalities: ['AUDIO', 'TEXT'],
          tools,
          sessionRotationMs: this.sessionRotationMs,
        });
        await provider.connect();

        const mirror = this.transcriptMirror;
        const botName = this.botDisplayName;
        const responder = new GeminiLiveResponder({
          log: this.log,
          connection,
          provider,
          onBotResponse: mirror
            ? (text) => {
                mirror.postBotResponse(botName, text).catch((err) => {
                  this.log.warn({ guildId, err }, 'transcript-mirror: failed to post bot response');
                });
              }
            : undefined,
          onSessionTerminated: () => {
            this.log.error({ guildId }, 'gemini-live session terminally failed — attempting fallback to standard pipeline');
            void this.fallbackToPipeline(guildId, connection);
          },
          onFallbackRecommended: (reason: string) => {
            this.log.warn({ guildId, reason }, 'gemini-live: fallback recommended — switching to standard pipeline');
            void this.fallbackToPipeline(guildId, connection);
          },
          onTokenWarning: (estimatedTokens: number, threshold: 'warn' | 'compress') => {
            this.log.warn({ guildId, estimatedTokens, threshold }, 'gemini-live: token usage approaching context window limit');
          },
          onToolCall: tools
            ? (calls) => {
                this.log.info(
                  { guildId, count: calls.length, names: calls.map((c) => c.name).join(',') },
                  'gemini-live: tool call received — dispatching',
                );
                const allowedRoots = this.runtimeCwd ? [this.runtimeCwd] : [];
                const allowedToolNames = new Set(
                  buildToolSchemas(this.enabledTools).map((t) => t.function.name),
                );
                const logFn = (msg: string) => this.log.info({ guildId }, msg);
                const execOpts = { enableHybridPipeline: false as const, allowedToolNames };

                // Fire-and-forget (NON_BLOCKING) — tools run without pausing audio
                void (async () => {
                  const results = await Promise.all(
                    calls.map(async (call) => {
                      try {
                        const res = await executeToolCall(
                          call.name,
                          call.args,
                          allowedRoots,
                          logFn,
                          execOpts,
                        );
                        return { id: call.id, output: res.result };
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return { id: call.id, output: `Error: ${msg}` };
                      }
                    }),
                  );
                  try {
                    provider.sendToolResponse(results);
                  } catch (err) {
                    this.log.warn(
                      { guildId, err },
                      'gemini-live: sendToolResponse failed (provider likely disconnected)',
                    );
                  }
                })();
              }
            : undefined,
        });
        responder.start();

        // SttProvider shim: bridges AudioReceiver frames to GeminiLiveProvider.sendAudio
        const sttShim: SttProvider = {
          start: async () => {},
          stop: async () => {},
          onTranscription: () => {},
          feedAudio: (frame) => {
            try {
              provider.sendAudio(frame.buffer);
            } catch (err) {
              this.log.warn({ guildId, err }, 'gemini-live: sendAudio error (non-fatal)');
            }
          },
        };

        const receiver = new AudioReceiver({
          connection,
          allowedUserIds: this.allowedUserIds,
          sttProvider: sttShim,
          log: this.log,
          createDecoder: this.createDecoder,
          onUserSpeaking: () => {},
        });

        receiver.start();

        this.pipelines.set(guildId, {
          connection,
          sttProvider: sttShim,
          receiver,
          geminiProvider: provider,
          geminiResponder: responder,
          mode: 'gemini-live',
        });
        this.log.info({ guildId }, 'audio pipeline started (gemini-live)');
        return;
      }

      // ----- default pipeline mode: STT/TTS/VoiceResponder -----
      const sttProvider = this.createStt(this.voiceConfig, this.log);
      const mirror = this.transcriptMirror;

      // Create conversation buffer and backfill history if available
      let buffer: ConversationBuffer | undefined;
      if (this.invokeAi) {
        buffer = new ConversationBuffer();
        if (this.backfill) {
          try {
            const turns = await this.backfill();
            buffer.backfill(turns);
            this.log.info({ guildId, turns: turns.length }, 'conversation buffer backfilled');
          } catch (err) {
            this.log.warn({ guildId, err }, 'conversation backfill failed — proceeding with empty buffer');
          }
        }
      }

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
            buffer,
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

      this.pipelines.set(guildId, { connection, sttProvider, receiver, responder, buffer, mode: 'pipeline' });
      this.log.info({ guildId, mode: effectiveMode }, 'audio pipeline started');
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

    pipeline.geminiResponder?.destroy();
    if (pipeline.geminiProvider) {
      await pipeline.geminiProvider.disconnect();
    }

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

  /** Configured voice provider mode ('pipeline' or 'gemini-live'). */
  get activeVoiceProvider(): VoicePipelineMode {
    return this.voiceProvider;
  }

  /** Active mode for a specific guild (may differ from configured mode during fallback). */
  pipelineMode(guildId: string): VoicePipelineMode | undefined {
    return this.pipelines.get(guildId)?.mode;
  }

  /** Current Deepgram TTS voice model name. */
  get ttsVoice(): string | undefined {
    return this.voiceConfig.deepgramTtsVoice;
  }

  /**
   * Fall back from gemini-live to the standard pipeline for a guild.
   * Stops the current gemini-live session and starts a standard STT/AI/TTS pipeline.
   * No-op if no pipeline exists or the guild is already in standard mode.
   */
  private async fallbackToPipeline(guildId: string, connection: VoiceConnection): Promise<void> {
    const pipeline = this.pipelines.get(guildId);
    if (!pipeline || pipeline.mode !== 'gemini-live') return;

    this.log.warn({ guildId }, 'gemini-live: initiating fallback to standard pipeline');

    await this.stopPipeline(guildId);
    await this.startPipeline(guildId, connection, 'pipeline');

    if (this.hasPipeline(guildId)) {
      this.log.info({ guildId }, 'gemini-live: fallback to standard pipeline succeeded');
      this.onFallbackTriggered?.(guildId, 'pipeline');
    } else {
      this.log.error({ guildId }, 'gemini-live: fallback to standard pipeline also failed — guild has no active pipeline');
    }
  }

  /**
   * Update the Deepgram TTS voice and restart all active pipelines so the
   * new voice takes effect immediately. No-op in gemini-live mode (TTS is
   * handled server-side).
   * @returns The number of pipelines that were restarted (0 in gemini-live mode).
   */
  async setTtsVoice(voice: string): Promise<number> {
    if (this.voiceProvider === 'gemini-live') {
      this.log.info({ voice }, 'TTS voice change ignored — gemini-live mode uses server-side TTS');
      return 0;
    }

    this.voiceConfig = { ...this.voiceConfig, deepgramTtsVoice: voice };
    this.log.info({ voice }, 'TTS voice updated — restarting active pipelines');

    const entries = [...this.pipelines.entries()];
    await Promise.all(entries.map(([guildId, pipeline]) => this.startPipeline(guildId, pipeline.connection)));
    return entries.length;
  }
}
