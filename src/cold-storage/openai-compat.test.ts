import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatEmbeddingProvider } from './openai-compat.js';

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

function defaultOpts(overrides: Partial<ConstructorParameters<typeof OpenAICompatEmbeddingProvider>[0]> = {}) {
  return {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'test-key',
    model: 'nomic-embed-text',
    dimensions: 384,
    ...overrides,
  };
}

describe('OpenAICompatEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns Float32Array embeddings', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeEmbeddingResponse([fakeDims(384)]));

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts());
    const result = await provider.embed(['hello']);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(384);
  });

  it('dimensions property matches configured value', () => {
    const provider = new OpenAICompatEmbeddingProvider(defaultOpts());
    expect(provider.dimensions).toBe(384);
  });

  it('strips provider namespace prefix from model name', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(384)]));
    });

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ model: 'openai/nomic-embed-text' }));
    await provider.embed(['test']);

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('nomic-embed-text');
  });

  it('does not send dimensions in request body', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(384)]));
    });

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts());
    await provider.embed(['test']);

    const parsed = JSON.parse(capturedBody!);
    expect(parsed).not.toHaveProperty('dimensions');
  });

  it('uses configured baseUrl and strips trailing slashes', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(makeEmbeddingResponse([fakeDims(384)]));
    });

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ baseUrl: 'http://localhost:11434/v1/' }));
    await provider.embed(['test']);

    expect(capturedUrl).toBe('http://localhost:11434/v1/embeddings');
  });

  it('returns empty array for empty input', async () => {
    globalThis.fetch = vi.fn();

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts());
    const result = await provider.embed([]);

    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('batches 101 texts into 2 API calls', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const embeddings = (body.input as string[]).map(() => fakeDims(384));
      return Promise.resolve(makeEmbeddingResponse(embeddings));
    });
    globalThis.fetch = fetchMock;

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts());
    const texts = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    const result = await provider.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body1.input).toHaveLength(100);
    expect(body2.input).toHaveLength(1);

    expect(result).toHaveLength(101);
  });

  it('graceful degradation: returns empty array on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ apiKey: 'bad-key', log }));
    const result = await provider.embed(['hello']);

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('graceful degradation: returns empty array on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ log }));
    const result = await provider.embed(['hello']);

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('preserves order even if API returns embeddings out of order', async () => {
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

    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ dimensions: 3 }));
    const result = await provider.embed(['first', 'second']);

    expect(result).toHaveLength(2);
    expect(result[0][0]).toBeCloseTo(0.1);
    expect(result[1][0]).toBeCloseTo(0.9);
  });

  it('logs warning with error details on failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new OpenAICompatEmbeddingProvider(defaultOpts({ log }));
    await provider.embed(['hello']);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'openai-compat embedding request failed, returning empty results',
    );
  });
});
