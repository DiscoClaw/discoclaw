import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  resolveCodexAuthFilePath,
} from './codex-app-server.js';

describe('resolveCodexAuthFilePath', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('uses CODEX_HOME when set', () => {
    process.env.CODEX_HOME = '/tmp/codex-home';
    expect(resolveCodexAuthFilePath()).toBe('/tmp/codex-home/auth.json');
  });

  it('falls back to ~/.codex/auth.json', () => {
    delete process.env.CODEX_HOME;
    expect(resolveCodexAuthFilePath()).toBe(
      path.join(process.env.HOME || '', '.codex', 'auth.json'),
    );
  });
});

describe('CodexAppServerClient', () => {
  const tokenProvider = {
    getAccessToken: vi.fn<(...args: [boolean?]) => Promise<string>>(),
  };
  const fetchImpl = vi.fn<typeof fetch>();

  afterEach(() => {
    tokenProvider.getAccessToken.mockReset();
    fetchImpl.mockReset();
  });

  it('returns false when steering without an active turn', async () => {
    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234',
      tokenProvider,
      fetchImpl,
    });

    await expect(client.steer('session-1', 'hello')).resolves.toBe(false);
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false when interrupting without an active turn', async () => {
    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234',
      tokenProvider,
      fetchImpl,
    });
    client.setThread('session-1', 'thread-1');

    await expect(client.interrupt('session-1')).resolves.toBe(false);
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts steer request with active thread/turn state', async () => {
    tokenProvider.getAccessToken.mockResolvedValue('token-1');
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ turnId: 'turn-1' }), { status: 200 }),
    );

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'keep going')).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:1234/api/turn/steer');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      threadId: 'thread-1',
      input: [{
        type: 'text',
        text: 'keep going',
        text_elements: [],
      }],
      expectedTurnId: 'turn-1',
    });
  });

  it('clears the active turn after a successful interrupt', async () => {
    tokenProvider.getAccessToken.mockResolvedValue('token-1');
    fetchImpl.mockResolvedValue(new Response('{}', { status: 200 }));

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.interrupt('session-1')).resolves.toBe(true);
    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-1' });
  });

  it('force-refreshes on 401 and retries once', async () => {
    tokenProvider.getAccessToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');
    fetchImpl
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turnId: 'turn-1' }), { status: 200 }),
      );

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'retry')).resolves.toBe(true);

    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(1);
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![1]!.headers).toEqual({
      Authorization: 'Bearer token-2',
      'Content-Type': 'application/json',
    });
  });

  it('returns false after a second 401', async () => {
    tokenProvider.getAccessToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');
    fetchImpl
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'retry')).resolves.toBe(false);
  });

  it('returns false for 404 responses', async () => {
    tokenProvider.getAccessToken.mockResolvedValue('token-1');
    fetchImpl.mockResolvedValue(new Response('Not found', { status: 404 }));

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.interrupt('session-1')).resolves.toBe(false);
  });

  it('returns false for network errors', async () => {
    tokenProvider.getAccessToken.mockResolvedValue('token-1');
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.interrupt('session-1')).resolves.toBe(false);
  });

  it('returns false when auth lookup fails', async () => {
    tokenProvider.getAccessToken.mockRejectedValue(new Error('ENOENT: auth.json'));

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.steer('session-1', 'hello')).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false on timeout aborts', async () => {
    tokenProvider.getAccessToken.mockResolvedValue('token-1');
    fetchImpl.mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
      timeoutMs: 10,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');

    await expect(client.interrupt('session-1')).resolves.toBe(false);
  });

  it('clears stale turn state when the thread changes', () => {
    const client = new CodexAppServerClient({
      baseUrl: 'http://127.0.0.1:1234/api',
      tokenProvider,
      fetchImpl,
    });
    client.setActiveTurn('session-1', 'thread-1', 'turn-1');
    client.setThread('session-1', 'thread-2');

    expect(client.getSessionState('session-1')).toEqual({ threadId: 'thread-2' });
  });
});
