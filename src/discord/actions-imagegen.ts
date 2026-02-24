import { AttachmentBuilder } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import { resolveChannel, findChannelRaw, describeChannelType } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImagegenActionRequest =
  | { type: 'generateImage'; prompt: string; channel?: string; size?: string; model?: string; quality?: string; caption?: string; provider?: 'openai' | 'gemini' };

const IMAGEGEN_TYPE_MAP: Record<ImagegenActionRequest['type'], true> = {
  generateImage: true,
};
export const IMAGEGEN_ACTION_TYPES = new Set<string>(Object.keys(IMAGEGEN_TYPE_MAP));

export type ImagegenContext = {
  apiKey?: string;
  baseUrl?: string;
  geminiApiKey?: string;
  defaultModel?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SIZE_OPENAI = '1024x1024';
const DEFAULT_SIZE_GEMINI = '1:1';

const DALLE_VALID_SIZES = new Set(['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024']);
const GPT_IMAGE_VALID_SIZES = new Set(['1024x1024', '1024x1792', '1792x1024', 'auto']);
const GEMINI_VALID_SIZES = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

const VALID_QUALITY = new Set(['standard', 'hd']);
const DISCORD_MAX_CONTENT = 2000;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export function resolveDefaultModel(imagegenCtx: ImagegenContext): string {
  if (imagegenCtx.defaultModel) return imagegenCtx.defaultModel;
  if (imagegenCtx.geminiApiKey && !imagegenCtx.apiKey) return 'imagen-4.0-generate-001';
  return 'dall-e-3';
}

export function resolveProvider(model: string, explicit?: 'openai' | 'gemini'): 'openai' | 'gemini' {
  if (explicit !== undefined) return explicit;
  if (model.startsWith('imagen-')) return 'gemini';
  if (model.startsWith('dall-e-') || model.startsWith('gpt-image-')) return 'openai';
  return 'openai';
}

// ---------------------------------------------------------------------------
// API callers
// ---------------------------------------------------------------------------

async function callOpenAI(
  prompt: string,
  model: string,
  size: string,
  quality: string | undefined,
  apiKey: string,
  baseUrl: string,
): Promise<{ ok: true; b64: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size,
    response_format: 'b64_json',
  };
  if (quality !== undefined) {
    body.quality = quality;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `generateImage: API request failed: ${msg}` };
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json() as { error?: { message?: string } };
      detail = errBody.error?.message ?? '';
    } catch {
      // ignore parse error
    }
    return { ok: false, error: `generateImage: API error ${response.status}${detail ? `: ${detail}` : ''}` };
  }

  type DalleResponse = { data: Array<{ b64_json?: string; revised_prompt?: string }> };
  let data: DalleResponse;
  try {
    data = await response.json() as DalleResponse;
  } catch {
    return { ok: false, error: 'generateImage: failed to parse API response' };
  }

  const imageItem = data.data?.[0];
  if (!imageItem?.b64_json) {
    return { ok: false, error: 'generateImage: API returned no image data' };
  }

  return { ok: true, b64: imageItem.b64_json };
}

async function callGemini(
  prompt: string,
  model: string,
  size: string,
  geminiApiKey: string,
): Promise<{ ok: true; b64: string } | { ok: false; error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;

  const body: Record<string, unknown> = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: size,
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `generateImage: API request failed: ${msg}` };
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json() as { error?: { message?: string } };
      detail = errBody.error?.message ?? '';
    } catch {
      // ignore parse error
    }
    return { ok: false, error: `generateImage: API error ${response.status}${detail ? `: ${detail}` : ''}` };
  }

  type GeminiResponse = { predictions?: Array<{ bytesBase64Encoded?: string }> };
  let data: GeminiResponse;
  try {
    data = await response.json() as GeminiResponse;
  } catch {
    return { ok: false, error: 'generateImage: failed to parse API response' };
  }

  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) {
    return { ok: false, error: 'generateImage: API returned no image data' };
  }

  return { ok: true, b64 };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeImagegenAction(
  action: ImagegenActionRequest,
  ctx: ActionContext,
  imagegenCtx: ImagegenContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'generateImage': {
      if (!action.prompt?.trim()) {
        return { ok: false, error: 'generateImage requires a non-empty prompt' };
      }
      const model = action.model ?? resolveDefaultModel(imagegenCtx);
      const provider = resolveProvider(model, action.provider);
      const defaultSize = provider === 'gemini' ? DEFAULT_SIZE_GEMINI : DEFAULT_SIZE_OPENAI;
      const size = action.size ?? defaultSize;

      // Per-provider size validation
      if (provider === 'gemini') {
        if (!GEMINI_VALID_SIZES.has(size)) {
          return { ok: false, error: `Invalid size "${size}" for Gemini. Allowed: ${[...GEMINI_VALID_SIZES].join(', ')}` };
        }
      } else if (model.startsWith('gpt-image-')) {
        if (!GPT_IMAGE_VALID_SIZES.has(size)) {
          return { ok: false, error: `Invalid size "${size}" for ${model}. Allowed: ${[...GPT_IMAGE_VALID_SIZES].join(', ')}` };
        }
      } else {
        if (!DALLE_VALID_SIZES.has(size)) {
          return { ok: false, error: `Invalid size "${size}". Allowed: ${[...DALLE_VALID_SIZES].join(', ')}` };
        }
      }

      const quality = action.quality;
      if (quality !== undefined && !VALID_QUALITY.has(quality)) {
        return { ok: false, error: `Invalid quality "${quality}". Allowed: standard, hd` };
      }

      if (action.caption !== undefined && action.caption.length > DISCORD_MAX_CONTENT) {
        return { ok: false, error: `Caption exceeds Discord's ${DISCORD_MAX_CONTENT} character limit (got ${action.caption.length})` };
      }

      const channelInput = action.channel?.trim() || ctx.channelId;
      const channel = resolveChannel(ctx.guild, channelInput);
      if (!channel) {
        const raw = findChannelRaw(ctx.guild, channelInput);
        if (raw) {
          const kind = describeChannelType(raw);
          return { ok: false, error: `Channel "${channelInput}" is a ${kind} channel and cannot receive messages directly.` };
        }
        return { ok: false, error: `Channel "${channelInput}" not found` };
      }

      // Check API key availability
      if (provider === 'gemini') {
        if (!imagegenCtx.geminiApiKey) {
          return { ok: false, error: 'generateImage: geminiApiKey is required for Gemini provider' };
        }
      } else {
        if (!imagegenCtx.apiKey) {
          return { ok: false, error: 'generateImage: apiKey is required for OpenAI provider' };
        }
      }

      // Call provider
      let result: { ok: true; b64: string } | { ok: false; error: string };
      if (provider === 'gemini') {
        result = await callGemini(action.prompt.trim(), model, size, imagegenCtx.geminiApiKey!);
      } else {
        const baseUrl = imagegenCtx.baseUrl ?? 'https://api.openai.com/v1';
        result = await callOpenAI(action.prompt.trim(), model, size, quality, imagegenCtx.apiKey!, baseUrl);
      }

      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      const buf = Buffer.from(result.b64, 'base64');
      const attachment = new AttachmentBuilder(buf, { name: 'image-1.png' });

      const sendOpts: {
        files: AttachmentBuilder[];
        allowedMentions: typeof NO_MENTIONS;
        content?: string;
      } = { files: [attachment], allowedMentions: NO_MENTIONS };
      if (action.caption) {
        sendOpts.content = action.caption;
      }

      await channel.send(sendOpts);
      return { ok: true, summary: `Generated image posted to #${channel.name}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function imagegenActionsPromptSection(): string {
  return `### Image Generation

**generateImage** — Generate an image and post it to a channel:
\`\`\`
<discord-action>{"type":"generateImage","prompt":"A serene mountain lake at sunset","channel":"#art"}</discord-action>
\`\`\`
- \`prompt\` (required): Text description of the image to generate.
- \`channel\` (optional): Channel name (with or without #) or channel ID to post the image to. Defaults to the current channel/thread if omitted.
- \`model\` (optional): Model to use. Default depends on configuration (auto-detected from available API keys). Available models:
  - OpenAI: \`dall-e-3\`, \`gpt-image-1\`
  - Gemini: \`imagen-4.0-generate-001\`, \`imagen-4.0-fast-generate-001\`, \`imagen-4.0-ultra-generate-001\`
- \`provider\` (optional): \`openai\` or \`gemini\`. Auto-detected from model prefix if omitted.
- \`size\` (optional): Depends on provider:
  - OpenAI dall-e-3 / dall-e-2: pixel dimensions — \`1024x1024\` (default), \`1024x1792\`, \`1792x1024\`, \`256x256\`, \`512x512\`
  - OpenAI gpt-image-1: pixel dimensions as above, plus \`auto\`
  - Gemini: aspect ratios — \`1:1\` (default), \`3:4\`, \`4:3\`, \`9:16\`, \`16:9\`
- \`quality\` (optional): \`standard\` (default) or \`hd\` — applies to OpenAI dall-e-3 only.
- \`caption\` (optional): Text message to accompany the image in the channel.`;
}
