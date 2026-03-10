# Official Documentation Index

Maintainer-facing index of primary documentation for DiscoClaw integrations. Use this before changing integration code, model IDs, API parameters, dependency behavior, auth flows, or provider-specific feature flags.

Completeness pass for this index was cross-checked against:

- `package.json`
- `.context/runtime.md`
- `src/voice/tts-factory.ts`
- `src/voice/stt-factory.ts`
- `src/cold-storage/embeddings.ts`
- `src/cold-storage/openai-compat.ts`
- `src/discord/actions-imagegen.ts`

## How to use this index

- Consult these links before changing integration code, model names, request bodies, headers, URL paths, SDK behavior, or provider feature toggles.
- Prefer official docs, API references, package homepages, and maintainer-owned repos over blog posts, forum answers, or memory.
- If a package does not have a dedicated docs site, treat the maintainer-owned repository and README as the authoritative source.
- `.context/runtime.md` remains the short runtime reminder. This file is the longer source-of-truth index for official references.

## AI Model Providers

| Provider | What DiscoClaw uses | Official docs |
|----------|----------------------|---------------|
| Anthropic | Claude model families via `src/runtime/anthropic-rest.ts` and Claude Code CLI runtime | Models overview: <https://docs.anthropic.com/en/docs/about-claude/models/overview><br>Messages API: <https://platform.claude.com/docs/en/api/messages><br>Claude Code docs: <https://code.claude.com/docs/en/overview> |
| OpenAI | OpenAI-compatible runtime, Codex runtime docs, OpenAI voice, embeddings, and image generation | Model IDs: <https://developers.openai.com/api/model-ids/><br>API reference overview: <https://platform.openai.com/docs/api-reference><br>Codex docs: <https://developers.openai.com/codex/> |
| Google | Gemini CLI runtime and Gemini/Imagen image generation | Gemini models: <https://ai.google.dev/models/gemini><br>Gemini API docs: <https://ai.google.dev/gemini-api/docs><br>Gemini CLI: <https://github.com/google-gemini/gemini-cli> |
| OpenRouter | OpenRouter runtime through `src/runtime/openai-compat.ts` | Model list: <https://openrouter.ai/models><br>API docs: <https://openrouter.ai/docs/api/reference/overview> |

## Discord

| Surface | What DiscoClaw uses | Official docs |
|---------|----------------------|---------------|
| Discord Developer Portal | App/bot setup, intents, OAuth, tokens | <https://discord.com/developers/applications> |
| Discord API docs | Platform behavior beyond SDK wrappers | <https://docs.discord.com/developers/intro> |
| discord.js guide | Discord bot patterns and library usage | <https://discordjs.guide> |
| discord.js API docs | `discord.js` production dependency | <https://discord.js.org/docs/packages/discord.js/main> |
| `@discordjs/voice` | Voice gateway, connection, player, and receiver APIs used by `src/voice/connection-manager.ts`, `src/voice/audio-pipeline.ts`, `src/voice/audio-receiver.ts`, and `src/voice/voice-responder.ts` | Package docs: <https://discord.js.org/docs/packages/voice/stable><br>Maintainer source: <https://github.com/discordjs/discord.js/tree/main/packages/voice><br>npm package: <https://www.npmjs.com/package/@discordjs/voice> |
| `@discordjs/opus` | Native Opus encoder/decoder addon used by `src/voice/opus.ts` and required by the Discord voice stack | Maintainer repo + README: <https://github.com/discordjs/opus><br>Releases: <https://github.com/discordjs/opus/releases><br>npm package: <https://www.npmjs.com/package/@discordjs/opus> |
| Discord Voice E2EE (DAVE protocol) | End-to-end voice encryption surface underlying DiscoClaw's Discord voice receive path and `@snazzah/davey` dependency | Discord voice docs: <https://discord.com/developers/docs/topics/voice-connections#endtoend-encryption-dave-protocol><br>Protocol site: <https://daveprotocol.com/><br>Discord maintainer repo (`libdave`): <https://github.com/discord/libdave> |

## MCP (Model Context Protocol)

| Surface | What DiscoClaw uses | Official docs |
|---------|----------------------|---------------|
| MCP specification | Protocol semantics and transport rules | <https://modelcontextprotocol.io/specification/2025-06-18> |
| `@modelcontextprotocol` GitHub org | Official SDKs and server implementations | <https://github.com/modelcontextprotocol> |
| Servers repo | Maintainer-owned server implementations | <https://github.com/modelcontextprotocol/servers> |
| Filesystem server example | Matches the scaffold in `templates/mcp.json` | <https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem> |

## Voice/Audio Providers

| Provider | Used in DiscoClaw | Official docs |
|----------|-------------------|---------------|
| Deepgram STT | `src/voice/stt-deepgram.ts` with Nova-3 streaming (`nova-3-general`) | STT API overview: <https://developers.deepgram.com/docs/speech-to-text><br>Streaming API: <https://developers.deepgram.com/reference/speech-to-text/listen-streaming><br>Nova-3 models: <https://developers.deepgram.com/docs/models-languages-overview> |
| Deepgram TTS | `src/voice/tts-deepgram.ts` with Aura (`aura-2-asteria-en`) | TTS API overview: <https://developers.deepgram.com/docs/text-to-speech><br>Speak endpoint: <https://developers.deepgram.com/reference/text-to-speech/speak-streaming><br>Aura voices/models: <https://developers.deepgram.com/docs/tts-models> |
| Cartesia TTS | `src/voice/tts-cartesia.ts` with Sonic-3 over WebSocket | API docs: <https://docs.cartesia.ai/api-reference><br>TTS WebSocket: <https://docs.cartesia.ai/api-reference/tts/websocket> |
| OpenAI TTS | `src/voice/tts-openai.ts` (`/v1/audio/speech`, default `tts-1`) | Audio speech API reference: <https://platform.openai.com/docs/api-reference/audio/createSpeech> |
| OpenAI STT | `src/voice/stt-openai.ts` (`/v1/audio/transcriptions`, `whisper-1`) | Audio transcription API reference: <https://platform.openai.com/docs/api-reference/audio/createTranscription> |

## Image Generation

| Surface / model family | Used in DiscoClaw | Official docs |
|------------------------|-------------------|---------------|
| OpenAI Images API | `src/discord/actions-imagegen.ts` posts to `/images/generations` for OpenAI-backed image generation | API reference: <https://platform.openai.com/docs/api-reference/images/create> |
| OpenAI GPT Image family | `src/discord/actions-imagegen.ts` accepts `gpt-image-*` model IDs (currently `gpt-image-1`) | Image generation guide: <https://platform.openai.com/docs/guides/image-generation><br>Models overview: <https://platform.openai.com/docs/models> |
| OpenAI DALL-E family | `src/discord/actions-imagegen.ts` accepts `dall-e-*` model IDs (currently defaulting to `dall-e-3`) | Image generation guide: <https://platform.openai.com/docs/guides/image-generation><br>Images API reference: <https://platform.openai.com/docs/api-reference/images/create> |
| Google Gemini native image generation | `src/discord/actions-imagegen.ts` calls `:generateContent` for `gemini-*` image-output models such as `gemini-3.1-flash-image-preview` | Gemini image generation guide: <https://ai.google.dev/gemini-api/docs/image-generation><br>Gemini model docs: <https://ai.google.dev/gemini-api/docs/models> |
| Google Imagen family | `src/discord/actions-imagegen.ts` calls `:predict` for `imagen-*` models such as `imagen-4.0-generate-001` | Imagen docs: <https://ai.google.dev/gemini-api/docs/imagen><br>Gemini image generation guide: <https://ai.google.dev/gemini-api/docs/image-generation> |

## Embedding Providers

| Provider | Used in DiscoClaw | Official docs |
|----------|-------------------|---------------|
| OpenAI Embeddings API | `src/cold-storage/embeddings.ts` defaulting to `text-embedding-3-small` | Embeddings API reference: <https://platform.openai.com/docs/api-reference/embeddings/create> |
| Ollama (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI compatibility: <https://ollama.com/blog/openai-compatibility><br>API docs: <https://github.com/ollama/ollama/blob/main/docs/api.md> |
| vLLM (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI-compatible server docs: <https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html> |
| LM Studio (OpenAI-compatible) | Supported through `src/cold-storage/openai-compat.ts` | OpenAI compatibility docs: <https://lmstudio.ai/docs/developer/openai-compat> |
| Together (OpenAI-compatible / embeddings) | Supported through `src/cold-storage/openai-compat.ts` | Embeddings docs: <https://docs.together.ai/docs/embeddings-overview><br>API reference: <https://docs.together.ai/reference> |

## Core Dependencies

Production dependencies from `package.json` are split across sections:

- Discord packages are covered in the Discord section above.
- The remaining shipped production dependencies are indexed here.

| Dependency | Purpose in DiscoClaw | Official docs / repo |
|------------|----------------------|----------------------|
| `better-sqlite3` | Native SQLite binding for local state and cold-storage persistence | <https://github.com/WiseLibs/better-sqlite3> |
| `sqlite-vec` | SQLite vector extension used for embedding search | <https://alexgarcia.xyz/sqlite-vec/> |
| `croner` | Cron parsing and scheduling for automations | <https://croner.56k.guru> |
| `execa` | Subprocess execution for runtime CLIs and helper commands | <https://github.com/sindresorhus/execa> |
| `pino` | Structured logging | <https://getpino.io> |
| `sharp` | Image transformation pipeline | <https://sharp.pixelplumbing.com> |
| `dotenv` | `.env` loading at process startup | <https://github.com/motdotla/dotenv> |
| `ws` | WebSocket client support used by voice integrations | <https://github.com/websockets/ws> |
| `sodium-native` | Native libsodium binding used by Discord voice encryption stack | <https://github.com/holepunchto/sodium-native> |
| `prism-media` | Audio demuxing/transcoding helpers for the voice pipeline | <https://github.com/hydrabolt/prism-media> |
| `youtube-transcript-plus` | Transcript retrieval for YouTube URL ingestion | <https://github.com/ericmmartin/youtube-transcript-plus> |
| `@snazzah/davey` | Node DAVE protocol implementation used by the Discord voice stack | npm package: <https://www.npmjs.com/package/@snazzah/davey><br>Maintainer repo + README: <https://github.com/Snazzah/davey><br>Node usage README: <https://github.com/Snazzah/davey/blob/master/davey-node/README.md><br>Usage docs: <https://github.com/Snazzah/davey/blob/master/docs/USAGE.md><br>Type definitions: <https://github.com/Snazzah/davey/blob/master/index.d.ts> |

## Dev Toolchain

| Tool | Purpose | Official docs / repo |
|------|---------|----------------------|
| TypeScript | Compiler and typechecker (`pnpm build`) | <https://www.typescriptlang.org/> |
| Vitest | Test runner (`pnpm test`) | <https://vitest.dev> |
| `tsx` | TypeScript execution for scripts and local entrypoints | <https://tsx.is> |
| pnpm | Package manager and script runner | <https://pnpm.io> |
| `simple-git-hooks` | Local pre-push hook wiring | <https://github.com/toplenboren/simple-git-hooks> |

## Infrastructure

| Surface | Why it matters | Official docs |
|---------|----------------|---------------|
| systemd user services | DiscoClaw ships a user service in `systemd/discoclaw.service` | `systemd.service`: <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html><br>`systemd.unit`: <https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html> |
| Tailscale Funnel | External webhook/dashboard publishing and exposure guidance referenced from `docs/webhook-exposure.md` and `docs/dashboard-tailscale.md` | Funnel docs: <https://tailscale.com/docs/features/tailscale-funnel><br>Tailscale Serve/Funnel overview: <https://tailscale.com/docs/features/tailscale-serve> |

## Secondary References

Blog posts, Stack Overflow answers, GitHub issues, Discord threads, and LLM training data are secondary references. They are useful for troubleshooting, but official docs and maintainer-owned repos are the authoritative source for model IDs, API parameters, auth requirements, and dependency behavior.
