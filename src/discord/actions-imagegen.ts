import { AttachmentBuilder } from 'discord.js';
import type { TextChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import { resolveChannel, findChannelRaw, describeChannelType } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { downloadMessageImages, downloadImageUrl } from './image-download.js';

/**
 * Maintainers: start with `docs/official-docs.md` before changing model IDs,
 * provider routing, endpoint paths, or request/response handling here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceImageRef =
  | { type: 'attachment'; channelId?: string; messageId?: string; attachmentIndex?: number }
  | { type: 'url'; url: string };

export type ImagegenActionRequest =
  | { type: 'generateImage'; prompt: string; channel?: string; size?: string; model?: string; quality?: string; caption?: string; provider?: 'openai' | 'gemini'; sourceImage?: SourceImageRef };

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
  if (imagegenCtx.geminiApiKey) return 'gemini-3.1-flash-image-preview';
  return 'dall-e-3';
}

export function resolveProvider(model: string, explicit?: 'openai' | 'gemini'): 'openai' | 'gemini' {
  if (explicit !== undefined) return explicit;
  if (model.startsWith('imagen-') || model.startsWith('gemini-')) return 'gemini';
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

async function callGeminiNative(
  prompt: string,
  model: string,
  geminiApiKey: string,
  sourceImage?: { base64: string; mediaType: string },
): Promise<{ ok: true; b64: string } | { ok: false; error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const parts: Array<Record<string, unknown>> = [];
  if (sourceImage) {
    parts.push({ inlineData: { mimeType: sourceImage.mediaType, data: sourceImage.base64 } });
  }
  parts.push({ text: prompt });

  const body = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
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

  type GeminiNativeResponse = {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }>;
      };
    }>;
  };
  let data: GeminiNativeResponse;
  try {
    data = await response.json() as GeminiNativeResponse;
  } catch {
    return { ok: false, error: 'generateImage: failed to parse API response' };
  }

  const responseParts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart?.inlineData?.data) {
    return { ok: false, error: 'generateImage: API returned no image data' };
  }

  return { ok: true, b64: imagePart.inlineData.data };
}

// ---------------------------------------------------------------------------
// Source image resolution
// ---------------------------------------------------------------------------

async function resolveSourceImage(
  sourceImage: SourceImageRef,
  ctx: ActionContext,
): Promise<{ ok: true; base64: string; mediaType: string } | { ok: false; error: string }> {
  if (sourceImage.type === 'url') {
    const dlResult = await downloadImageUrl(sourceImage.url);
    if (!dlResult.ok) {
      return { ok: false, error: `generateImage: ${dlResult.error}` };
    }
    return { ok: true, base64: dlResult.image.base64, mediaType: dlResult.image.mediaType };
  }

  const channelId = sourceImage.channelId ?? ctx.channelId;
  const messageId = sourceImage.messageId ?? ctx.messageId;
  const attachmentIndex = sourceImage.attachmentIndex ?? 0;

  let channel;
  try {
    channel = await ctx.client.channels.fetch(channelId);
  } catch {
    return { ok: false, error: `generateImage: could not fetch channel "${channelId}"` };
  }
  if (!channel || !('messages' in channel)) {
    return { ok: false, error: `generateImage: channel "${channelId}" is not a text channel` };
  }

  let message;
  try {
    message = await (channel as TextChannel).messages.fetch(messageId);
  } catch {
    return { ok: false, error: `generateImage: could not fetch message "${messageId}"` };
  }

  const attachments = [...message.attachments.values()];
  if (attachmentIndex < 0 || attachmentIndex >= attachments.length) {
    return { ok: false, error: `generateImage: no attachment at index ${attachmentIndex} (message has ${attachments.length} attachment${attachments.length === 1 ? '' : 's'})` };
  }

  const target = attachments[attachmentIndex];
  const result = await downloadMessageImages([target], 1);

  if (result.images.length === 0) {
    const reason = result.errors.length > 0 ? `: ${result.errors[0]}` : '';
    return { ok: false, error: `generateImage: source image attachment rejected${reason}` };
  }

  return { ok: true, base64: result.images[0].base64, mediaType: result.images[0].mediaType };
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
        if (!model.startsWith('gemini-') && !GEMINI_VALID_SIZES.has(size)) {
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

      // Resolve source image if provided
      let resolvedSourceImage: { base64: string; mediaType: string } | undefined;
      if (action.sourceImage) {
        if (!model.startsWith('gemini-')) {
          return { ok: false, error: `generateImage: sourceImage is only supported with native Gemini models (gemini-*), not "${model}"` };
        }
        const srcResult = await resolveSourceImage(action.sourceImage, ctx);
        if (!srcResult.ok) {
          return { ok: false, error: srcResult.error };
        }
        resolvedSourceImage = { base64: srcResult.base64, mediaType: srcResult.mediaType };
      }

      // Call provider
      let result: { ok: true; b64: string } | { ok: false; error: string };
      if (provider === 'gemini') {
        if (model.startsWith('gemini-')) {
          result = await callGeminiNative(action.prompt.trim(), model, imagegenCtx.geminiApiKey!, resolvedSourceImage);
        } else {
          result = await callGemini(action.prompt.trim(), model, size, imagegenCtx.geminiApiKey!);
        }
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

export function imagegenActionsPromptSection(resolvedDefaultModel?: string): string {
  const modelFieldDoc = resolvedDefaultModel
    ? `- \`model\` (optional): Default is \`${resolvedDefaultModel}\`. Omit this field to use the default; only set it when a different model is explicitly needed. Supported families/examples:`
    : `- \`model\` (optional): Default depends on configuration. Supported families/examples:`;
  return `### Image Generation

**generateImage** — Generate an image and post it to a channel:
\`\`\`
<discord-action>{"type":"generateImage","prompt":"A serene mountain lake at sunset","channel":"#art"}</discord-action>
\`\`\`
- \`prompt\` (required): Text description of the image to generate.
- \`channel\` (optional): Channel name (with or without #) or channel ID to post the image to. Defaults to the current channel/thread if omitted.
${modelFieldDoc}
  - OpenAI: \`dall-e-3\`, \`gpt-image-1\`
  - Gemini (Imagen): \`imagen-4.0-generate-001\`, \`imagen-4.0-fast-generate-001\`, \`imagen-4.0-ultra-generate-001\`
  - Gemini (native): \`gemini-3.1-flash-image-preview\`, \`gemini-3-pro-image-preview\`
- \`provider\` (optional): \`openai\` or \`gemini\`. Auto-detected from model prefix if omitted.
- \`size\` (optional): Depends on provider:
  - OpenAI dall-e-3 / dall-e-2: pixel dimensions — \`1024x1024\` (default), \`1024x1792\`, \`1792x1024\`, \`256x256\`, \`512x512\`
  - OpenAI gpt-image-1: pixel dimensions as above, plus \`auto\`
  - Gemini (Imagen): aspect ratios — \`1:1\` (default), \`3:4\`, \`4:3\`, \`9:16\`, \`16:9\`
  - Gemini (native): size/aspect-ratio params do not apply — omit \`size\` for these models
- \`quality\` (optional): \`standard\` (default) or \`hd\` — applies to OpenAI dall-e-3 only.
- \`caption\` (optional): Text message to accompany the image in the channel.
- \`sourceImage\` (optional): Provide a source image for image-to-image editing. **Only supported with native Gemini models** (\`gemini-*\`). Two forms:
  - **Attachment form** — reference a Discord message attachment:
    - \`type\` (required): \`"attachment"\`
    - \`channelId\` (optional): Channel ID of the message containing the image. Defaults to the current channel.
    - \`messageId\` (optional): Message ID containing the image attachment. Defaults to the current message.
    - \`attachmentIndex\` (optional): Zero-based index of the attachment to use. Defaults to \`0\` (first attachment).
    - Example — edit the image from the current message:
      \`\`\`
      <discord-action>{"type":"generateImage","prompt":"Make this image look like a watercolor painting","model":"gemini-3.1-flash-image-preview","sourceImage":{"type":"attachment"}}</discord-action>
      \`\`\`
    - Example — edit an image from a specific message:
      \`\`\`
      <discord-action>{"type":"generateImage","prompt":"Add a sunset sky","model":"gemini-3.1-flash-image-preview","sourceImage":{"type":"attachment","channelId":"123","messageId":"456","attachmentIndex":1}}</discord-action>
      \`\`\`
  - **URL form** — provide a public http(s) image URL directly:
    - \`type\` (required): \`"url"\`
    - \`url\` (required): A public \`http(s)\` image URL (PNG, JPEG, GIF, or WebP).
    - Example:
      \`\`\`
      <discord-action>{"type":"generateImage","prompt":"Make this photo a pencil sketch","model":"gemini-3.1-flash-image-preview","sourceImage":{"type":"url","url":"https://example.com/photo.jpg"}}</discord-action>
      \`\`\``;
}
