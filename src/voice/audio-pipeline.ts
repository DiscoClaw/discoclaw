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
import type { SttProvider, TranscriptionResult, VoiceConfig, VoicePipelineMode } from './types.js';
import { AudioReceiver, type OpusDecoderFactory } from './audio-receiver.js';
import type { InvokeAiFn } from './voice-responder.js';
import type { TranscriptMirrorLike } from './transcript-mirror.js';
import { ConversationBuffer, type Turn } from './conversation-buffer.js';
import { GeminiLiveProvider } from './providers/gemini-live-provider.js';
import { GeminiLiveResponder } from './providers/gemini-live-responder.js';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiLiveHistoryTurn,
  normalizeGeminiLiveModel,
  supportsGeminiLiveAsyncFunctionCalling,
} from './providers/gemini-live-types.js';
import { buildGeminiToolDeclarations, buildToolSchemas, OPENAI_TO_DISCO_NAME } from '../runtime/openai-tool-schemas.js';
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
  /** Optional transcript mirror for posting voice conversation text to a Discord channel. */
  transcriptMirror?: TranscriptMirrorLike;
  /** Bot display name for transcript mirror messages. */
  botDisplayName?: string;
  /** Optional async callback that returns initial turn pairs for conversation history backfill on join. */
  backfill?: () => Promise<Turn[]>;
  /** Optional async callback that builds the static Gemini Live system instruction for a new session. */
  buildGeminiSystemInstruction?: () => Promise<string | undefined>;
  /** API key for Gemini Live. */
  geminiApiKey?: string;
  /** Enabled tool names for Gemini Live tool use (e.g. ['Read', 'Bash']). */
  enabledTools?: string[];
  /** Tool names that use SILENT scheduling when the selected Gemini Live model supports scheduled responses. */
  silentTools?: string[];
  /** Timer-based session rotation interval in ms for Gemini Live (default 13 min). */
  sessionRotationMs?: number;
};

type GuildPipeline = {
  connection: VoiceConnection;
  sttProvider: SttProvider;
  receiver: AudioReceiver;
  buffer?: ConversationBuffer;
  geminiProvider?: GeminiLiveProvider;
  geminiResponder?: GeminiLiveResponder;
  mode: VoicePipelineMode;
};

// ---------------------------------------------------------------------------
// AudioPipelineManager
// ---------------------------------------------------------------------------

export class AudioPipelineManager {
  private readonly log: LoggerLike;
  private readonly allowedUserIds: Set<string>;
  private readonly createDecoder: OpusDecoderFactory;
  private readonly onTranscription?: (guildId: string, result: TranscriptionResult) => void;
  private readonly invokeAi?: InvokeAiFn;
  private readonly runtime?: string;
  private readonly runtimeModel?: string;
  private readonly runtimeCwd?: string;
  private readonly runtimeTimeoutMs?: number;
  private readonly transcriptMirror?: TranscriptMirrorLike;
  private readonly botDisplayName: string;
  private readonly backfill?: () => Promise<Turn[]>;
  private readonly buildGeminiSystemInstruction?: () => Promise<string | undefined>;
  private readonly geminiApiKey?: string;
  private readonly enabledTools: string[];
  private readonly silentTools: Set<string>;
  private readonly sessionRotationMs?: number;
  private readonly pipelines = new Map<string, GuildPipeline>();
  /** Re-entrancy guard: VoiceConnection.subscribe() can synchronously fire stateChange→Ready. */
  private readonly starting = new Set<string>();

  constructor(opts: AudioPipelineOpts) {
    this.log = opts.log;
    this.allowedUserIds = opts.allowedUserIds;
    this.createDecoder = opts.createDecoder;
    this.onTranscription = opts.onTranscription;
    this.invokeAi = opts.invokeAi;
    this.runtime = opts.runtime;
    this.runtimeModel = opts.runtimeModel;
    this.runtimeCwd = opts.runtimeCwd;
    this.runtimeTimeoutMs = opts.runtimeTimeoutMs;
    this.transcriptMirror = opts.transcriptMirror;
    this.botDisplayName = opts.botDisplayName ?? 'Bot';
    this.backfill = opts.backfill;
    this.buildGeminiSystemInstruction = opts.buildGeminiSystemInstruction;
    this.geminiApiKey = opts.geminiApiKey;
    this.enabledTools = opts.enabledTools ?? [];
    this.silentTools = new Set(opts.silentTools ?? []);
    this.sessionRotationMs = opts.sessionRotationMs;

    this.log.info({ voiceProvider: 'gemini-live' }, 'audio pipeline manager initialized');
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

  /** Start the Gemini Live voice pipeline for a guild. */
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
      const apiKey = this.geminiApiKey;
      if (!apiKey) throw new Error('geminiApiKey is required for gemini-live voice provider');

      const buffer = new ConversationBuffer();
      if (this.backfill) {
        try {
          const turns = await this.backfill();
          buffer.backfill(turns);
          this.log.info({ guildId, turns: turns.length }, 'gemini-live conversation buffer backfilled');
        } catch (err) {
          this.log.warn({ guildId, err }, 'gemini-live conversation backfill failed — proceeding with empty history');
        }
      }

      const geminiLiveModel = normalizeGeminiLiveModel(this.runtimeModel) ?? DEFAULT_GEMINI_LIVE_MODEL;
      const supportsAsyncFunctionCalling = supportsGeminiLiveAsyncFunctionCalling(geminiLiveModel);
      const tools = buildGeminiToolDeclarations(this.enabledTools, { nonBlocking: supportsAsyncFunctionCalling });
      const systemInstruction = await this.buildGeminiSystemInstruction?.();
      const initialHistory = toGeminiLiveHistoryTurns(buffer.toTurns());
      const provider = new GeminiLiveProvider({
        apiKey,
        log: this.log,
        model: geminiLiveModel,
        systemInstruction,
        responseModalities: ['AUDIO'],
        tools,
        initialHistoryInClientContent: initialHistory.length > 0,
        sessionRotationMs: this.sessionRotationMs,
      });
      await provider.connect();
      if (initialHistory.length > 0) {
        provider.sendInitialHistory(initialHistory);
        this.log.info({ guildId, turns: initialHistory.length }, 'gemini-live conversation history seeded');
      }

      if (!supportsAsyncFunctionCalling && this.silentTools.size > 0) {
        this.log.info(
          { guildId, model: geminiLiveModel, count: this.silentTools.size },
          'gemini-live: current model does not support scheduled tool responses; silent tool scheduling disabled',
        );
      }

      const mirror = this.transcriptMirror;
      const botName = this.botDisplayName;
      let latestInputTranscript: string | undefined;
      const responder = new GeminiLiveResponder({
        log: this.log,
        connection,
        provider,
        onBotResponse: mirror
          ? (text) => {
              if (latestInputTranscript && text.trim()) {
                buffer.push(latestInputTranscript, text);
                latestInputTranscript = undefined;
              }
              mirror.postBotResponse(botName, text).catch((err) => {
                this.log.warn({ guildId, err }, 'transcript-mirror: failed to post bot response');
              });
            }
          : (text) => {
              if (latestInputTranscript && text.trim()) {
                buffer.push(latestInputTranscript, text);
                latestInputTranscript = undefined;
              }
            },
        onInputTranscript: mirror
          ? (text) => {
              if (text.trim()) latestInputTranscript = text.trim();
              mirror.postUserTranscription('User', text).catch((err) => {
                this.log.warn({ guildId, err }, 'transcript-mirror: failed to post user transcription');
              });
            }
          : (text) => {
              if (text.trim()) latestInputTranscript = text.trim();
            },
        onSessionTerminated: () => {
          this.log.error({ guildId }, 'gemini-live session terminally failed — no fallback');
        },
        onFallbackRecommended: (reason: string) => {
          this.log.warn({ guildId, reason }, 'gemini-live: fallback recommended but the legacy pipeline has been removed');
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

              void (async () => {
                const results = await Promise.all(
                  calls.map(async (call) => {
                    const scheduling: 'SILENT' | 'INTERRUPT' | undefined = supportsAsyncFunctionCalling
                      ? (this.isSilentTool(call.name) ? 'SILENT' : 'INTERRUPT')
                      : undefined;
                    try {
                      const res = await executeToolCall(
                        call.name,
                        call.args,
                        allowedRoots,
                        logFn,
                        execOpts,
                      );
                      return { id: call.id, name: call.name, output: res.result, scheduling };
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      return { id: call.id, name: call.name, output: `Error: ${msg}`, scheduling };
                    }
                  }),
                );

                const silentCount = supportsAsyncFunctionCalling
                  ? results.filter((r) => r.scheduling === 'SILENT').length
                  : 0;
                if (silentCount > 0) {
                  this.log.info(
                    { guildId, count: silentCount },
                    'gemini-live: SILENT tool execution complete — results scheduled silently',
                  );
                }

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
        onUserSilence: () => {
          try {
            provider.sendAudioStreamEnd();
          } catch (err) {
            this.log.warn({ guildId, err }, 'gemini-live: sendAudioStreamEnd error (non-fatal)');
          }
        },
      });

      receiver.start();

      this.pipelines.set(guildId, {
        connection,
        sttProvider: sttShim,
        receiver,
        buffer,
        geminiProvider: provider,
        geminiResponder: responder,
        mode: 'gemini-live',
      });
      this.log.info({ guildId }, 'audio pipeline started (gemini-live)');
    } catch (err) {
      this.log.error({ guildId, err }, 'failed to start audio pipeline');
      this.log.error({ guildId }, 'gemini-live: connection failed — no fallback available');
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

  /** Configured voice provider mode. */
  get activeVoiceProvider(): VoicePipelineMode {
    return 'gemini-live';
  }

  /** Active mode for a specific guild. */
  pipelineMode(guildId: string): VoicePipelineMode | undefined {
    return this.pipelines.get(guildId)?.mode;
  }

  private isSilentTool(toolName: string): boolean {
    return this.silentTools.has(toolName) || this.silentTools.has(OPENAI_TO_DISCO_NAME[toolName] ?? toolName);
  }
}

function toGeminiLiveHistoryTurns(turns: Turn[]): GeminiLiveHistoryTurn[] {
  const history: GeminiLiveHistoryTurn[] = [];
  for (const turn of turns) {
    history.push({ role: 'user', parts: [{ text: turn.user }] });
    history.push({ role: 'model', parts: [{ text: turn.assistant }] });
  }
  return history;
}
