import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  executeImagegenAction,
  IMAGEGEN_ACTION_TYPES,
  imagegenActionsPromptSection,
  resolveProvider,
} from './actions-imagegen.js';
import type { ImagegenContext } from './actions-imagegen.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockChannel(overrides: Partial<any> = {}) {
  return {
    id: overrides.id ?? 'ch1',
    name: overrides.name ?? 'art',
    type: overrides.type ?? ChannelType.GuildText,
    send: vi.fn(async (_opts: any) => ({ id: 'sent-1' })),
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
    JSON.stringify({ generatedImages: [{ image: { imageBytes: b64 } }] }),
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
});

describe('resolveProvider', () => {
  it('detects gemini from imagen- prefix', () => {
    expect(resolveProvider('imagen-3.0-generate-001')).toBe('gemini');
    expect(resolveProvider('imagen-3.0-fast-generate-001')).toBe('gemini');
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
    expect(resolveProvider('imagen-3.0-generate-001', 'openai')).toBe('openai');
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

    const callArg = ch.send.mock.calls[0][0];
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
    expect(ch.send).not.toHaveBeenCalled();
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
    expect(ch.send).not.toHaveBeenCalled();
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
    expect(ch.send).not.toHaveBeenCalled();
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
    expect(ch.send).not.toHaveBeenCalled();
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
    expect(ch.send).not.toHaveBeenCalled();
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
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImages',
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
      { type: 'generateImage', prompt: 'A mountain lake', channel: '#art', model: 'imagen-3.0-generate-001', size: '16:9' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      prompt: 'A mountain lake',
      number_of_images: 1,
      aspect_ratio: '16:9',
    });
  });

  it('parses Gemini response and posts image', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
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

  it('returns error when generatedImages is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ generatedImages: [] }), { status: 200 }),
    ));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('no image data');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('returns error on Gemini 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'API key not valid')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'bad-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('401');
    expect((result as any).error).toContain('API key not valid');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('returns error on Gemini 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Invalid prompt')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('400');
    expect((result as any).error).toContain('Invalid prompt');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('returns error on Gemini 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal server error')));
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('500');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('returns clear error when geminiApiKey is missing', async () => {
    const ch = makeMockChannel({ name: 'art' });
    const ctx = makeCtx([ch]);

    const result = await executeImagegenAction(
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1:1' },
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
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1024x1024' },
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
        { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size },
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
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001' },
      ctx,
      makeImagegenCtx({ geminiApiKey: 'gemini-key' }),
    );

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.aspect_ratio).toBe('1:1');
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
      { type: 'generateImage', prompt: 'A mountain', channel: '#art', model: 'imagen-3.0-generate-001', size: '1024x1024', provider: 'openai' },
      ctx,
      makeImagegenCtx({ apiKey: 'openai-key' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.openai.com'),
      expect.anything(),
    );
  });
});
