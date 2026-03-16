import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  executeImagegenAction,
  IMAGEGEN_ACTION_TYPES,
  imagegenActionsPromptSection,
  resolveDefaultModel,
  resolveProvider,
  TYPING_INTERVAL_MS,
  DOT_CYCLE_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from './actions-imagegen.js';
import type { ImagegenContext, SourceImageRef } from './actions-imagegen.js';
import type { ActionContext, ActionCategoryFlags } from './actions.js';
import { buildTieredDiscordActionsPromptSection, parseDiscordActions } from './actions.js';
import { buildUnavailableActionTypesNotice } from './output-common.js';

vi.mock('./image-download.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./image-download.js')>();
  return { ...orig, downloadMessageImages: vi.fn(), downloadImageUrl: vi.fn() };
});
import { downloadMessageImages, downloadImageUrl } from './image-download.js';
const mockDownloadMessageImages = vi.mocked(downloadMessageImages);
const mockDownloadImageUrl = vi.mocked(downloadImageUrl);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockChannel(overrides: Partial<any> = {}) {
  return {
    id: overrides.id ?? 'ch1',
    name: overrides.name ?? 'art',
    type: overrides.type ?? ChannelType.GuildText,
    send: vi.fn(async (_opts: any) => ({
      id: 'sent-1',
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    })),
    sendTyping: vi.fn(async () => {}),
  };
}

function makeCtx(channels: any[]): ActionContext {
  const cache = new Map<string, any>();
  for (const ch of channels) cache.set(ch.id, ch);

  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of cache.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
          values: () => cache.values(),
        },
      },
    } as any,
    client: {} as any,
    channelId: 'origin-ch',
    messageId: 'msg1',
  };
}

function makeMockAttachment(overrides: Partial<{ url: string; name: string; contentType: string; size: number }> = {}) {
  return {
    url: overrides.url ?? 'https://cdn.discordapp.com/attachments/123/456/image.png',
    name: overrides.name ?? 'image.png',
    contentType: overrides.contentType ?? 'image/png',
    size: overrides.size ?? 1024,
  };
}

function makeMockMessage(attachments: any[] = []) {
  const attMap = new Map<string, any>();
  attachments.forEach((att, i) => attMap.set(String(i), att));
  return {
    id: 'msg1',
    attachments: attMap,
  };
}

function makeMockTextChannelForClient(messages: Map<string, any> = new Map()) {
  return {
    id: 'origin-ch',
    messages: {
      fetch: vi.fn(async (id: string) => {
        const msg = messages.get(id);
        if (!msg) throw new Error('Unknown Message');
        return msg;
      }),
    },
  };
}

function makeCtxWithClient(channels: any[], clientChannels: Map<string, any> = new Map()): ActionContext {
  const cache = new Map<string, any>();
  for (const ch of channels) cache.set(ch.id, ch);

  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of cache.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
          values: () => cache.values(),
        },
      },
    } as any,
    client: {
      channels: {
        fetch: vi.fn(async (id: string) => {
          const ch = clientChannels.get(id);
          if (!ch) throw new Error('Unknown Channel');
          return ch;
        }),
      },
    } as any,
    channelId: 'origin-ch',
    messageId: 'msg1',
  };
}

function makeImagegenCtx(overrides: Partial<ImagegenContext> = {}): ImagegenContext {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.openai.com/v1',
    ...overrides,
  };
}

function makeSuccessResponse(b64 = 'aGVsbG8='): Response {
  return new Response(
    JSON.stringify({ data: [{ b64_json: b64, revised_prompt: 'A serene mountain lake' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeGeminiSuccessResponse(b64 = 'aGVsbG8='): Response {
  return new Response(
    JSON.stringify({ predictions: [{ bytesBase64Encoded: b64 }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeGeminiNativeSuccessResponse(b64 = 'aGVsbG8='): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'Here is the generated image.' },
            { inlineData: { mimeType: 'image/png', data: b64 } },
          ],
        },
      }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IMAGEGEN_ACTION_TYPES', () => {
  it('contains generateImage', () => {
    expect(IMAGEGEN_ACTION_TYPES.has('generateImage')).toBe(true);
  });
});

describe('imagegenActionsPromptSection', () => {
  it('returns a string containing key fields', () => {
    const section = imagegenActionsPromptSection();
    expect(typeof section).toBe('string');
    expect(section).toContain('generateImage');
    expect(section).toContain('prompt');
    expect(section).toContain('channel');
    expect(section).toContain('dall-e-3');
  });

  it('includes resolved default model when provided', () => {
    const section = imagegenActionsPromptSection('gpt-image-1');
    expect(section).toContain('Default is `gpt-image-1`');
    expect(section).toContain('Omit this field to use the default');
  });

  it('omits default model note when not provided', () => {
    const section = imagegenActionsPromptSection();
    expect(section).not.toContain('Default is `');
    expect(section).toContain('Default depends on configuration');
  });
});

describe('resolveProvider', () => {
  it('detects gemini from imagen- prefix', () => {
    expect(resolveProvider('imagen-4.0-generate-001')).toBe('gemini');
    expect(resolveProvider('imagen-4.0-fast-generate-001')).toBe('gemini');
  });

  it('detects gemini from gemini- prefix', () => {
    expect(resolveProvider('gemini-3.1-flash-image-preview')).toBe('gemini');
    expect(resolveProvider('gemini-3-pro-image-preview')).toBe('gemini');
  });

  it('detects openai from dall-e- prefix', () => {
    expect(resolveProvider('dall-e-3')).toBe('openai');
    expect(resolveProvider('dall-e-2')).toBe('openai');
  });

  it('detects openai from gpt-image- prefix', () => {
    expect(resolveProvider('gpt-image-1')).toBe('openai');
  });

  it('defaults to openai for unknown model', () => {
    expect(resolveProvider('unknown-model')).toBe('openai');
    expect(resolveProvider('')).toBe('openai');
  });

  it('respects explicit provider override over model prefix', () => {
    expect(resolveProvider('imagen-4.0-generate-001', 'openai')).toBe('openai');
    expect(resolveProvider('dall-e-3', 'gemini')).toBe('gemini');
    expect(resolveProvider('gpt-image-1', 'gemini')).toBe('gemini');
  });
});

describe('generateImage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generates an image and posts it to the channel', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain lake', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #art' });
    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.anything()]),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it('calls the DALL-E API with correct parameters', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);
    const imagegenCtx = makeImagegenCtx({ apiKey: 'my-api-key' });

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', size: '1792x1024', quality: 'hd' },
      ctx,
      imagegenCtx,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer my-api-key',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      model: 'dall-e-3',
      prompt: 'A mountain',
      n: 1,
      size: '1792x1024',
      quality: 'hd',
      response_format: 'b64_json',
    });
  });

  it('uses default size and model when not specified', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('dall-e-3');
    expect(callBody.size).toBe('1024x1024');
    expect(callBody).not.toHaveProperty('quality');
  });

  it('uses a custom model when provided', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'dall-e-2' },
      ctx,
      makeImagegenCtx(),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('dall-e-2');
  });

  it('uses custom baseUrl when provided', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);
    const imagegenCtx = makeImagegenCtx({ baseUrl: 'https://my-proxy.example.com/v1' });

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      imagegenCtx,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://my-proxy.example.com/v1/images/generations',
      expect.anything(),
    );
  });

  it('includes caption as content when provided', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', caption: 'Here is the image' },
      ctx,
      makeImagegenCtx(),
    );

    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Here is the image' }),
    );
  });

  it('omits content key when caption is not provided', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    // calls[0] is the placeholder; calls[1] is the image post
    const callArg = ch.send.mock.calls[1][0];
    expect(callArg).not.toHaveProperty('content');
  });

  it('trims prompt before sending to API', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: '  A mountain  ', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.prompt).toBe('A mountain');
  });

  it('rejects empty prompt', async () => {
    const ctx = makeCtx([]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: '', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: false, error: 'generateImage requires a non-empty prompt' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only prompt', async () => {
    const ctx = makeCtx([]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: '   ', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('non-empty prompt');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('generates image in originating channel when channel is omitted', async () => {
    const originCh = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtx([originCh]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #general' });
    expect(originCh.send).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.arrayContaining([expect.anything()]) }),
    );
  });

  it('generates image in originating channel when channel is empty string', async () => {
    const originCh = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtx([originCh]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #general' });
    expect(originCh.send).toHaveBeenCalled();
  });

  it('still resolves an explicit channel name when provided', async () => {
    const artCh = makeMockChannel({ id: 'ch-art', name: 'art' });
    const originCh = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtx([artCh, originCh]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #art' });
    expect(artCh.send).toHaveBeenCalled();
    expect(originCh.send).not.toHaveBeenCalled();
  });

  it('rejects invalid size', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', size: '100x100' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('"100x100"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid quality', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', quality: 'ultra' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('"ultra"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects caption exceeding 2000 chars', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', caption: 'x'.repeat(2001) },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('2000 character limit');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns error when channel not found', async () => {
    const ctx = makeCtx([]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#nonexistent' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: false, error: 'Channel "#nonexistent" not found' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns descriptive error for forum channel', async () => {
    const forum = makeMockChannel({ id: 'forum1', name: 'art', type: ChannelType.GuildForum });
    const ctx = makeCtx([forum]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: 'art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('forum channel');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns error when API call throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('API request failed');
    expect((result as any).error).toContain('Network error');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error when API returns 400 with message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Invalid prompt')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('API error 400');
    expect((result as any).error).toContain('Invalid prompt');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error when API returns 401 unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Incorrect API key provided')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('401');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error when API returns no image data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error when API returns item without b64_json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ revised_prompt: 'something' }] }), { status: 200 }),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it.each([
    ['256x256'],
    ['512x512'],
    ['1024x1024'],
    ['1024x1792'],
    ['1792x1024'],
  ])('accepts valid size %s', async (size) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', size },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ['standard'],
    ['hd'],
  ])('accepts valid quality %s', async (quality) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', quality },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(true);
  });

  it('resolves channel by ID', async () => {
    const ch = makeMockChannel({ id: 'ch99', name: 'images' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: 'ch99' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #images' });
    expect(ch.send).toHaveBeenCalled();
  });

  it('returns clear error when apiKey is missing for OpenAI', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx({ apiKey: undefined }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('apiKey');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('generateImage — gpt-image-1', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts auto size for gpt-image-1', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size: 'auto' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(true);
  });

  it.each([['1024x1024'], ['1024x1792'], ['1792x1024']])(
    'accepts valid gpt-image-1 size %s',
    async (size) => {
      const ch = makeMockChannel({ name: 'art' });
      const ctx = makeCtx([ch]);

      const result = await executeImagegenAction(
        { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size },
        ctx,
        makeImagegenCtx(),
      );

      expect(result.ok).toBe(true);
    },
  );

  it('rejects 256x256 size for gpt-image-1', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size: '256x256' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('"256x256"');
    expect((result as any).error).toContain('gpt-image-1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects 512x512 size for gpt-image-1', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size: '512x512' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('gpt-image-1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends gpt-image-1 request to OpenAI images endpoint with correct body', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size: '1024x1024' },
      ctx,
      makeImagegenCtx({ apiKey: 'gpt-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer gpt-key',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      model: 'gpt-image-1',
      prompt: 'A mountain',
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    });
  });

  it('parses gpt-image-1 response like DALL-E', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gpt-image-1', size: 'auto' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #art' });
    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.arrayContaining([expect.anything()]) }),
    );
  });
});

describe('generateImage — Gemini', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGeminiSuccessResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls Gemini API with correct URL and auth header', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-goog-api-key': 'gemini-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('sends correct Gemini request body', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain lake', channel: '#art', model: 'imagen-4.0-generate-001', size: '16:9' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      instances: [{ prompt: 'A mountain lake' }],
      parameters: { sampleCount: 1, aspectRatio: '16:9' },
    });
  });

  it('parses Gemini response and posts image', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #art' });
    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.anything()]),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it('returns error when predictions is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ predictions: [] }), { status: 200 }),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on Gemini 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'API key not valid')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'bad-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('401');
    expect((result as any).error).toContain('API key not valid');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on Gemini 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Invalid prompt')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('400');
    expect((result as any).error).toContain('Invalid prompt');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on Gemini 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal server error')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('500');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns clear error when geminiApiKey is missing', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx(), // no geminiApiKey
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('geminiApiKey');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects WxH size for Gemini', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1024x1024' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('"1024x1024"');
    expect((result as any).error).toContain('Gemini');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['1:1'], ['3:4'], ['4:3'], ['9:16'], ['16:9']])(
    'accepts valid Gemini aspect ratio %s',
    async (size) => {
      const ch = makeMockChannel({ name: 'art' });
      const ctx = makeCtx([ch]);

      const result = await executeImagegenAction(
        { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size },
        ctx,
        makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
      );

      expect(result.ok).toBe(true);
    },
  );

  it('uses 1:1 as default size for Gemini when size is omitted', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.parameters.aspectRatio).toBe('1:1');
  });

  it('routes dall-e-3 to Gemini via explicit provider override', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'dall-e-3', size: '1:1', provider: 'gemini' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.anything(),
    );
  });

  it('routes imagen model to OpenAI via explicit provider override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1024x1024', provider: 'openai' },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.openai.com'),
      expect.anything(),
    );
  });

  it('returns error when Gemini API call throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-4.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('API request failed');
    expect((result as any).error).toContain('Connection refused');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });
});

describe('generateImage — Gemini Native', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGeminiNativeSuccessResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls generateContent URL with correct model path', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-goog-api-key': 'gemini-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('does NOT call the :predict endpoint for gemini- models', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3-pro-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const calledUrl: string = (fetch as any).mock.calls[0][0];
    expect(calledUrl).not.toContain(':predict');
    expect(calledUrl).toContain(':generateContent');
  });

  it('sends correct request body shape (contents/parts)', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A serene lake', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      contents: [{ parts: [{ text: 'A serene lake' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
  });

  it('parses inlineData base64 from response and posts image', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result).toEqual({ ok: true, summary: 'Generated image posted to #art' });
    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.anything()]),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it('finds image part even when text part comes first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { text: 'Some description text.' },
                { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
              ],
            },
          }],
        }),
        { status: 200 },
      ),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
  });

  it('returns error when response has no inlineData part', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No image here.' }] } }] }),
        { status: 200 },
      ),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error when candidates array is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
  });

  it('returns error on 400 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Invalid request')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('API error 400');
    expect((result as any).error).toContain('Invalid request');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'API key not valid')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'bad-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('401');
    expect((result as any).error).toContain('API key not valid');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal server error')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('500');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('API request failed');
    expect((result as any).error).toContain('Connection refused');
    expect(ch.send).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });

  it('skips size validation for gemini- models (no error for any size string)', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview', size: '1024x1024' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalled();
  });

  it('returns clear error when geminiApiKey is missing', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'gemini-3.1-flash-image-preview' },
      ctx,
      makeImagegenCtx(), // no geminiApiKey
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('geminiApiKey');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('default model resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolveDefaultModel returns native Gemini model when geminiApiKey is present', () => {
    expect(resolveDefaultModel({ geminiApiKey: 'gemini-key' })).toBe('gemini-3.1-flash-image-preview');
  });

  it('resolveDefaultModel returns native Gemini model when both keys are present', () => {
    expect(resolveDefaultModel({ apiKey: 'openai-key', geminiApiKey: 'gemini-key' })).toBe('gemini-3.1-flash-image-preview');
  });

  it('resolveDefaultModel falls back to dall-e-3 when no geminiApiKey', () => {
    expect(resolveDefaultModel({ apiKey: 'openai-key' })).toBe('dall-e-3');
    expect(resolveDefaultModel({})).toBe('dall-e-3');
  });

  it('resolveDefaultModel respects explicit defaultModel over geminiApiKey', () => {
    expect(resolveDefaultModel({ defaultModel: 'gpt-image-1', geminiApiKey: 'gemini-key' })).toBe('gpt-image-1');
  });

  it('uses explicit defaultModel from context when set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx({ defaultModel: 'gpt-image-1' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('gpt-image-1');
  });

  it('auto-detects Gemini default when only geminiApiKey is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGeminiNativeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx({ apiKey: undefined, geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-3.1-flash-image-preview:generateContent'),
      expect.anything(),
    );
  });

  it('falls back to dall-e-3 when apiKey is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('dall-e-3');
  });

  it('defaults to native Gemini when both keys are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGeminiNativeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key', geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-3.1-flash-image-preview:generateContent'),
      expect.anything(),
    );
  });

  it('explicit action.model wins over imagegenCtx.defaultModel when both are set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'dall-e-2' },
      ctx,
      makeImagegenCtx({ defaultModel: 'gpt-image-1' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('dall-e-2');
  });
});

// ---------------------------------------------------------------------------
// Source image (image-to-image editing)
// ---------------------------------------------------------------------------

describe('generateImage — sourceImage', () => {
  const geminiModel = 'gemini-3.1-flash-image-preview';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGeminiNativeSuccessResponse()));
    mockDownloadMessageImages.mockReset();
    mockDownloadImageUrl.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setupSourceImageCtx(attachments: any[] = [makeMockAttachment()]) {
    const msg = makeMockMessage(attachments);
    const msgMap = new Map([['msg1', msg]]);
    const clientCh = makeMockTextChannelForClient(msgMap);
    const clientChannels = new Map([['origin-ch', clientCh]]);
    const ch = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtxWithClient([ch], clientChannels);
    return { ctx, ch, msg, clientCh };
  }

  it('resolves source image from current message and builds multipart request', async () => {
    const { ctx, ch } = setupSourceImageCtx();
    mockDownloadMessageImages.mockResolvedValue({
      images: [{ base64: 'aW1hZ2VkYXRh', mediaType: 'image/png' }],
      errors: [],
    });

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Make it a watercolor',
        model: geminiModel,
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
    expect(ch.send).toHaveBeenCalled();

    // Verify multipart request body
    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.contents[0].parts).toHaveLength(2);
    expect(callBody.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'aW1hZ2VkYXRh' },
    });
    expect(callBody.contents[0].parts[1]).toEqual({ text: 'Make it a watercolor' });
  });

  it('defaults channelId and messageId to current context', async () => {
    const { ctx } = setupSourceImageCtx();
    mockDownloadMessageImages.mockResolvedValue({
      images: [{ base64: 'abc', mediaType: 'image/jpeg' }],
      errors: [],
    });

    await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    // Should have fetched the default channel/message
    const clientFetch = (ctx.client.channels.fetch as any);
    expect(clientFetch).toHaveBeenCalledWith('origin-ch');
  });

  it('uses explicit channelId and messageId when provided', async () => {
    const msg = makeMockMessage([makeMockAttachment()]);
    const msgMap = new Map([['custom-msg', msg]]);
    const clientCh = makeMockTextChannelForClient(msgMap);
    const clientChannels = new Map([['custom-ch', clientCh]]);
    const ch = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtxWithClient([ch], clientChannels);

    mockDownloadMessageImages.mockResolvedValue({
      images: [{ base64: 'abc', mediaType: 'image/png' }],
      errors: [],
    });

    await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment', channelId: 'custom-ch', messageId: 'custom-msg' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(ctx.client.channels.fetch).toHaveBeenCalledWith('custom-ch');
    expect(clientCh.messages.fetch).toHaveBeenCalledWith('custom-msg');
  });

  it('selects attachment by attachmentIndex', async () => {
    const att0 = makeMockAttachment({ name: 'first.png' });
    const att1 = makeMockAttachment({ name: 'second.jpg', contentType: 'image/jpeg' });
    const { ctx } = setupSourceImageCtx([att0, att1]);

    mockDownloadMessageImages.mockResolvedValue({
      images: [{ base64: 'c2Vjb25k', mediaType: 'image/jpeg' }],
      errors: [],
    });

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit second image',
        model: geminiModel,
        sourceImage: { type: 'attachment', attachmentIndex: 1 },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
    // downloadMessageImages should have been called with the second attachment
    expect(mockDownloadMessageImages).toHaveBeenCalledWith([att1], 1);
  });

  it('returns error when attachmentIndex is out of bounds', async () => {
    const { ctx } = setupSourceImageCtx([makeMockAttachment()]);

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment', attachmentIndex: 5 },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no attachment at index 5');
    expect((result as any).error).toContain('1 attachment');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns error when message has no attachments', async () => {
    const { ctx } = setupSourceImageCtx([]);

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no attachment at index 0');
    expect((result as any).error).toContain('0 attachments');
  });

  it('returns error when downloadMessageImages rejects the attachment', async () => {
    const { ctx } = setupSourceImageCtx();
    mockDownloadMessageImages.mockResolvedValue({
      images: [],
      errors: ['image.png: unsupported image format (magic bytes don\'t match PNG, JPEG, GIF, or WebP)'],
    });

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('source image attachment rejected');
    expect((result as any).error).toContain('unsupported image format');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects sourceImage with dall-e-3 (OpenAI model)', async () => {
    const { ctx } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: 'dall-e-3',
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('sourceImage is only supported with native Gemini models');
    expect((result as any).error).toContain('dall-e-3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects sourceImage with gpt-image-1 (OpenAI model)', async () => {
    const { ctx } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: 'gpt-image-1',
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('sourceImage is only supported with native Gemini models');
    expect((result as any).error).toContain('gpt-image-1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects sourceImage with imagen-* (non-native Gemini model)', async () => {
    const { ctx } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: 'imagen-4.0-generate-001',
        size: '1:1',
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('sourceImage is only supported with native Gemini models');
    expect((result as any).error).toContain('imagen-4.0-generate-001');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('text-only body is unchanged when sourceImage is omitted', async () => {
    const ch = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtx([ch]);

    await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'A mountain',
        model: geminiModel,
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.contents).toEqual([{ parts: [{ text: 'A mountain' }] }]);
    expect(mockDownloadMessageImages).not.toHaveBeenCalled();
  });

  it('returns error when channel cannot be fetched', async () => {
    const ch = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const clientChannels = new Map<string, any>();
    const ctx = makeCtxWithClient([ch], clientChannels);

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment', channelId: 'nonexistent-ch' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('could not fetch channel');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns error when message cannot be fetched', async () => {
    const clientCh = makeMockTextChannelForClient(new Map());
    const clientChannels = new Map([['origin-ch', clientCh]]);
    const ch = makeMockChannel({ id: 'origin-ch', name: 'general' });
    const ctx = makeCtxWithClient([ch], clientChannels);

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Edit this',
        model: geminiModel,
        sourceImage: { type: 'attachment', messageId: 'nonexistent-msg' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('could not fetch message');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('source-image flow succeeds without explicit model when geminiApiKey is configured', async () => {
    const { ctx, ch } = setupSourceImageCtx();
    mockDownloadMessageImages.mockResolvedValue({
      images: [{ base64: 'aW1hZ2VkYXRh', mediaType: 'image/png' }],
      errors: [],
    });

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Make it a watercolor',
        sourceImage: { type: 'attachment' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
    expect(ch.send).toHaveBeenCalled();

    // Should route to native Gemini generateContent endpoint via default model
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-3.1-flash-image-preview:generateContent'),
      expect.anything(),
    );

    // Source image should be included in the request body
    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.contents[0].parts).toHaveLength(2);
    expect(callBody.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'aW1hZ2VkYXRh' },
    });
  });

  // --- URL variant ---

  it('resolves sourceImage with type url via downloadImageUrl', async () => {
    mockDownloadImageUrl.mockResolvedValue({
      ok: true,
      image: { base64: 'dXJsaW1hZ2U=', mediaType: 'image/jpeg' },
    });

    const { ctx, ch } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Make it a sketch',
        model: geminiModel,
        sourceImage: { type: 'url', url: 'https://example.com/photo.jpg' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(true);
    expect(mockDownloadImageUrl).toHaveBeenCalledWith('https://example.com/photo.jpg');
    expect(mockDownloadMessageImages).not.toHaveBeenCalled();

    // Source image should be included in the request body
    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'dXJsaW1hZ2U=' },
    });
  });

  it('returns error when downloadImageUrl fails for url sourceImage', async () => {
    mockDownloadImageUrl.mockResolvedValue({
      ok: false,
      error: 'sourceImage: only http(s) URLs are allowed',
    });

    const { ctx } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Make it a sketch',
        model: geminiModel,
        sourceImage: { type: 'url', url: 'ftp://example.com/photo.jpg' },
      },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('only http(s) URLs are allowed');
  });

  it('rejects url sourceImage with non-Gemini models', async () => {
    const { ctx } = setupSourceImageCtx();

    const result = await executeImagegenAction(
      {
        type: 'generateImage',
        prompt: 'Make it a sketch',
        model: 'dall-e-3',
        sourceImage: { type: 'url', url: 'https://example.com/photo.jpg' },
      },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sourceImage is only supported with native Gemini models');
    expect(mockDownloadImageUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Prompt section — sourceImage docs
// ---------------------------------------------------------------------------

describe('imagegenActionsPromptSection — sourceImage docs', () => {
  it('includes sourceImage field documentation', () => {
    const section = imagegenActionsPromptSection();
    expect(section).toContain('sourceImage');
    expect(section).toContain('attachment');
    expect(section).toContain('channelId');
    expect(section).toContain('messageId');
    expect(section).toContain('attachmentIndex');
    expect(section).toContain('Only supported with native Gemini models');
  });

  it('documents the URL form of sourceImage', () => {
    const section = imagegenActionsPromptSection();
    expect(section).toContain('"url"');
    expect(section).toContain('http(s)');
    expect(section).toContain('URL form');
  });
});

// ---------------------------------------------------------------------------
// Actionable-guidance codepath (disabled flag → strippedUnrecognizedTypes → notice)
// ---------------------------------------------------------------------------

const IMAGEGEN_OFF_FLAGS: ActionCategoryFlags = {
  channels: false,
  messaging: false,
  guild: false,
  moderation: false,
  polls: false,
  tasks: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
  defer: false,
  config: false,
  imagegen: false,
};

const IMAGEGEN_KEYWORD_FLAGS: ActionCategoryFlags = {
  channels: true,
  messaging: true,
  guild: false,
  moderation: false,
  polls: false,
  tasks: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
  defer: false,
  config: false,
  imagegen: true,
};

describe('generateImage — actionable-guidance when imagegen is disabled', () => {
  it('parseDiscordActions strips generateImage into strippedUnrecognizedTypes when imagegen: false', () => {
    const input = '<discord-action>{"type":"generateImage","prompt":"A cat"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, IMAGEGEN_OFF_FLAGS);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toContain('generateImage');
  });

  it('parseDiscordActions strips generateImage when imagegen flag is absent', () => {
    const flags: ActionCategoryFlags = {
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: false,
      crons: false,
      botProfile: false,
      forge: false,
      plan: false,
      memory: false,
      defer: false,
      config: false,
      // imagegen intentionally omitted
    };
    const input = '<discord-action>{"type":"generateImage","prompt":"A cat"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, flags);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toContain('generateImage');
  });

  it('buildUnavailableActionTypesNotice returns actionable enable-guidance for generateImage', () => {
    const notice = buildUnavailableActionTypesNotice(['generateImage']);
    expect(notice).toContain('Setup walkthrough');
    expect(notice).toContain('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1');
    expect(notice).toContain('OPENAI_API_KEY');
    expect(notice).toContain('IMAGEGEN_GEMINI_API_KEY');
    expect(notice).toContain('`!restart`');
    expect(notice).toContain('`generateImage`');
    expect(notice).not.toContain('unknown type or category disabled');
  });

  it('notice references required API key env vars', () => {
    const notice = buildUnavailableActionTypesNotice(['generateImage']);
    expect(notice).toContain('OPENAI_API_KEY');
    expect(notice).toContain('IMAGEGEN_GEMINI_API_KEY');
    expect(notice).toContain('`!restart`');
  });

  it('full path: disabled imagegen → stripped type → notice contains enable env var', () => {
    const input = '<discord-action>{"type":"generateImage","prompt":"A cat"}</discord-action>';
    const { strippedUnrecognizedTypes } = parseDiscordActions(input, IMAGEGEN_OFF_FLAGS);
    const notice = buildUnavailableActionTypesNotice(strippedUnrecognizedTypes);
    expect(notice).toContain('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1');
    expect(notice).toContain('OPENAI_API_KEY');
    expect(notice).toContain('IMAGEGEN_GEMINI_API_KEY');
    expect(notice).toContain('`!restart`');
  });

  it('routes "generate a mockup" through keyword detection to the imagegen category', () => {
    const selection = buildTieredDiscordActionsPromptSection(IMAGEGEN_KEYWORD_FLAGS, 'ClawBot', {
      channelName: 'general',
      channelContextPath: null,
      isThread: false,
      userText: 'generate a mockup',
    });

    expect(selection.keywordHits).toContain('imagegen');
    expect(selection.tierBuckets.keywordTriggered).toContain('imagegen');
    expect(selection.includedCategories).toContain('imagegen');
    expect(selection.prompt).toContain('### Image Generation');
  });
});

// ---------------------------------------------------------------------------
// Progress UX lifecycle
// ---------------------------------------------------------------------------

describe('generateImage — progress UX', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends placeholder before provider call completes', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    // Let placeholder send resolve
    await vi.advanceTimersByTimeAsync(0);

    // Placeholder should have been sent before fetch resolves
    expect(ch.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'On it.' }),
    );

    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    await promise;
  });

  it('fires sendTyping immediately after placeholder', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(ch.sendTyping).toHaveBeenCalledTimes(1);

    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    await promise;
  });

  it('fires sendTyping on interval', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(ch.sendTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
    expect(ch.sendTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
    expect(ch.sendTyping).toHaveBeenCalledTimes(3);

    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    await promise;
  });

  it('cycles placeholder through dot states', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    await vi.advanceTimersByTimeAsync(0);
    const placeholderMsg = await ch.send.mock.results[0].value;

    await vi.advanceTimersByTimeAsync(DOT_CYCLE_INTERVAL_MS);
    expect(placeholderMsg.edit).toHaveBeenCalledWith('On it..');

    await vi.advanceTimersByTimeAsync(DOT_CYCLE_INTERVAL_MS);
    expect(placeholderMsg.edit).toHaveBeenCalledWith('On it...');

    await vi.advanceTimersByTimeAsync(DOT_CYCLE_INTERVAL_MS);
    expect(placeholderMsg.edit).toHaveBeenLastCalledWith('On it.');

    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    await promise;
  });

  it('clears all timers and deletes placeholder on success', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(true);
    const placeholderMsg = await ch.send.mock.results[0].value;
    expect(placeholderMsg.delete).toHaveBeenCalled();

    // Advance time — no more typing or edits should fire
    const typingCount = ch.sendTyping.mock.calls.length;
    const editCount = placeholderMsg.edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 2);
    expect(ch.sendTyping).toHaveBeenCalledTimes(typingCount);
    expect(placeholderMsg.edit).toHaveBeenCalledTimes(editCount);
  });

  it('clears all timers and deletes placeholder on provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    expect(result.ok).toBe(false);
    const placeholderMsg = await ch.send.mock.results[0].value;
    expect(placeholderMsg.delete).toHaveBeenCalled();

    const typingCount = ch.sendTyping.mock.calls.length;
    const editCount = placeholderMsg.edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 2);
    expect(ch.sendTyping).toHaveBeenCalledTimes(typingCount);
    expect(placeholderMsg.edit).toHaveBeenCalledTimes(editCount);
  });

  it('clears all timers and returns timeout error when request times out', async () => {
    // Mock fetch that only resolves/rejects via AbortSignal
    vi.stubGlobal('fetch', vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');

    const placeholderMsg = await ch.send.mock.results[0].value;
    expect(placeholderMsg.delete).toHaveBeenCalled();
  });

  it('does not surface placeholder edit errors as unhandled rejections', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    ch.send.mockImplementation(async () => ({
      id: 'placeholder',
      edit: vi.fn().mockRejectedValue(new Error('Cannot edit')),
      delete: vi.fn(async () => {}),
    }));
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    await vi.advanceTimersByTimeAsync(DOT_CYCLE_INTERVAL_MS);

    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should complete without surfacing the edit error
    expect(result.ok).toBe(true);
  });

  it('does not surface placeholder delete errors as unhandled rejections', async () => {
    const ch = makeMockChannel({ name: 'art' });
    ch.send.mockImplementation(async () => ({
      id: 'placeholder',
      edit: vi.fn(async () => {}),
      delete: vi.fn().mockRejectedValue(new Error('Cannot delete')),
    }));
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    // Should complete without surfacing the delete error
    expect(result.ok).toBe(true);
  });

  it('no further typing or edits after cleanup on success', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolveFetch = r; })));

    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const promise = executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art' },
      ctx,
      makeImagegenCtx(),
    );

    // Let intervals fire a few times
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);

    // Now resolve fetch and let the function complete
    resolveFetch(makeSuccessResponse());
    await vi.runAllTimersAsync();
    await promise;

    const placeholderMsg = await ch.send.mock.results[0].value;
    const typingCount = ch.sendTyping.mock.calls.length;
    const editCount = placeholderMsg.edit.mock.calls.length;

    // Advance well past any interval — counts must not change
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 5);
    expect(ch.sendTyping).toHaveBeenCalledTimes(typingCount);
    expect(placeholderMsg.edit).toHaveBeenCalledTimes(editCount);
  });
});
