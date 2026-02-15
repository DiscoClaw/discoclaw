import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatRuntime } from './openai-compat.js';
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
});
