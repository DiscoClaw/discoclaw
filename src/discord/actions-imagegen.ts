import { AttachmentBuilder } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import { resolveChannel, findChannelRaw, describeChannelType } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImagegenActionRequest =
  | { type: 'generateImage'; prompt: string; channel: string; size?: string; model?: string; quality?: string; caption?: string; provider?: 'openai' | 'gemini' };

const IMAGEGEN_TYPE_MAP: Record<ImagegenActionRequest['type'], true> = {
  generateImage: true,
};
export const IMAGEGEN_ACTION_TYPES = new Set<string>(Object.keys(IMAGEGEN_TYPE_MAP));

export type ImagegenContext = {
  apiKey?: string;
  baseUrl?: string;
  geminiApiKey?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'dall-e-3';
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImages`;

  const body: Record<string, unknown> = {
    prompt,
    number_of_images: 1,
    aspect_ratio: size,
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

  type GeminiResponse = { generatedImages?: Array<{ image?: { imageBytes?: string } }> };
  let data: GeminiResponse;
  try {
    data = await response.json() as GeminiResponse;
  } catch {
    return { ok: false, error: 'generateImage: failed to parse API response' };
  }

  const b64 = data.generatedImages?.[0]?.image?.imageBytes;
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
      if (!action.channel?.trim()) {
        return { ok: false, error: 'generateImage requires a non-empty channel' };
      }

      const model = action.model ?? DEFAULT_MODEL;
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

      const channel = resolveChannel(ctx.guild, action.channel);
      if (!channel) {
        const raw = findChannelRaw(ctx.guild, action.channel);
        if (raw) {
          const kind = describeChannelType(raw);
          return { ok: false, error: `Channel "${action.channel}" is a ${kind} channel and cannot receive messages directly.` };
        }
        return { ok: false, error: `Channel "${action.channel}" not found` };
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

**generateImage** — Generate an image with DALL-E and post it to a channel:
\`\`\`
<discord-action>{"type":"generateImage","prompt":"A serene mountain lake at sunset","channel":"#art"}</discord-action>
\`\`\`
- \`prompt\` (required): Text description of the image to generate.
- \`channel\` (required): Channel name (with or without #) or channel ID to post the image to.
- \`size\` (optional): Image dimensions. Allowed: \`1024x1024\` (default), \`1024x1792\`, \`1792x1024\` (tall/wide, dall-e-3 only), \`256x256\`, \`512x512\`.
- \`model\` (optional): Model to use. Default: \`dall-e-3\`.
- \`quality\` (optional): \`standard\` (default) or \`hd\` (dall-e-3 only, higher detail and cost).
- \`caption\` (optional): Text message to accompany the image in the channel.
- \`provider\` (optional): \`openai\` or \`gemini\`. Auto-detected from model name if omitted.`;
}
