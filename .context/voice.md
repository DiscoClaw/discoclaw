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
- **Generation-based cancellation** — `VoiceResponder` increments a generation counter on each new transcription. If a newer transcription arrives mid-pipeline, the older one is silently abandoned.
- **Barge-in** — `AudioReceiver.onUserSpeaking` fires on every speaking burst. If the responder is playing, playback stops and the generation counter advances.
- **Re-entrancy guard** — `AudioPipelineManager.startPipeline` uses a `starting` set because `VoiceConnection.subscribe()` synchronously fires a Ready state change.
- **Error containment** — `VoiceConnectionManager` catches connection errors and destroys the connection to prevent process crashes (e.g. DAVE handshake failures).

## Wiring (`src/index.ts`)

When `voiceEnabled=true`, the post-connect block in `src/index.ts` initializes the voice subsystem in order:

1. **`TranscriptMirror.resolve()`** — resolves the voice home channel for text mirroring (may be `null` if unconfigured).
2. **`voiceInvokeAi`** closure — builds the AI invocation function that prepends channel context, PA prompt, durable memory, voice system prompt, and action instructions to user speech. Supports up to 2 follow-up rounds for action results.
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
| `CARTESIA_API_KEY` | — | Required for cartesia TTS |
