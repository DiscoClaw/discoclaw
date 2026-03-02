import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicRestRuntime } from './anthropic-rest.js';
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

/** Build an Anthropic SSE content_block_delta event line. */
function makeTextDelta(text: string): string {
  return `data: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })}`;
}

/** Build message_start SSE with input token usage. */
function makeMessageStart(inputTokens: number): string {
  return `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  })}`;
}

/** Build message_delta SSE with output token usage. */
function makeMessageDelta(outputTokens: number): string {
  return `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: outputTokens },
  })}`;
}

/** Build message_stop SSE event line. */
function makeMessageStop(): string {
  return `data: ${JSON.stringify({ type: 'message_stop' })}`;
}

describe('Anthropic REST runtime adapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('happy path: SSE stream with text chunks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeMessageStart(10),
        makeTextDelta('Hello'),
        makeTextDelta(' world'),
        makeTextDelta('!'),
        makeMessageDelta(5),
        makeMessageStop(),
      ]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
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

  it('sends API key and anthropic-version headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok'), makeMessageStop()]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'my-secret-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('my-secret-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('uses /v1/messages endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(
      runtime.invoke({ prompt: 'test', model: 'claude-haiku-4-5-20251001', cwd: '/tmp' }),
    );

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('falls back to defaultModel when params.model is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('sends stream: true and max_tokens in request body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
  });

  it('uses custom maxTokens when specified', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp', maxTokens: 512 }),
    );

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.max_tokens).toBe(512);
  });

  it('uses defaultMaxTokens from opts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
      defaultMaxTokens: 2048,
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.max_tokens).toBe(2048);
  });

  it('splits system prompt from user message using sentinel', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const prompt =
      'System context here\n---\nThe sections above are internal system context.\nUser message here';

    await collectEvents(runtime.invoke({ prompt, model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);

    expect(body.system).toContain('System context here');
    expect(body.messages[0].content).toBe('User message here');
  });

  it('uses explicit systemPrompt param when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(
      runtime.invoke({
        prompt: 'user message',
        systemPrompt: 'be helpful',
        model: '',
        cwd: '/tmp',
      }),
    );

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);

    expect(body.system).toBe('be helpful');
    expect(body.messages[0].content).toBe('user message');
  });

  it('omits system field when no system prompt detected', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await collectEvents(runtime.invoke({ prompt: 'just a question', model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string);

    expect(body.system).toBeUndefined();
  });

  it('emits usage events from message_start and message_delta', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeMessageStart(25),
        makeTextDelta('ok'),
        makeMessageDelta(10),
        makeMessageStop(),
      ]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(2);
    expect((usageEvents[0] as { inputTokens: number }).inputTokens).toBe(25);
    expect((usageEvents[1] as { outputTokens: number }).outputTokens).toBe(10);
  });

  it('emits error event on non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
      }),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toContain('429');
    expect((error as { message: string }).message).toContain('rate limit exceeded');
  });

  it('handles streaming error event from Anthropic', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeTextDelta('partial'),
        `data: ${JSON.stringify({ type: 'error', error: { message: 'overloaded' } })}`,
      ]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toBe('overloaded');

    // Should still emit text_final with whatever was accumulated
    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('partial');
  });

  it('reports aborted when caller signal fires', async () => {
    const ac = new AbortController();
    ac.abort();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp', signal: ac.signal }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toBe('aborted');
  });

  it('has runtime id "claude_code"', () => {
    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });
    expect(runtime.id).toBe('claude_code');
  });

  it('exposes defaultModel', () => {
    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-haiku-4-5-20251001',
    });
    expect(runtime.defaultModel).toBe('claude-haiku-4-5-20251001');
  });

  it('has streaming_text capability', () => {
    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });
    expect(runtime.capabilities.has('streaming_text')).toBe(true);
    expect(runtime.capabilities.size).toBe(1);
  });

  it('supports custom baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
      baseUrl: 'https://custom.api.example.com',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('https://custom.api.example.com/v1/messages');
  });

  it('supports custom apiVersion', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([makeTextDelta('ok')]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
      apiVersion: '2024-01-01',
    });

    await collectEvents(runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }));

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2024-01-01');
  });

  it('ignores event: lines in SSE stream', async () => {
    // Anthropic sends named event types like `event: content_block_delta`
    // before the data line — these should be silently skipped
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        'event: message_start',
        makeMessageStart(5),
        'event: content_block_delta',
        makeTextDelta('Hello'),
        'event: message_stop',
        makeMessageStop(),
      ]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { text: string }).text).toBe('Hello');
  });

  it('emits empty text_final when response has no content deltas', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSSEResponse([
        makeMessageStart(5),
        makeMessageDelta(0),
        makeMessageStop(),
      ]),
    );

    const runtime = createAnthropicRestRuntime({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    const events = await collectEvents(
      runtime.invoke({ prompt: 'test', model: '', cwd: '/tmp' }),
    );

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('');
    expect(events.at(-1)?.type).toBe('done');
  });
});
