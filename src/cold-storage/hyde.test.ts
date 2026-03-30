import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateHypotheticalAnswer } from './hyde.js';

function makeChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } },
  );
}

function defaultOpts(overrides: Partial<Parameters<typeof generateHypotheticalAnswer>[0]> = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    query: 'What is the capital of France?',
    ...overrides,
  };
}

describe('generateHypotheticalAnswer', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns generated text on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeChatResponse('Paris is the capital of France.'),
    );

    const result = await generateHypotheticalAnswer(defaultOpts());

    expect(result).toBe('Paris is the capital of France.');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toBe('What is the capital of France?');
  });

  it('returns null on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await generateHypotheticalAnswer(defaultOpts({ log }));

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null on timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    // Speed up the test by mocking timers
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const promise = generateHypotheticalAnswer(defaultOpts({ log }));

    await vi.advanceTimersByTimeAsync(16_000);
    const result = await promise;

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('returns null on empty response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeChatResponse(''));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await generateHypotheticalAnswer(defaultOpts({ log }));

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null on whitespace-only response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeChatResponse('   \n\t  '));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await generateHypotheticalAnswer(defaultOpts({ log }));

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('strips trailing slashes from baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeChatResponse('Some answer'),
    );

    await generateHypotheticalAnswer(defaultOpts({ baseUrl: 'https://api.openai.com/v1/' }));

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await generateHypotheticalAnswer(defaultOpts({ log }));

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
