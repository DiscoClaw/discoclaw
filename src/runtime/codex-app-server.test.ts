import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from './types.js';
import { CodexAppServerClient } from './codex-app-server.js';

class MockWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>();

  send(payload: string): void {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    this.sent.push(parsed);
    const method = typeof parsed.method === 'string' ? parsed.method : '';
    this.handlers.get(method)?.(parsed);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  reply(id: unknown, result: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ id, result })));
  }

  fail(id: unknown, message: string): void {
    this.emit('message', Buffer.from(JSON.stringify({
      id,
      error: { code: -32000, message },
    })));
  }

  notify(method: string, params: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ method, params })));
  }

  onMethod(method: string, handler: (message: Record<string, unknown>) => void): void {
    this.handlers.set(method, handler);
  }
}

describe('CodexAppServerClient', () => {
  const sockets: MockWebSocket[] = [];
  const readOnlySandbox = {
    sandboxPolicy: {
      type: 'readOnly',
      access: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: ['/tmp/discoclaw'],
      },
      networkAccess: false,
    },
  };

  afterEach(() => {
    sockets.length = 0;
  });

  function makeClient(timeoutMs = 50): CodexAppServerClient {
    return new CodexAppServerClient({
      baseUrl: 'ws://127.0.0.1:4321',
      timeoutMs,
      wsFactory: () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket as never;
      },
    });
  }

  function primeHandshake(socket: MockWebSocket): void {
    socket.onMethod('initialize', (message) => {
      socket.reply(message.id, { userAgent: 'test-agent' });
    });
  }

  async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for await (const event of iterable) {
      events.push(event);
    }
    return events;
  }

  it('starts a thread and stores the returned threadId', async () => {
    const client = makeClient();

    const createPromise = client.createThread('session-1', {
      cwd: '/tmp/discoclaw',
      model: 'gpt-5.4',
      systemPrompt: 'system',
    });

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      socket.reply(message.id, { threadId: 'thread-1' });
    });
    socket.open();

    await expect(createPromise).resolves.toBe('thread-1');
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
    expect(socket.sent[2]).toEqual({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: '/tmp/discoclaw',
        model: 'gpt-5.4',
        developerInstructions: 'system',
        ...readOnlySandbox,
      },
    });
  });

  it('times out when thread/start does not return', async () => {
    const client = makeClient(10);

    const createPromise = client.createThread('session-1', { cwd: '/tmp/discoclaw', model: 'gpt-5.4' });
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.open();

    await expect(createPromise).rejects.toThrow('codex app-server request timed out (thread/start)');
  });

  it('falls back to thread/create when thread/start is unavailable', async () => {
    const client = makeClient();

    const createPromise = client.createThread('session-1', { cwd: '/tmp/discoclaw', model: 'gpt-5.4' });
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      socket.emit('message', Buffer.from(JSON.stringify({
        id: message.id,
        error: { code: -32601, message: 'Unknown method thread/start. Did you mean thread/create?' },
      })));
    });
    socket.onMethod('thread/create', (message) => {
      socket.reply(message.id, { threadId: 'thread-legacy-1' });
    });
    socket.open();

    await expect(createPromise).resolves.toBe('thread-legacy-1');
    expect(socket.sent[2]).toEqual({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: '/tmp/discoclaw',
        model: 'gpt-5.4',
        ...readOnlySandbox,
      },
    });
    expect(socket.sent[3]).toEqual({
      id: 3,
      method: 'thread/create',
      params: {
        cwd: '/tmp/discoclaw',
        model: 'gpt-5.4',
        ...readOnlySandbox,
      },
    });
  });

  it('rejects createThread when the server returns a JSON-RPC error', async () => {
    const client = makeClient();

    const createPromise = client.createThread('session-1', { cwd: '/tmp/discoclaw', model: 'gpt-5.4' });
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      socket.fail(message.id, 'cannot create thread');
    });
    socket.open();

    await expect(createPromise).rejects.toThrow('cannot create thread');
  });

  it('starts a turn, tracks the returned turnId, and returns a stream handle', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello world', {
      cwd: '/tmp/discoclaw',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();

    const handle = await startPromise;
    expect(handle.threadId).toBe('thread-1');
    expect(handle.turnId).toBe('turn-1');
    expect(handle.stream).toBeDefined();
    expect(client.getSessionState('session-1')).toEqual({
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
    });
    expect(socket.sent[2]).toEqual({
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{
          type: 'text',
          text: 'hello world',
          text_elements: [],
        }],
        cwd: '/tmp/discoclaw',
        model: 'gpt-5.4',
        effort: 'high',
        ...readOnlySandbox,
      },
    });
  });

  it('starts a turn without a response turnId and learns it from later notifications', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello world');

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turn: { items: [], status: 'inProgress', error: null } });
    });
    socket.open();

    const handle = await startPromise;
    expect(handle.threadId).toBe('thread-1');
    expect(handle.turnId).toBeUndefined();
    expect(client.getSessionState('session-1')).toEqual({
      threadId: 'thread-1',
    });

    const eventsPromise = collect(handle.stream);
    socket.notify('turn/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    socket.notify('turn/text_delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'hello later',
    });
    socket.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'hello later' },
      { type: 'text_final', text: 'hello later' },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({
      threadId: 'thread-1',
    });
  });

  it('marks one-shot threads as ephemeral during invokeViaTurn', async () => {
    const client = makeClient();

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'ephemeral run',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
    }));

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      expect(message.params).toEqual({
        cwd: '/tmp/discoclaw',
        model: 'gpt-5.4',
        ephemeral: true,
        ...readOnlySandbox,
      });
      socket.reply(message.id, { threadId: 'thread-ephemeral-1' });
    });
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } });
      socket.notify('item/completed', {
        threadId: 'thread-ephemeral-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'done', phase: null },
      });
      socket.notify('turn/completed', {
        threadId: 'thread-ephemeral-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      });
    });
    socket.open();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'done' },
      { type: 'text_final', text: 'done' },
      { type: 'done' },
    ]);
  });

  it('rejects startTurn when the server returns a JSON-RPC error', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello world');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.fail(message.id, 'turn rejected');
    });
    socket.open();

    await expect(startPromise).rejects.toThrow('turn rejected');
  });

  it('consumeStream yields text deltas, tool events, completion, and clears active turn state', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();
    await startPromise;

    const eventsPromise = collect(client.consumeStream('session-1'));
    socket.notify('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'hello',
    });
    socket.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'dynamicToolCall',
        id: 'tool-1',
        tool: 'readFile',
        arguments: { path: 'README.md' },
        status: 'inProgress',
        contentItems: null,
        success: null,
        durationMs: null,
      },
    });
    socket.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'dynamicToolCall',
        id: 'tool-1',
        tool: 'readFile',
        arguments: { path: 'README.md' },
        status: 'completed',
        contentItems: 'ok',
        success: true,
        durationMs: 5,
      },
    });
    socket.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'hello world', phase: null },
    });
    socket.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: null,
      },
    });
    socket.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'tool_start', name: 'readFile', input: { path: 'README.md' } },
      { type: 'tool_end', name: 'readFile', ok: true, output: { contentItems: 'ok' } },
      { type: 'text_delta', text: ' world' },
      { type: 'text_final', text: 'hello world' },
      { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('consumeStream yields failure and done when the turn fails', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();
    await startPromise;

    const eventsPromise = collect(client.consumeStream('session-1'));
    socket.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'failed', error: { message: 'tool crashed' } },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'error', message: 'tool crashed' },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('consumeStream accumulates turn/text_delta into the synthesized final text', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();
    await startPromise;

    const eventsPromise = collect(client.consumeStream('session-1'));
    socket.notify('turn/text_delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'hello',
    });
    socket.notify('turn/text_delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: ' world',
    });
    socket.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'text_final', text: 'hello world' },
      { type: 'done' },
    ]);
  });

  it('consumeStream treats turn/failed as terminal and preserves nested error + usage details', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();
    await startPromise;

    const eventsPromise = collect(client.consumeStream('session-1'));
    socket.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        last: {
          totalTokens: 12,
          inputTokens: 7,
          outputTokens: 5,
        },
      },
    });
    socket.notify('turn/failed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'tool crashed hard' },
      },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'error', message: 'tool crashed hard' },
      { type: 'usage', inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('consumeStream emits an error and done when the websocket disconnects mid-stream', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.open();
    await startPromise;

    const eventsPromise = collect(client.consumeStream('session-1'));
    socket.notify('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'partial',
    });
    socket.close();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'partial' },
      expect.objectContaining({
        type: 'error',
        message: 'codex app-server websocket closed',
        failure: expect.objectContaining({
          code: 'CODEX_APP_SERVER_DISCONNECTED',
          retryable: false,
        }),
      }),
      { type: 'done' },
    ]);
  });

  it('invokeViaTurn drives createThread, startTurn, and stream consumption end to end', async () => {
    const client = makeClient();

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'answer this',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      socket.reply(message.id, { threadId: 'thread-1' });
    });
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } });
      socket.notify('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'first chunk',
      });
      socket.notify('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-1',
          tool: 'search',
          arguments: { query: 'discoclaw' },
          status: 'inProgress',
          contentItems: null,
          success: null,
          durationMs: null,
        },
      });
      socket.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-1',
          tool: 'search',
          arguments: { query: 'discoclaw' },
          status: 'completed',
          contentItems: { hits: 1 },
          success: true,
          durationMs: 5,
        },
      });
      socket.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'final answer', phase: null },
      });
      socket.notify('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      });
    });
    socket.open();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'first chunk' },
      { type: 'tool_start', name: 'search', input: { query: 'discoclaw' } },
      { type: 'tool_end', name: 'search', ok: true, output: { contentItems: { hits: 1 } } },
      { type: 'text_delta', text: 'final answer' },
      { type: 'text_final', text: 'final answer' },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('invokeViaTurn rejects so the caller can fall back when the websocket connection fails', async () => {
    const client = makeClient();

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'answer this',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    const socket = sockets[0]!;
    socket.emit('error', new Error('ECONNREFUSED'));

    await expect(eventsPromise).rejects.toThrow('codex app-server websocket failed');
  });

  it('invokeViaTurn rejects so the caller can fall back when websocket construction fails', async () => {
    const client = new CodexAppServerClient({
      baseUrl: 'not a websocket url',
      timeoutMs: 50,
      wsFactory: () => {
        throw new Error('bad url');
      },
    });

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'answer this',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    await expect(eventsPromise).rejects.toThrow('codex app-server websocket failed');
  });

  it('invokeViaTurn rejects so the caller can fall back when initialize fails', async () => {
    const client = makeClient();

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'answer this',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    const socket = sockets[0]!;
    socket.onMethod('initialize', (message) => {
      socket.fail(message.id, 'initialize broke');
    });
    socket.open();

    await expect(eventsPromise).rejects.toThrow('codex app-server initialize failed');
  });

  it('invokeViaTurn reuses an existing threadId and skips createThread on the second call', async () => {
    const client = makeClient();

    const firstEvents = collect(client.invokeViaTurn({
      prompt: 'first',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    const socket = sockets[0]!;
    primeHandshake(socket);
    let turnIndex = 0;
    socket.onMethod('thread/start', (message) => {
      socket.reply(message.id, { threadId: 'thread-1' });
    });
    socket.onMethod('turn/start', (message) => {
      turnIndex += 1;
      const turnId = `turn-${turnIndex}`;
      socket.reply(message.id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      socket.notify('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          type: 'agentMessage',
          id: `msg-${turnIndex}`,
          text: turnIndex === 1 ? 'first done' : 'second done',
          phase: null,
        },
      });
      socket.notify('turn/completed', {
        threadId: 'thread-1',
        turn: { id: turnId, items: [], status: 'completed', error: null },
      });
    });
    socket.open();

    await expect(firstEvents).resolves.toEqual([
      { type: 'text_delta', text: 'first done' },
      { type: 'text_final', text: 'first done' },
      { type: 'done' },
    ]);

    const secondEvents = collect(client.invokeViaTurn({
      prompt: 'second',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
    }));

    await expect(secondEvents).resolves.toEqual([
      { type: 'text_delta', text: 'second done' },
      { type: 'text_final', text: 'second done' },
      { type: 'done' },
    ]);

    const createCalls = socket.sent.filter((entry) => {
      return typeof entry === 'object'
        && entry !== null
        && 'method' in entry
        && (entry as { method?: string }).method === 'thread/start';
    });
    expect(createCalls).toHaveLength(1);
  });

  it('invokeViaTurn honors AbortSignal by interrupting the active turn and emitting aborted', async () => {
    const client = makeClient();
    const abortController = new AbortController();

    const eventsPromise = collect(client.invokeViaTurn({
      prompt: 'answer this',
      model: 'gpt-5.4',
      cwd: '/tmp/discoclaw',
      sessionKey: 'session-1',
      signal: abortController.signal,
    }));

    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('thread/start', (message) => {
      socket.reply(message.id, { threadId: 'thread-1' });
    });
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } });
      socket.notify('turn/text_delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: 'partial',
      });
      queueMicrotask(() => {
        abortController.abort();
      });
    });
    socket.onMethod('turn/interrupt', (message) => {
      socket.reply(message.id, {});
    });
    socket.open();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'partial' },
      expect.objectContaining({ type: 'error', message: 'aborted' }),
      { type: 'done' },
    ]);
    expect(socket.sent).toContainEqual({
      id: 4,
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('returns false when steering without an active turn', async () => {
    const client = makeClient();

    await expect(client.steer('session-1', 'hello')).resolves.toBe(false);
    expect(sockets).toHaveLength(0);
  });

  it('returns false when interrupting without an active turn', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    await expect(client.interrupt('session-1')).resolves.toBe(false);
    expect(sockets).toHaveLength(0);
  });

  it('opens a websocket, initializes once, and sends steer payloads over JSON-RPC', async () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    const steerPromise = client.steer('session-1', 'keep going');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/steer', (message) => {
      socket.reply(message.id, { turnId: 'turn-2' });
    });
    socket.open();

    await expect(steerPromise).resolves.toBe(true);
    expect(socket.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'discoclaw',
            title: 'DiscoClaw',
            version: '0.0.0',
          },
          capabilities: null,
        },
      },
      { method: 'initialized' },
      {
        id: 2,
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          input: [{
            type: 'text',
            text: 'keep going',
            text_elements: [],
          }],
          expectedTurnId: 'turn-1',
        },
      },
    ]);
    expect(client.getSessionState('session-1')).toEqual({
      threadId: 'thread-1',
      activeTurnId: 'turn-2',
    });
  });

  it('keeps streaming on a replacement turnId returned by turn/steer', async () => {
    const client = makeClient();
    client.setThread('session-1', 'thread-1');

    const startPromise = client.startTurn('session-1', 'hello');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/start', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.onMethod('turn/steer', (message) => {
      socket.reply(message.id, { turnId: 'turn-2' });
    });
    socket.open();

    const handle = await startPromise;
    const eventsPromise = collect(handle.stream);

    await expect(client.steer('session-1', 'keep going')).resolves.toBe(true);
    socket.notify('turn/text_delta', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      delta: 'continued',
    });
    socket.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-2', items: [], status: 'completed', error: null },
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: 'text_delta', text: 'continued' },
      { type: 'text_final', text: 'continued' },
      { type: 'done' },
    ]);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('reuses the initialized websocket for follow-up interrupt requests', async () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    const steerPromise = client.steer('session-1', 'keep going');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/steer', (message) => {
      socket.reply(message.id, { turnId: 'turn-1' });
    });
    socket.onMethod('turn/interrupt', (message) => {
      socket.reply(message.id, {});
    });
    socket.open();

    await expect(steerPromise).resolves.toBe(true);
    await expect(client.interrupt('session-1')).resolves.toBe(true);
    expect(sockets).toHaveLength(1);
    expect(socket.sent[3]).toEqual({
      id: 3,
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('returns false when the websocket connect times out', async () => {
    const client = makeClient(10);
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'hello')).resolves.toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it('returns false when the server returns a JSON-RPC error', async () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    const interruptPromise = client.interrupt('session-1');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/interrupt', (message) => {
      socket.fail(message.id, 'turn mismatch');
    });
    socket.open();

    await expect(interruptPromise).resolves.toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  it('returns false on steer JSON-RPC errors without closing the shared websocket', async () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    const steerPromise = client.steer('session-1', 'keep going');
    const socket = sockets[0]!;
    primeHandshake(socket);
    socket.onMethod('turn/steer', (message) => {
      socket.fail(message.id, 'turn mismatch');
    });
    socket.open();

    await expect(steerPromise).resolves.toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  it('reconnects after the socket closes', async () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    const firstInterrupt = client.interrupt('session-1');
    const firstSocket = sockets[0]!;
    primeHandshake(firstSocket);
    firstSocket.onMethod('turn/interrupt', (message) => {
      firstSocket.reply(message.id, {});
    });
    firstSocket.open();
    await expect(firstInterrupt).resolves.toBe(true);

    client.setActiveTurn('session-1', 'thread-1', 'turn-2');
    firstSocket.close();

    const secondInterrupt = client.interrupt('session-1');
    const secondSocket = sockets[1]!;
    primeHandshake(secondSocket);
    secondSocket.onMethod('turn/interrupt', (message) => {
      secondSocket.reply(message.id, {});
    });
    secondSocket.open();

    await expect(secondInterrupt).resolves.toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it('clears stale turn state when the thread changes', () => {
    const client = makeClient();
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');
    client.setThread('session-1', 'thread-2');

    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-2' });
  });

  it('logs failures instead of throwing when wsFactory throws', async () => {
    const log = { debug: vi.fn() };
    const client = new CodexAppServerClient({
      baseUrl: 'ws://127.0.0.1:4321',
      timeoutMs: 50,
      log,
      wsFactory: () => {
        throw new Error('boom');
      },
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'hello')).resolves.toBe(false);
    expect(log.debug).toHaveBeenCalled();
  });
});
