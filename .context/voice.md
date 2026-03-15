# Voice System

Real-time voice chat: STT transcription, AI response generation, TTS synthesis, and Discord voice playback. For operator setup, see `docs/voice.md`.

## Dependencies

Two native npm packages power the Discord voice integration:

- **`@discordjs/voice`** — voice connection management, audio player/receiver, gateway adapter. Used in `connection-manager.ts`, `audio-receiver.ts`, `audio-pipeline.ts`, `voice-responder.ts`.
- **`@discordjs/opus`** — native Opus codec binding (C++ addon, requires build tools). Wrapped by `opus.ts` to decode Discord's 48 kHz stereo Opus packets to PCM s16le.
- **`sodium-native`** — encryption for Discord voice (auto-detected by discord.js).

## Module Map

| Module | Role |
|--------|------|
| `src/voice/types.ts` | Core interfaces: `VoiceConfig`, `AudioFrame`, `SttProvider`, `TtsProvider`, `TranscriptionResult` |
| `src/voice/connection-manager.ts` | Per-guild `VoiceConnection` lifecycle (join/leave/mute/deafen), reconnect retries (default 5), error-to-destroy safety net |
| `src/voice/audio-pipeline.ts` | Per-guild orchestrator — auto-starts STT + receiver + responder on connection Ready, auto-stops on Destroyed |
| `src/voice/audio-receiver.ts` | Subscribes to allowlisted users' Opus streams, decodes via `OpusDecoderFactory`, downsamples 48→16 kHz mono, feeds `SttProvider` |
| `src/voice/opus.ts` | `OpusDecoderFactory` implementation wrapping `@discordjs/opus` |
| `src/voice/voice-responder.ts` | AI invoke → TTS synthesis → `AudioPlayer` playback; generation-based cancellation for barge-in |
| `src/voice/stt-deepgram.ts` | Deepgram Nova-3 streaming STT via WebSocket |
| `src/voice/tts-cartesia.ts` | Cartesia Sonic-3 TTS via WebSocket, outputs PCM s16le at 24 kHz |
| `src/voice/tts-deepgram.ts` | Deepgram Aura TTS via REST, outputs PCM s16le at 24 kHz |
| `src/voice/stt-factory.ts` | STT provider factory (deepgram or whisper stub) |
| `src/voice/tts-factory.ts` | TTS provider factory (cartesia, deepgram, openai, or kokoro stub) |
| `src/voice/presence-handler.ts` | Auto-join/leave on `voiceStateUpdate` (allowlisted users only) |
| `src/voice/transcript-mirror.ts` | Posts user transcriptions and bot responses to a text channel |
| `src/voice/voice-action-flags.ts` | Restricted action subset for voice invocations (messaging + tasks + memory only) |
| `src/voice/conversation-buffer.ts` | Per-guild conversation ring buffer (10 turns) — stores user/model exchanges in memory; backfills from voice-log channel on join |
| `src/discord/actions-voice.ts` | Discord action types: `voiceJoin`, `voiceLeave`, `voiceStatus`, `voiceMute`, `voiceDeafen` |

## Audio Data Flow

```
User speaks in Discord voice channel
  → @discordjs/voice receiver emits Opus packets per user
    → AudioReceiver: allowlist gate → OpusDecoder (48 kHz stereo PCM)
      → downsample to 16 kHz mono
        → SttProvider.feedAudio() (Deepgram WebSocket)
          → TranscriptionResult (final transcript)
            → VoiceResponder.handleTranscription()
              → InvokeAiFn (AI runtime) → response text
                → TtsProvider.synthesize() (Cartesia WebSocket → 24 kHz mono PCM)
                  → upsampleToDiscord (48 kHz stereo)
                    → AudioPlayer → Discord voice connection
```

## Key Patterns

- **Allowlist gating** — `AudioReceiver` only subscribes to users in `DISCORD_ALLOW_USER_IDS`. Empty allowlist = ignore everyone (fail-closed).
- **Dual-flag voice actions** — Voice action execution requires both `VOICE_ENABLED` and `DISCORD_ACTIONS_VOICE`. The `buildVoiceActionFlags()` function intersects a voice-specific allowlist (messaging, tasks, memory) with env config; all other action categories are hard-disabled.
- **Queued invocations** — `VoiceResponder` queues new transcriptions when a pipeline is already in-flight instead of aborting the active AI call. Only the most recent pending text is kept (coalesced). On completion the responder drains the queue, processing the next pending transcription. This eliminates the death-spiral where CLI cold-start latency caused cascading cancellations. Barge-in still stops *playback* immediately but never cancels the running AI request.
- **Fast invoke path** — When `ANTHROPIC_API_KEY` is set, voice auto-wires to the Anthropic REST adapter (`src/runtime/anthropic-rest.ts`) instead of the CLI subprocess path. Direct HTTP eliminates the ~2-4 s CLI cold-start, bringing first-token latency under 500 ms. The wiring happens at startup in `src/index.ts`; at invoke time `resolveVoiceRuntime()` picks the `'anthropic'` adapter from the registry. Model configuration is now in `models.json`; the voice runtime override is still in `runtime-overrides.json` (`voiceRuntime` key). The model can also be changed via the `!models` command.
- **Generation-based cancellation** — `VoiceResponder` increments a generation counter on each new transcription. If a newer transcription arrives mid-pipeline, the older one is silently abandoned.
- **Barge-in** — Gated on a non-empty STT transcription result, not the raw VAD `speaking.start` event. Echo from the bot's own TTS leaking through the user's mic produces empty transcriptions and is ignored. Only when `VoiceResponder.handleTranscription()` receives a non-empty transcript while the player is active does it stop playback and advance the generation counter. This eliminates false positives from echo without relying on a static grace-period timeout.
- **Conversation ring buffer** — `ConversationBuffer` maintains a per-guild 10-turn ring buffer of user/model exchanges that gets injected into the voice prompt as formatted conversation history. Turns are appended live during a session. On voice join, the buffer backfills from recent voice-log channel messages so context carries across disconnects. The buffer is cleared when the bot leaves the voice channel.
- **Re-entrancy guard** — `AudioPipelineManager.startPipeline` uses a `starting` set because `VoiceConnection.subscribe()` synchronously fires a Ready state change.
- **Error containment** — `VoiceConnectionManager` catches connection errors and destroys the connection to prevent process crashes (e.g. DAVE handshake failures).
- **Deepgram TTS 2000-char limit** — Deepgram Aura REST TTS returns HTTP 413 (silent failure) for inputs exceeding ~2000 characters. `tts-deepgram.ts` truncates the input to 2000 chars before sending to prevent silent audio dropouts. If the AI response is unexpectedly long (e.g. from a missing `VOICE_STYLE_INSTRUCTION`), the user will still hear a truncated response rather than silence.

## Wiring (`src/index.ts`)

When `voiceEnabled=true`, the post-connect block in `src/index.ts` initializes the voice subsystem in order:

1. **`TranscriptMirror.resolve()`** — resolves the voice home channel for text mirroring (may be `null` if unconfigured).
2. **`voiceInvokeAi`** closure — builds the AI invocation function that prepends channel context, PA prompt, durable memory, voice system prompt, and action instructions to user speech. Supports up to 1 follow-up round for action results. `runtimeTimeoutMs` is applied to each invocation as a safety net against runaway queries.
3. **`AudioPipelineManager`** — instantiated with voice config, allowlist, decoder factory, `voiceInvokeAi`, transcript mirror, and a transcription logging callback.
4. **`VoiceConnectionManager`** — instantiated with `onReady` → `audioPipeline.startPipeline()` and `onDestroyed` → `audioPipeline.stopPipeline()` callbacks.
5. **`botParams.voiceCtx`** — set when `DISCORD_ACTIONS_VOICE` is enabled, exposing `voiceManager` to Discord action handlers (`voiceJoin`, `voiceLeave`, etc.).
6. **`VoicePresenceHandler`** — created and registered on the Discord client only when `VOICE_AUTO_JOIN` is enabled.

## Config (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCOCLAW_VOICE_ENABLED` | `0` | Master switch |
| `DISCOCLAW_DISCORD_ACTIONS_VOICE` | `0` | Enable voice action types |
| `DISCOCLAW_VOICE_AUTO_JOIN` | `0` | Auto-join when allowlisted user enters |
| `DISCOCLAW_STT_PROVIDER` | `deepgram` | STT backend |
| `DISCOCLAW_TTS_PROVIDER` | `cartesia` | TTS backend (`cartesia`, `deepgram`, `openai`, `kokoro`) |
| `DISCOCLAW_VOICE_HOME_CHANNEL` | — | Voice audio channel name/ID used for prompt context (not transcript mirroring) |
| `DISCOCLAW_VOICE_LOG_CHANNEL` | — | Text channel name/ID where `TranscriptMirror` posts user transcriptions and bot responses; falls back to bootstrap-provided `voiceLogChannelId` if unset |
| `DISCOCLAW_VOICE_MODEL` | `capable` | AI model tier for voice responses |
| `DISCOCLAW_VOICE_SYSTEM_PROMPT` | — | Custom system prompt for voice invocations (max 4000 chars) |
| `DEEPGRAM_API_KEY` | — | Required for deepgram STT and TTS |
| `DEEPGRAM_STT_MODEL` | `nova-3-conversationalai` | Deepgram STT model name |
| `DEEPGRAM_TTS_VOICE` | `aura-2-asteria-en` | Deepgram TTS voice name |
| `DEEPGRAM_TTS_SPEED` | `1.3` | Deepgram TTS playback speed (range 0.5–1.5) |
| `CARTESIA_API_KEY` | — | Required for cartesia TTS |
| `ANTHROPIC_API_KEY` | — | Enables the Anthropic REST adapter; when set and voice is enabled, voice auto-wires to the direct Messages API path (zero CLI cold-start). See `runtime.md § Anthropic REST Runtime`. |
| *(built-in)* | — | Telegraphic style instruction hardcoded into every voice AI invocation — front-loads the answer, strips preambles/markdown/filler, keeps responses short for TTS latency. Not an env var; not overridable by `DISCOCLAW_VOICE_SYSTEM_PROMPT`. |
