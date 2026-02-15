import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  CODEX_CLIENT_ID,
  createChatGptTokenProvider,
  decodeJwtExp,
  isTokenExpired,
  loadAuthFile,
  refreshAccessToken,
  saveAuthFile,
  type AuthFileData,
} from './openai-auth.js';

/** Build a minimal JWT with the given payload claims. No signature. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function makeAuthData(overrides?: Partial<AuthFileData>): AuthFileData {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'rt-test-refresh-token',
      id_token: 'id-test',
      account_id: 'acct-123',
    },
    last_refresh: new Date().toISOString(),
    ...overrides,
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('CODEX_CLIENT_ID', () => {
  it('has the expected value', () => {
    expect(CODEX_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
  });
});

describe('decodeJwtExp', () => {
  it('extracts exp from a valid JWT', () => {
    const exp = 1700000000;
    const token = makeJwt({ exp, sub: 'user-1' });
    expect(decodeJwtExp(token)).toBe(exp);
  });

  it('throws for a token with fewer than 2 segments', () => {
    expect(() => decodeJwtExp('just-one-segment')).toThrow('Invalid JWT');
  });

  it('throws when payload has no exp claim', () => {
    const token = makeJwt({ sub: 'user-1' });
    expect(() => decodeJwtExp(token)).toThrow('missing numeric "exp"');
  });

  it('handles base64url characters (- and _)', () => {
    // Create payload with characters that produce -/_ in base64url
    const exp = 1700000000;
    const token = makeJwt({ exp, data: '>>>???<<<' });
    expect(decodeJwtExp(token)).toBe(exp);
  });
});

describe('isTokenExpired', () => {
  it('returns false for a token expiring well in the future', () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
    expect(isTokenExpired(token)).toBe(false);
  });

  it('returns true for a token expiring within the buffer window', () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 100 });
    // Default buffer is 300s, so 100s from now is "expired"
    expect(isTokenExpired(token)).toBe(true);
  });

  it('returns true for an already-expired token', () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('respects custom bufferSecs', () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 100 });
    // With a 50s buffer, 100s from now is NOT expired
    expect(isTokenExpired(token, 50)).toBe(false);
    // With a 200s buffer, 100s from now IS expired
    expect(isTokenExpired(token, 200)).toBe(true);
  });

  it('returns true for an unparseable token (treats as expired)', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(true);
  });
});

describe('loadAuthFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-auth-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid auth file', async () => {
    const data = makeAuthData();
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    const loaded = await loadAuthFile(filePath);
    expect(loaded.tokens.access_token).toBe(data.tokens.access_token);
    expect(loaded.tokens.refresh_token).toBe(data.tokens.refresh_token);
    expect(loaded.auth_mode).toBe('chatgpt');
  });

  it('throws for a file missing access_token', async () => {
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'rt-123' },
    }));

    await expect(loadAuthFile(filePath)).rejects.toThrow('missing required tokens');
  });

  it('throws for a file missing refresh_token', async () => {
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'at-123' },
    }));

    await expect(loadAuthFile(filePath)).rejects.toThrow('missing required tokens');
  });

  it('throws for a nonexistent file', async () => {
    await expect(loadAuthFile(path.join(tmpDir, 'nope.json'))).rejects.toThrow();
  });
});

describe('saveAuthFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-auth-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads back correctly', async () => {
    const data = makeAuthData();
    const filePath = path.join(tmpDir, 'auth.json');

    await saveAuthFile(filePath, data);

    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as AuthFileData;
    expect(parsed.tokens.access_token).toBe(data.tokens.access_token);
    expect(parsed.tokens.refresh_token).toBe(data.tokens.refresh_token);
  });

  it('logs warning on write failure (does not throw)', async () => {
    const log = makeLogger();
    // Writing to a nonexistent directory should fail
    const filePath = path.join(tmpDir, 'no', 'such', 'dir', 'auth.json');

    await saveAuthFile(filePath, makeAuthData(), log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toContain('failed to persist');
  });
});

describe('refreshAccessToken', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct request and returns tokens', async () => {
    const newAccessToken = 'new-access-token';
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: newAccessToken,
            refresh_token: 'new-refresh',
            id_token: 'new-id',
          }),
          { status: 200 },
        ),
      );
    });

    const result = await refreshAccessToken('rt-old', 'test-client-id');

    expect(capturedUrl).toBe('https://auth.openai.com/oauth/token');
    const body = JSON.parse(capturedBody!);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('rt-old');
    expect(body.client_id).toBe('test-client-id');

    expect(result.access_token).toBe(newAccessToken);
    expect(result.refresh_token).toBe('new-refresh');
  });

  it('defaults client_id to CODEX_CLIENT_ID', async () => {
    let capturedBody: string | undefined;

    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }),
      );
    });

    await refreshAccessToken('rt-test');

    const body = JSON.parse(capturedBody!);
    expect(body.client_id).toBe(CODEX_CLIENT_ID);
  });

  it('throws on non-ok response with client_id in message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('bad request', { status: 400 }),
    );

    await expect(refreshAccessToken('rt-bad', 'my-client'))
      .rejects.toThrow(/client_id=my-client/);
  });

  it('throws when response has no access_token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await expect(refreshAccessToken('rt-test'))
      .rejects.toThrow(/no access_token/);
  });
});

describe('createChatGptTokenProvider', () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-auth-test-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockRefreshEndpoint(newAccessToken: string) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: newAccessToken }),
        { status: 200 },
      ),
    );
  }

  it('returns cached token from file when not expired', async () => {
    const validToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const data = makeAuthData({
      tokens: {
        access_token: validToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    const token = await provider.getAccessToken();
    expect(token).toBe(validToken);
    // Should NOT have called fetch (no refresh needed)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes expired token', async () => {
    const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const newToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

    const data = makeAuthData({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    mockRefreshEndpoint(newToken);
    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    const token = await provider.getAccessToken();
    expect(token).toBe(newToken);
  });

  it('refreshes when forceRefresh is true even if token is valid', async () => {
    const validToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const newToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });

    const data = makeAuthData({
      tokens: {
        access_token: validToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    mockRefreshEndpoint(newToken);
    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    // First call loads cached valid token
    const token1 = await provider.getAccessToken();
    expect(token1).toBe(validToken);

    // Force refresh
    const token2 = await provider.getAccessToken(true);
    expect(token2).toBe(newToken);
  });

  it('persists refreshed tokens to disk', async () => {
    const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const newToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

    const data = makeAuthData({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'rt-original',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: newToken,
          refresh_token: 'rt-updated',
        }),
        { status: 200 },
      ),
    );

    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });
    await provider.getAccessToken();

    // Read back from disk
    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw) as AuthFileData;
    expect(persisted.tokens.access_token).toBe(newToken);
    expect(persisted.tokens.refresh_token).toBe('rt-updated');
    expect(persisted.last_refresh).toBeDefined();
  });

  it('deduplicates concurrent refresh calls (mutex)', async () => {
    const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const newToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

    const data = makeAuthData({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: newToken }),
          { status: 200 },
        ),
      );
    });

    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    // Fire 3 concurrent getAccessToken calls
    const [t1, t2, t3] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(t1).toBe(newToken);
    expect(t2).toBe(newToken);
    expect(t3).toBe(newToken);
    // Only one actual refresh should have happened
    expect(fetchCallCount).toBe(1);
  });

  it('returns cached token on second call without re-reading file', async () => {
    const validToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const data = makeAuthData({
      tokens: {
        access_token: validToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    const token1 = await provider.getAccessToken();
    // Delete the file — second call should still work from cache
    await fs.unlink(filePath);
    const token2 = await provider.getAccessToken();

    expect(token1).toBe(validToken);
    expect(token2).toBe(validToken);
  });

  it('propagates error when auth file does not exist', async () => {
    const log = makeLogger();
    const provider = createChatGptTokenProvider({
      authFilePath: path.join(tmpDir, 'nope.json'),
      log,
    });

    await expect(provider.getAccessToken()).rejects.toThrow();
    expect(log.error).toHaveBeenCalled();
  });

  it('propagates error when refresh fails', async () => {
    const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const data = makeAuthData({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'rt-test',
      },
    });
    const filePath = path.join(tmpDir, 'auth.json');
    await fs.writeFile(filePath, JSON.stringify(data));

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );

    const log = makeLogger();
    const provider = createChatGptTokenProvider({ authFilePath: filePath, log });

    await expect(provider.getAccessToken()).rejects.toThrow(/Token refresh failed/);
  });
});
