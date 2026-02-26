import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatRuntime, useMaxCompletionTokens } from './openai-compat.js';
import { executeToolCall } from './openai-tool-exec.js';
import type { EngineEvent } from './types.js';

vi.mock('./openai-tool-exec.js', () => ({
  executeToolCall: vi.fn(),
}));

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

// ── Helpers for tool loop tests ──────────────────────────────────────

function makeJsonResponse(body: object, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeToolCallResponse(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): Response {
  return makeJsonResponse({
    choices: [{
      message: {
        role: 'assistant',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
    }],
  });
}

function makeTextResponse(content: string): Response {
  return makeJsonResponse({
    choices: [{
      message: { role: 'assistant', content },
    }],
  });
}

// ── Tool loop tests ──────────────────────────────────────────────────

describe('OpenAI-compat tool loop', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.mocked(executeToolCall).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('capabilities include tools_fs and tools_exec when enableTools is set', () => {
    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });
    expect(rt.capabilities.has('tools_fs')).toBe(true);
    expect(rt.capabilities.has('tools_exec')).toBe(true);
    expect(rt.capabilities.has('streaming_text')).toBe(true);
  });

  it('capabilities omit tools when enableTools is not set', () => {
    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    });
    expect(rt.capabilities.has('tools_fs')).toBe(false);
    expect(rt.capabilities.has('tools_exec')).toBe(false);
  });

  it('single tool call round then text response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse([
        { id: 'call_1', name: 'read_file', arguments: JSON.stringify({ file_path: '/tmp/test.txt' }) },
      ]))
      .mockResolvedValueOnce(makeTextResponse('The file says hello.'));
    globalThis.fetch = fetchMock;

    vi.mocked(executeToolCall).mockResolvedValue({ result: 'hello world', ok: true });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Read the file',
      model: '',
      cwd: '/tmp',
      tools: ['Read'],
    }));

    // tool_start and tool_end events emitted
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      type: 'tool_start',
      name: 'Read',
    });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      type: 'tool_end',
      name: 'Read',
      ok: true,
    });

    // Final text response
    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('The file says hello.');
    expect(events[events.length - 1]!.type).toBe('done');

    // executeToolCall called with correct args
    expect(executeToolCall).toHaveBeenCalledWith(
      'read_file',
      { file_path: '/tmp/test.txt' },
      ['/tmp'],
    );

    // First request has tools and stream:false
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body1.tools).toBeDefined();
    expect(body1.stream).toBe(false);

    // Second request includes conversation history with tool result
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.messages).toHaveLength(3); // user + assistant(tool_calls) + tool
    expect(body2.messages[2].role).toBe('tool');
    expect(body2.messages[2].content).toBe('hello world');
  });

  it('multiple tool calls in one response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse([
        { id: 'call_a', name: 'read_file', arguments: JSON.stringify({ file_path: '/tmp/a.txt' }) },
        { id: 'call_b', name: 'read_file', arguments: JSON.stringify({ file_path: '/tmp/b.txt' }) },
      ]))
      .mockResolvedValueOnce(makeTextResponse('Both files read.'));
    globalThis.fetch = fetchMock;

    vi.mocked(executeToolCall)
      .mockResolvedValueOnce({ result: 'content-a', ok: true })
      .mockResolvedValueOnce({ result: 'content-b', ok: true });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Read both files',
      model: '',
      cwd: '/tmp',
      tools: ['Read'],
    }));

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolStarts).toHaveLength(2);
    expect(toolEnds).toHaveLength(2);

    expect(executeToolCall).toHaveBeenCalledTimes(2);

    // Second request has user + assistant + 2 tool messages = 4
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.messages).toHaveLength(4);

    expect(events.find((e) => e.type === 'text_final')).toMatchObject({
      text: 'Both files read.',
    });
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('malformed JSON in tool arguments yields ok:false result fed back to model', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_bad',
              type: 'function',
              function: { name: 'read_file', arguments: '{invalid json' },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(makeTextResponse('Sorry about that.'));
    globalThis.fetch = fetchMock;

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Do something',
      model: '',
      cwd: '/tmp',
      tools: ['Read'],
    }));

    // tool_end with ok: false
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ type: 'tool_end', ok: false });

    // executeToolCall should NOT have been called
    expect(executeToolCall).not.toHaveBeenCalled();

    // Still completes with text response
    expect(events.find((e) => e.type === 'text_final')).toBeDefined();
    expect(events[events.length - 1]!.type).toBe('done');

    // Second request includes error message in tool result
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    const toolMsg = body2.messages.find((m: Record<string, unknown>) => m.role === 'tool');
    expect(toolMsg.content).toContain('Malformed JSON');
  });

  it('safety cap (25 rounds) yields error + done', async () => {
    // Every response returns tool_calls — infinite loop (fresh Response each call)
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(makeToolCallResponse([
        { id: 'call_loop', name: 'read_file', arguments: JSON.stringify({ file_path: '/tmp/x' }) },
      ])),
    );

    vi.mocked(executeToolCall).mockResolvedValue({ result: 'ok', ok: true });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Loop forever',
      model: '',
      cwd: '/tmp',
      tools: ['Read'],
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('safety cap');
    expect(events[events.length - 1]!.type).toBe('done');
    expect(globalThis.fetch).toHaveBeenCalledTimes(25);
  });

  it('allowedRoots built from cwd + addDirs, filtering empty strings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse([
        { id: 'call_1', name: 'read_file', arguments: JSON.stringify({ file_path: '/home/test.txt' }) },
      ]))
      .mockResolvedValueOnce(makeTextResponse('Done.'));
    globalThis.fetch = fetchMock;

    vi.mocked(executeToolCall).mockResolvedValue({ result: 'ok', ok: true });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    await collectEvents(rt.invoke({
      prompt: 'Read',
      model: '',
      cwd: '/home',
      tools: ['Read'],
      addDirs: ['', '/extra', ''],
    }));

    expect(executeToolCall).toHaveBeenCalledWith(
      'read_file',
      { file_path: '/home/test.txt' },
      ['/home', '/extra'],
    );
  });

  it('enableTools true but empty params.tools uses streaming path', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
      tools: [],
    }));

    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream).toBe(true);
    expect(parsed.tools).toBeUndefined();
  });

  it('enableTools true but only unknown tools uses streaming path', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(makeSSEResponse(['data: [DONE]']));
    });

    const rt = createOpenAICompatRuntime({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
      enableTools: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
      tools: ['UnknownTool', 'AnotherFake'],
    }));

    expect(events.find((e) => e.type === 'done')).toBeDefined();

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream).toBe(true);
    expect(parsed.tools).toBeUndefined();
  });
});
