# DiscoClaw Voice System

Voice chat support — the bot joins Discord voice channels, transcribes user speech via STT, generates AI responses, and speaks them back via TTS. A transcript mirror posts the full conversation to a text channel for persistence.

## Prerequisites

- **Node >= 22** — required for native `WebSocket` used by the Cartesia TTS provider
- **`@discordjs/opus`** — native Opus codec binding (requires build tools: `gcc`, `make`, `python3`)
- **`@discordjs/voice`** — Discord voice connection library
- **`sodium-native`** or **`libsodium-wrappers`** — encryption for Discord voice (discord.js auto-detects whichever is installed)

All are listed in `package.json` and installed via `pnpm install`. If `@discordjs/opus` fails to build, ensure your system has C++ build tools installed (e.g. `build-essential` on Debian/Ubuntu).

## Env Var Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCOCLAW_VOICE_ENABLED` | No | `0` | Master switch — enables the voice subsystem |
| `DISCOCLAW_DISCORD_ACTIONS_VOICE` | No | `0` | Enables voice action types (join/leave/status/mute/deafen); requires `DISCOCLAW_VOICE_ENABLED=1` |
| `DISCOCLAW_VOICE_AUTO_JOIN` | No | `0` | Auto-join voice channels when an allowlisted user enters |
| `DISCOCLAW_STT_PROVIDER` | No | `deepgram` | Speech-to-text provider: `deepgram` or `whisper` |
| `DISCOCLAW_TTS_PROVIDER` | No | `cartesia` | Text-to-speech provider: `cartesia`, `deepgram`, `openai`, or `kokoro` |
| `DISCOCLAW_VOICE_HOME_CHANNEL` | No | — | Channel name or ID for transcript mirroring and prompt context loading |
| `DISCOCLAW_VOICE_MODEL` | No | — | AI model override for voice response invocations |
| `DISCOCLAW_VOICE_SYSTEM_PROMPT` | No | — | System prompt override for voice response invocations |
| `DEEPGRAM_STT_MODEL` | No | `nova-3-conversationalai` | Deepgram STT model to use (see [STT Models](#deepgram-stt-models)) |
| `DEEPGRAM_TTS_VOICE` | No | `aura-2-asteria-en` | Deepgram TTS voice to use (see [TTS Voices](#deepgram-tts-voices-aura-2)) |
| `DEEPGRAM_API_KEY` | Yes* | — | Deepgram API key (*required when `DISCOCLAW_STT_PROVIDER=deepgram` or `DISCOCLAW_TTS_PROVIDER=deepgram`) |
| `CARTESIA_API_KEY` | Yes* | — | Cartesia API key (*required when `DISCOCLAW_TTS_PROVIDER=cartesia`) |
| `OPENAI_API_KEY` | Yes* | — | OpenAI API key (*required when `DISCOCLAW_TTS_PROVIDER=openai`) |

## API Key Setup

### Deepgram (STT — Nova-3 streaming)

1. Create an account at [deepgram.com](https://deepgram.com)
2. Generate an API key in the Deepgram console
3. Set `DEEPGRAM_API_KEY=<your-key>` in `.env`

The STT provider streams audio to Deepgram via WebSocket (`wss://api.deepgram.com/v1/listen`) as linear16 PCM at 16 kHz. The model is selected by `DEEPGRAM_STT_MODEL` (default: `nova-3-conversationalai`). See [STT Models](#deepgram-stt-models) for available options.

### Deepgram (TTS — Aura REST)

The TTS provider reuses the same `DEEPGRAM_API_KEY` configured for STT — no additional key is needed. Set `DISCOCLAW_TTS_PROVIDER=deepgram` in `.env` to select it.

The provider POSTs to Deepgram's `/v1/speak` endpoint requesting `linear16` encoding with `container=none` (raw PCM s16le). The response body is streamed and yielded as audio frames for low-latency playback. The voice is selected by `DEEPGRAM_TTS_VOICE` (default: `aura-2-asteria-en`) at 24 kHz. See [TTS Voices](#deepgram-tts-voices-aura-2) for available voices.

> **Note:** The default voice was changed from `aura-2-thalia-en` to `aura-2-asteria-en`. Update your `.env` if you want to keep the previous voice.

### Cartesia (TTS — Sonic-3 WebSocket)

1. Create an account at [cartesia.ai](https://cartesia.ai)
2. Generate an API key in the Cartesia dashboard
3. Set `CARTESIA_API_KEY=<your-key>` in `.env`

The TTS provider uses Cartesia's Sonic-3 model via WebSocket (`wss://api.cartesia.ai/tts/websocket`). Audio is received as base64-encoded PCM s16le at 24 kHz, then upsampled to 48 kHz stereo for Discord playback.

## Provider Status

| Role | Provider | Status |
|------|----------|--------|
| STT | `deepgram` (Nova-3 streaming) | **Implemented** — `src/voice/stt-deepgram.ts` |
| STT | `whisper` | Stub — not yet implemented |
| TTS | `cartesia` (Sonic-3 WebSocket) | **Implemented** — `src/voice/tts-cartesia.ts` |
| TTS | `deepgram` (Aura REST streaming) | **Implemented** — `src/voice/tts-deepgram.ts` |
| TTS | `openai` (TTS API REST streaming) | **Implemented** — `src/voice/tts-openai.ts` |
| TTS | `kokoro` | Stub — not yet implemented |

Provider selection is handled by factory functions in `src/voice/stt-factory.ts` and `src/voice/tts-factory.ts`. Selecting a stub provider will throw an error at startup.

## Deepgram STT Models

Set via `DEEPGRAM_STT_MODEL`. Default: `nova-3-conversationalai`.

| Model | Description |
|-------|-------------|
| `nova-3` | General-purpose, highest accuracy |
| `nova-3-conversationalai` | Optimised for conversational/assistant use cases |
| `nova-3-medical` | Optimised for medical terminology and dictation |
| `nova-3-finance` | Optimised for financial terminology |
| `nova-3-automotive` | Optimised for automotive / in-vehicle voice |
| `nova-3-drivethru` | Optimised for quick-service / drive-through ordering |
| `nova-3-phonecall` | Optimised for telephony audio quality |
| `nova-2` | Previous generation — lower latency, slightly lower accuracy |

## Deepgram TTS Voices (Aura-2)

Set via `DEEPGRAM_TTS_VOICE`. Default: `aura-2-asteria-en`.

| Voice | Gender | Notes |
|-------|--------|-------|
| `aura-2-asteria-en` | Female | Default — clear, professional |
| `aura-2-luna-en` | Female | Warm, conversational |
| `aura-2-stella-en` | Female | Upbeat, energetic |
| `aura-2-thalia-en` | Female | Previous default — neutral |
| `aura-2-hera-en` | Female | Authoritative |
| `aura-2-orion-en` | Male | Deep, confident |
| `aura-2-arcas-en` | Male | Casual, friendly |
| `aura-2-perseus-en` | Male | Clear, neutral |
| `aura-2-angus-en` | Male | Warm, Irish-accented |
| `aura-2-helios-en` | Male | British-accented |
| `aura-2-zeus-en` | Male | Commanding |

All Aura-2 voices are English (`-en`). The full list is maintained in the [Deepgram docs](https://developers.deepgram.com/docs/tts-models).

## `!voice` Commands

The `!voice` family of bang commands controls the voice subsystem at runtime without AI invocation. All subcommands require `DISCOCLAW_VOICE_ENABLED=1`. If voice is disabled, every subcommand returns a brief disabled notice.

All three subcommands are handled by `src/discord/voice-command.ts` (parser + handler) and wired in `src/discord/message-coordinator.ts`. They do not require `DISCOCLAW_DISCORD_ACTIONS_VOICE=1`.

### `!voice` / `!voice status`

Reports the current voice subsystem state.

```
!voice
!voice status
```

**Output includes:**

- Whether the voice subsystem is enabled (`DISCOCLAW_VOICE_ENABLED`)
- Active voice connection per guild (channel name + guild name, or "not connected")
- Configured STT provider and model (`DISCOCLAW_STT_PROVIDER`, `DEEPGRAM_STT_MODEL`)
- Configured TTS provider and voice (`DISCOCLAW_TTS_PROVIDER`, `DEEPGRAM_TTS_VOICE`)
- Whether auto-join is active (`DISCOCLAW_VOICE_AUTO_JOIN`)
- Home channel name/ID (`DISCOCLAW_VOICE_HOME_CHANNEL`)

### `!voice set <name>`

Switches the Deepgram TTS voice at runtime.

```
!voice set aura-2-asteria-en
!voice set aura-2-luna-en
```

**Behaviour:**

- Requires `DISCOCLAW_TTS_PROVIDER=deepgram`.
- Updates the in-process voice config immediately and restarts all active audio pipelines.
- **Ephemeral** — the change is not written to `.env`. The voice reverts to `DEEPGRAM_TTS_VOICE` on the next service restart. To make it permanent, update `DEEPGRAM_TTS_VOICE` in `.env` and restart the service.

See [Deepgram TTS Voices](#deepgram-tts-voices-aura-2) for the full list of accepted voice names.

### `!voice help`

Displays the inline help text for all `!voice` subcommands.

```
!voice help
```

**Help text format:**

```
**!voice commands:**
- `!voice` — show voice subsystem status
- `!voice status` — same as above
- `!voice set <name>` — switch the Deepgram TTS voice at runtime
- `!voice help` — this message

**Examples:**
- `!voice set aura-2-asteria-en`
- `!voice set aura-2-luna-en`

**Note:** Voice name switching requires the Deepgram TTS provider (`DISCOCLAW_TTS_PROVIDER=deepgram`).
```

## Discord Permissions

The bot requires these Discord permissions for voice:

- **Connect** — join voice channels
- **Speak** — play TTS audio
- **Use Voice Activity** — receive user audio without push-to-talk

These are role permissions configured in Server Settings > Roles > (bot role). The existing **Message Content Intent** (required for text messaging) is also needed for voice transcription context.

## Voice Home Channel

`DISCOCLAW_VOICE_HOME_CHANNEL` serves a dual purpose:

1. **Transcript mirror target** — user speech transcriptions and bot responses are posted to this text channel, creating a persistent text record of voice conversations
2. **Prompt context source** — PA files, per-channel context, and durable memory are loaded from this channel's context when building prompts for voice AI invocations

Set this to the name or ID of a text channel. The transcript mirror resolves the channel lazily on first use (by ID first, then by name scan across guild caches).

When voice is enabled, the server scaffold automatically creates two channels:

- `voice` — the voice channel users join to speak with the bot
- `voice-log` — a paired text channel for transcript mirroring

`voice-log` is the recommended value for `DISCOCLAW_VOICE_HOME_CHANNEL` on new installs.

## Voice Actions

Five Discord action types control voice session state:

| Action | Description |
|--------|-------------|
| `voiceJoin` | Join a voice channel by name or ID |
| `voiceLeave` | Leave the current voice connection |
| `voiceStatus` | Check current voice connection state |
| `voiceMute` | Mute or unmute the bot |
| `voiceDeafen` | Deafen or undeafen the bot |

Voice actions are defined in `src/discord/actions-voice.ts` and gated by **both** `DISCOCLAW_VOICE_ENABLED=1` and `DISCOCLAW_DISCORD_ACTIONS_VOICE=1`. Voice actions are disabled in cron flows.

See `docs/discord-actions.md` for full action documentation.

## Voice Action Flags

During voice invocations, only a restricted subset of Discord actions are available:

- **Allowed:** messaging, tasks, memory
- **Disabled:** channels, guild, moderation, polls, crons, bot profile, forge, plan, config, defer, imagegen, voice

Each allowed category is AND-ed with its env config flag — if `DISCOCLAW_DISCORD_ACTIONS_MESSAGING=0`, messaging actions are unavailable even in voice. See `src/voice/voice-action-flags.ts`.

## Auto-Join (Presence Handler)

When `DISCOCLAW_VOICE_AUTO_JOIN=1`, the presence handler (`src/voice/presence-handler.ts`) listens for `voiceStateUpdate` events:

- **Auto-joins** when the first allowlisted non-bot user enters a voice channel (if the bot is not already connected to that guild)
- **Auto-leaves** when the last non-bot user leaves the channel the bot is in
- Respects the user allowlist (fail-closed: empty allowlist = ignore everyone)
- Skips stage channels

## Barge-In Support

When a user starts speaking while the bot is playing TTS audio, the audio pipeline detects this as a "barge-in" and immediately stops playback. This allows natural conversational interruption.

The barge-in signal comes from the `AudioReceiver`'s `onUserSpeaking` callback, which fires on every speaking burst from an allowlisted user. If the `VoiceResponder` is currently playing, its playback is stopped and the generation counter is incremented to abandon the in-flight pipeline.

## Architecture Overview

The voice system is composed of several cooperating modules:

```
User speaks
  -> AudioReceiver (Opus decode, 48kHz->16kHz downsample)
    -> SttProvider (Deepgram Nova-3, WebSocket streaming)
      -> TranscriptionResult (final transcript)
        -> VoiceResponder (AI invoke -> TTS -> playback)
          -> TtsProvider (Cartesia Sonic-3 WebSocket | Deepgram Aura REST)
            -> AudioPlayer (24kHz->48kHz upsample, Discord playback)

TranscriptMirror posts text records to the home channel at each stage.
```

- **ConnectionManager** (`connection-manager.ts`) — manages per-guild voice connections with reconnect logic
- **AudioPipelineManager** (`audio-pipeline.ts`) — orchestrates per-guild STT/TTS/responder lifecycle, auto-starts on connection Ready, auto-stops on Destroyed
- **AudioReceiver** (`audio-receiver.ts`) — subscribes to allowlisted users' Opus streams, decodes to PCM, downsamples to 16 kHz mono, feeds STT
- **OpusDecoder** (`opus.ts`) — wraps `@discordjs/opus` for Opus-to-PCM decode
- **VoiceResponder** (`voice-responder.ts`) — AI invoke -> TTS synthesis -> audio playback pipeline with generation-based cancellation
- **TranscriptMirror** (`transcript-mirror.ts`) — posts user transcriptions and bot responses to a text channel
- **PresenceHandler** (`presence-handler.ts`) — auto-join/leave based on user voice presence

## Troubleshooting

### Missing API Keys

```
Error: deepgramApiKey is required when sttProvider is "deepgram"
Error: cartesiaApiKey is required when ttsProvider is "cartesia"
```

Set the appropriate API key in `.env`. The factory functions throw at pipeline startup if the selected provider's key is missing.

### Opus Build Failures

```
Error: Cannot find module '@discordjs/opus'
```

`@discordjs/opus` is a native Node.js addon that requires C++ build tools. Install them:

```bash
# Debian/Ubuntu
sudo apt install build-essential python3

# Fedora
sudo dnf install gcc-c++ make python3

# macOS
xcode-select --install
```

Then re-run `pnpm install`.

### Voice Connection DAVE Handshake Errors

Discord's voice connections use the DAVE (Discord Audio/Video Encryption) protocol. If you see errors like:

```
voice connection error { err: Error: ... }
```

The connection manager catches these errors and destroys the connection to prevent process crashes. Common causes:

- Network instability or firewall blocking UDP traffic
- Discord server-side issues (transient — retry usually works)
- Bot missing the Connect permission in the voice channel

The connection manager will attempt up to 5 reconnect retries with automatic rejoin before giving up.

### No Audio / STT Not Receiving

- Ensure the bot is **not self-deafened** (joins with `selfDeaf: false` by default)
- Check that the speaking user's Discord ID is in `DISCORD_ALLOW_USER_IDS`
- Verify `DISCOCLAW_VOICE_ENABLED=1` is set
- Check logs for `audio receiver started` and `subscribed to user audio` messages

### Cartesia WebSocket Requires Node 22+

```
Error: globalThis.WebSocket is not available.
```

The Cartesia TTS provider uses the native `WebSocket` API available in Node 22+. Upgrade Node or ensure you're running with a compatible version.
