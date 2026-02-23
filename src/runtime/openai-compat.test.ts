import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatRuntime, useMaxCompletionTokens } from './openai-compat.js';
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

/** Like makeSSEResponse but does NOT append a trailing newline — simulates EOF without \n. */
function makeSSEResponseRaw(rawText: string, status = 200, statusText = 'OK'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(rawText));
      controller.close();
    },
  });
  return new Response(stream, { status, statusText });
}

function makeSSEData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
}

describe('OpenAI-compat runtime adapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('happy path: SSE stream with 3 chunks + [DONE]', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeSSEData('Hello'),
        makeSSEData(' world'),
        makeSSEData('!'),
        'data: [DONE]',
      ]),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(['Hello', ' world', '!']);

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('Hello world!');

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
  });

  it('HTTP error (401) yields error + done', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('401');

    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('HTTP error (500) yields error + done', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('500');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('network error yields error + done', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('ECONNREFUSED');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('timeout yields error + done', async () => {
    // Mock fetch that delays longer than the timeout
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }
      });
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
      timeoutMs: 50,
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('timed out');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('empty stream (immediate [DONE]) yields empty text_final + done', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse(['data: [DONE]']),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('stream without [DONE] still emits text_final + done', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeSSEData('Hello'),
        makeSSEData(' there'),
        // No [DONE] — stream just ends
      ]),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('Hello there');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('model override: params.model takes precedence over defaultModel', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: 'gpt-4o-mini',
      cwd: '/tmp',
    }));

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('gpt-4o-mini');
  });

  it('ignores tools/sessions — no error, tools not in request body', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
      tools: ['Read', 'Glob', 'Grep'],
      sessionKey: 'test-session',
    }));

    // Should complete without error
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();

    // Request body should not contain tools
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.tools).toBeUndefined();
  });

  it('data: without space after colon is parsed correctly', async () => {
    // SSE spec allows "data:payload" (no space) — some endpoints emit this form
    const noSpaceData = `data:${JSON.stringify({ choices: [{ delta: { content: 'no-space' } }] })}`;
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([noSpaceData, 'data:[DONE]']),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { text: string }).text).toBe('no-space');

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('no-space');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  // ---------------------------------------------------------------------------
  // OAuth 401 retry tests
  // ---------------------------------------------------------------------------

  it('401 with OAuth: force-refresh token and retry succeeds', async () => {
    const capturedHeaders: string[] = [];
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++;
      capturedHeaders.push(init?.headers && (init.headers as Record<string, string>)['Authorization'] || '');
      if (callCount === 1) {
        // First call returns 401
        return Promise.resolve(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
      }
      // Retry succeeds
      return Promise.resolve(makeSSEResponse([
        makeSSEData('retried'),
        'data: [DONE]',
      ]));
    });

    let forceRefreshCalled = false;
    const tokenProvider = {
      getAccessToken: vi.fn().mockImplementation((forceRefresh?: boolean) => {
        if (forceRefresh) forceRefreshCalled = true;
        return Promise.resolve(forceRefresh ? 'refreshed-token' : 'stale-token');
      }),
    };

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      auth: 'chatgpt_oauth',
      tokenProvider,
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(forceRefreshCalled).toBe(true);
    expect(callCount).toBe(2);

    // First request used the stale token, retry used the refreshed token
    expect(capturedHeaders[0]).toBe('Bearer stale-token');
    expect(capturedHeaders[1]).toBe('Bearer refreshed-token');

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('retried');
    expect(events[events.length - 1]!.type).toBe('done');
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });

  it('401 with OAuth: retry also fails yields error + done', async () => {
    // Both calls return 401
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const tokenProvider = {
      getAccessToken: vi.fn().mockImplementation((forceRefresh?: boolean) =>
        Promise.resolve(forceRefresh ? 'refreshed-token' : 'stale-token'),
      ),
    };

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      auth: 'chatgpt_oauth',
      tokenProvider,
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    // Should have called getAccessToken twice (initial + force refresh)
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getAccessToken).toHaveBeenLastCalledWith(true);

    // Should have made two HTTP attempts (initial + retry)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('401');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('401 with static API key: no retry, yields error + done', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    // fetch should only be called once — no retry for static API keys
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('401');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('adapter id defaults to "openai" when id is not provided', () => {
    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });
    expect(rt.id).toBe('openai');
  });

  it('adapter id uses override when id is provided in opts', () => {
    const rt = createOpenAICompatRuntime({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      defaultModel: 'openai/gpt-4o',
    });
    expect(rt.id).toBe('openrouter');
  });

  // ---------------------------------------------------------------------------
  // maxTokens field routing tests
  // ---------------------------------------------------------------------------

  it('maxTokens with standard model (gpt-4o) sends max_tokens', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: 'gpt-4o',
      cwd: '/tmp',
      maxTokens: 512,
    }));

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.max_tokens).toBe(512);
    expect(parsed.max_completion_tokens).toBeUndefined();
  });

  it('maxTokens with newer model (o3-mini) sends max_completion_tokens', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: 'o3-mini',
      cwd: '/tmp',
      maxTokens: 1024,
    }));

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.max_completion_tokens).toBe(1024);
    expect(parsed.max_tokens).toBeUndefined();
  });

  it('no maxTokens set: neither max_tokens nor max_completion_tokens in request body', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: 'gpt-4o',
      cwd: '/tmp',
    }));

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.max_tokens).toBeUndefined();
    expect(parsed.max_completion_tokens).toBeUndefined();
  });

  it('stream ending without trailing newline still processes buffered data', async () => {
    // Simulate a stream that ends with a data line but no trailing \n
    const chunk = makeSSEData('buffered');
    const rawText = `${chunk}`; // no trailing newline
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponseRaw(rawText),
    );

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { text: string }).text).toBe('buffered');

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('buffered');
    expect(events[events.length - 1]!.type).toBe('done');
  });
});
