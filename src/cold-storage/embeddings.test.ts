import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from './embeddings.js';

function makeEmbeddingResponse(embeddings: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: embeddings.map((emb, i) => ({ embedding: emb, index: i })),
    }),
    { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } },
  );
}

function fakeDims(dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => i * 0.001);
}

describe('OpenAIEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns Float32Array embeddings for a single text', async () => {
    const dims = fakeDims(1536);
    globalThis.fetch = vi.fn().mockResolvedValue(makeEmbeddingResponse([dims]));

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const result = await provider.embed(['hello']);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(1536);
  });

  it('dimensions property defaults to 1536', () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    expect(provider.dimensions).toBe(1536);
  });

  it('dimensions property uses custom value', () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 768 });
    expect(provider.dimensions).toBe(768);
  });

  it('sends correct request body', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(1536)]));
    });

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    await provider.embed(['test text']);

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('text-embedding-3-small');
    expect(parsed.input).toEqual(['test text']);
    expect(parsed.dimensions).toBe(1536);
  });

  it('sends Authorization header with API key', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(1536)]));
    });

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-secret' });
    await provider.embed(['test']);

    expect(capturedHeaders!['Authorization']).toBe('Bearer sk-secret');
  });

  it('returns empty array for empty input', async () => {
    globalThis.fetch = vi.fn();

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const result = await provider.embed([]);

    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // ── Batch splitting ────────────────────────────────────────────────

  it('batches 101 texts into 2 API calls', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const embeddings = (body.input as string[]).map(() => fakeDims(1536));
      return Promise.resolve(makeEmbeddingResponse(embeddings));
    });
    globalThis.fetch = fetchMock;

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const texts = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    const result = await provider.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First batch has 100 texts, second has 1
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body1.input).toHaveLength(100);
    expect(body2.input).toHaveLength(1);

    expect(result).toHaveLength(101);
    expect(result[100]).toBeInstanceOf(Float32Array);
  });

  it('exactly 100 texts uses a single API call', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const embeddings = (body.input as string[]).map(() => fakeDims(1536));
      return Promise.resolve(makeEmbeddingResponse(embeddings));
    });
    globalThis.fetch = fetchMock;

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
    const result = await provider.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(100);
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('graceful degradation: returns empty array on 4xx error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'bad-key', log });
    const result = await provider.embed(['hello']);

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('graceful degradation: returns empty array on 5xx error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', log });
    const result = await provider.embed(['hello']);

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('graceful degradation: returns empty array on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', log });
    const result = await provider.embed(['hello']);

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('logs warning with error details on failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', log });
    await provider.embed(['hello']);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'embedding request failed, returning empty results',
    );
  });

  it('batch failure: error in second batch returns empty for all', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeEmbeddingResponse(
        Array.from({ length: 100 }, () => fakeDims(1536)),
      ))
      .mockResolvedValueOnce(
        new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }),
      );
    globalThis.fetch = fetchMock;

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', log });
    const texts = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    const result = await provider.embed(texts);

    // Fail-open: entire call returns empty on any batch failure
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // ── Response ordering ──────────────────────────────────────────────

  it('preserves order even if API returns embeddings out of order', async () => {
    // Return embeddings with reversed index ordering
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.9, 0.9, 0.9], index: 1 },
            { embedding: [0.1, 0.1, 0.1], index: 0 },
          ],
        }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 3 });
    const result = await provider.embed(['first', 'second']);

    expect(result).toHaveLength(2);
    // First input should get the embedding at index 0 (0.1 values)
    expect(result[0][0]).toBeCloseTo(0.1);
    // Second input should get the embedding at index 1 (0.9 values)
    expect(result[1][0]).toBeCloseTo(0.9);
  });

  // ── Custom base URL ────────────────────────────────────────────────

  it('uses custom base URL when provided', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(1536)]));
    });

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://custom.api.com/v1',
    });
    await provider.embed(['test']);

    expect(capturedUrl).toBe('https://custom.api.com/v1/embeddings');
  });
});
