import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiRestRuntime } from './gemini-rest.js';
import { normalizeRuntimeFailure } from './runtime-failure.js';
import type { EngineEvent } from './types.js';

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const evt of iter) {
    events.push(evt);
  }
  return events;
}

function makeSSEResponse(chunks: string[], status = 200, statusText = 'OK'): Response {
  const text = chunks.join('\n') + '\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status, statusText });
}

function makeGeminiSSEData(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  })}`;
}

function makeGeminiSSEDataWithUsage(text: string, usage: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usage,
  })}`;
}

describe('Gemini REST runtime adapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('happy path: SSE stream with text chunks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeGeminiSSEData('Hello'),
        makeGeminiSSEData(' world'),
        makeGeminiSSEData('!'),
      ]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'Say hi', model: '', cwd: '/tmp' }),
    );

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(['Hello', ' world', '!']);

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('Hello world!');

    expect(events.at(-1)?.type).toBe('done');
  });

  it('sends API key as x-goog-api-key header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeGeminiSSEData('ok')]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'my-secret-key',
      defaultModel: 'gemini-2.5-flash',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('my-secret-key');
  });

  it('uses streamGenerateContent endpoint with alt=sse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeGeminiSSEData('ok')]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    await collectEvents(
      runtime.invoke({ prompt: 'test', model: 'gemini-2.5-pro', cwd: '/tmp' }),
    );

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });

  it('falls back to defaultModel when params.model is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeGeminiSSEData('ok')]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
  });

  it('splits system prompt from user message using sentinel', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeGeminiSSEData('ok')]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    const prompt =
      'System context here\n---\nThe sections above are internal system context.\nUser message here';

    await collectEvents(runtime.invoke({ prompt, model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);

    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts[0].text).toContain('System context here');
    expect(body.contents[0].parts[0].text).toBe('User message here');
  });

  it('emits usage events when usageMetadata is present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeGeminiSSEDataWithUsage('ok', {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        }),
      ]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect((usage as { inputTokens: number }).inputTokens).toBe(10);
    expect((usage as { outputTokens: number }).outputTokens).toBe(5);
  });

  it('emits error event on non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
      }),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    const failure = normalizeRuntimeFailure((error as { message: string }).message);
    expect(failure.message).toContain('429');
    expect(failure.message).toContain('quota exceeded');
    expect((error as { failure?: { message: string } }).failure?.message).toContain('429');
  });

  it('reports aborted when caller signal fires', async () => {
    const ac = new AbortController();
    ac.abort();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp', signal: ac.signal }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    const failure = normalizeRuntimeFailure((error as { message: string }).message);
    expect(failure.message).toBe('aborted');
    expect((error as { failure?: { message: string } }).failure?.message).toBe('aborted');
  });

  it('has runtime id "gemini"', () => {
    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    });
    expect(runtime.id).toBe('gemini');
  });

  it('exposes defaultModel', () => {
    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-pro',
    });
    expect(runtime.defaultModel).toBe('gemini-2.5-pro');
  });

  it('logs warning when response has no text parts', async () => {
    const candidate = { content: { parts: [] }, finishReason: 'SAFETY' };
    const sseData = `data: ${JSON.stringify({ candidates: [candidate] })}`;
    globalThis.fetch = vi.fn().mockResolvedValue(makeSSEResponse([sseData]));

    const log = { debug: vi.fn(), warn: vi.fn() };
    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
      log,
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'SAFETY' }),
      'gemini-rest: empty response (no text content)',
    );

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('');
  });

  it('logs debug with full candidate on empty response', async () => {
    const candidate = { content: { parts: [] }, finishReason: 'SAFETY' };
    const sseData = `data: ${JSON.stringify({ candidates: [candidate] })}`;
    globalThis.fetch = vi.fn().mockResolvedValue(makeSSEResponse([sseData]));

    const log = { debug: vi.fn(), warn: vi.fn() };
    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
      log,
    });

    await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    expect(log.debug).toHaveBeenCalledWith(
      { candidate },
      'gemini-rest: full candidate on empty response',
    );
  });

  it('supports custom baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeGeminiSSEData('ok')]),
    );

    const runtime = createGeminiRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
      baseUrl: 'https://custom.api.example.com/v1',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain('https://custom.api.example.com/v1/models/');
  });
});
