# Voice

Discoclaw voice now runs on Gemini Live only. The legacy split STT/TTS pipeline has been removed from the product, config surface, and docs.

## Required config

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DISCOCLAW_VOICE_ENABLED` | No | `0` | Master switch for voice |
| `GEMINI_API_KEY` | Yes when voice enabled | — | Gemini Live API access |
| `DISCOCLAW_VOICE_MODEL` | No | follows startup chat model | Voice model override |
| `DISCOCLAW_GEMINI_SESSION_ROTATION_MS` | No | `780000` | Proactive reconnect before Gemini's session limit |
| `DISCOCLAW_VOICE_HOME_CHANNEL` | Recommended | — | Text channel used for prompt context and voice-triggered actions |
| `DISCOCLAW_VOICE_LOG_CHANNEL` | No | auto-discovered `voice-log` | Transcript mirror destination |
| `DISCOCLAW_VOICE_AUTO_JOIN` | No | `0` | Auto-join when allowed users enter voice |
| `DISCOCLAW_VOICE_SYSTEM_PROMPT` | No | — | Voice-specific system prompt override |

## Minimal setup

```env
DISCOCLAW_VOICE_ENABLED=1
GEMINI_API_KEY=your-key
DISCOCLAW_VOICE_HOME_CHANNEL=voice
```

Optional direct Anthropic voice runtime:

```env
ANTHROPIC_API_KEY=your-key
```

`!models set voice claude-api` still selects the direct Anthropic runtime for voice responses, but Discord audio transport remains Gemini Live.

## What changed

- There is no `DISCOCLAW_VOICE_PIPELINE_PROVIDER` anymore.
- There are no separate STT/TTS provider selectors anymore.
- `!voice set <name>` is gone because server-side Gemini speech synthesis owns the output voice.
- `runtime-overrides.json` no longer stores `ttsVoice`.

## Runtime behavior

- Discord audio is decoded by `AudioReceiver` and streamed into `GeminiLiveProvider`.
- Gemini handles speech recognition, reasoning, speech synthesis, and interrupt events in one session.
- `GeminiLiveResponder` plays returned audio into Discord, mirrors transcripts, and dispatches supported tool calls.
- `ConversationBuffer` is still used to seed join-time history back into a new Gemini Live session.

## Commands

- `!voice`
- `!voice status`
- `!voice help`

These commands now report Gemini Live status only.
