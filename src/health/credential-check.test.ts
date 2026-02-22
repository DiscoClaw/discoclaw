import { describe, expect, it, vi } from 'vitest';
import {
  checkDiscordToken,
  checkOpenAiKey,
  formatCredentialReport,
  runCredentialChecks,
  type CredentialCheckReport,
} from './credential-check.js';

// Helpers ------------------------------------------------------------------

function mockFetch(status: number, body = '') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
}

function mockFetchError(message: string) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)));
}

function makeReport(results: CredentialCheckReport['results']): CredentialCheckReport {
  const criticalFailures = results
    .filter((r) => r.status === 'fail' && r.name === 'discord-token')
    .map((r) => r.name);
  const allOk = results.every((r) => r.status === 'ok' || r.status === 'skip');
  return { results, criticalFailures, allOk };
}

// checkDiscordToken --------------------------------------------------------

describe('checkDiscordToken', () => {
  it('returns ok for a 200 response', async () => {
    mockFetch(200, '{"id":"123","username":"TestBot","bot":true}');
    const result = await checkDiscordToken('valid-token');
    expect(result.name).toBe('discord-token');
    expect(result.status).toBe('ok');
    expect(result.message).toBeUndefined();
  });

  it('returns fail with 401 message for unauthorized', async () => {
    mockFetch(401, '{"message":"401: Unauthorized","code":0}');
    const result = await checkDiscordToken('bad-token');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('401');
  });

  it('returns fail for an unexpected HTTP status', async () => {
    mockFetch(503);
    const result = await checkDiscordToken('token');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('503');
  });

  it('returns fail on network error without throwing', async () => {
    mockFetchError('ECONNREFUSED');
    const result = await checkDiscordToken('token');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('network error');
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('sends request to the correct Discord API endpoint with Bot prefix', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await checkDiscordToken('my-token');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/users/@me');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bot my-token');
  });
});

// checkOpenAiKey -----------------------------------------------------------

describe('checkOpenAiKey', () => {
  it('returns skip when no API key is provided', async () => {
    const result = await checkOpenAiKey({});
    expect(result.name).toBe('openai-key');
    expect(result.status).toBe('skip');
  });

  it('returns skip for an empty string key', async () => {
    const result = await checkOpenAiKey({ apiKey: '' });
    expect(result.status).toBe('skip');
  });

  it('returns ok for a 200 response', async () => {
    mockFetch(200, '{"object":"list","data":[]}');
    const result = await checkOpenAiKey({ apiKey: 'sk-valid' });
    expect(result.name).toBe('openai-key');
    expect(result.status).toBe('ok');
    expect(result.message).toBeUndefined();
  });

  it('returns fail with 401 message for an invalid key', async () => {
    mockFetch(401, '{"error":{"message":"Incorrect API key"}}');
    const result = await checkOpenAiKey({ apiKey: 'sk-bad' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('401');
  });

  it('returns fail with 403 message for a key lacking permissions', async () => {
    mockFetch(403, '{"error":{"message":"Forbidden"}}');
    const result = await checkOpenAiKey({ apiKey: 'sk-no-perms' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('403');
  });

  it('returns fail for an unexpected HTTP status', async () => {
    mockFetch(429, '{"error":{"message":"Rate limit exceeded"}}');
    const result = await checkOpenAiKey({ apiKey: 'sk-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('429');
  });

  it('returns fail on network error without throwing', async () => {
    mockFetchError('connect ETIMEDOUT');
    const result = await checkOpenAiKey({ apiKey: 'sk-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('network error');
    expect(result.message).toContain('ETIMEDOUT');
  });

  it('uses the default OpenAI base URL when none is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await checkOpenAiKey({ apiKey: 'sk-test' });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://api.openai.com/v1/models');
  });

  it('uses a custom base URL when provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await checkOpenAiKey({ apiKey: 'sk-test', baseUrl: 'https://my.proxy.example.com/v1' });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://my.proxy.example.com/v1/models');
  });

  it('strips a trailing slash from the custom base URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await checkOpenAiKey({ apiKey: 'sk-test', baseUrl: 'https://my.proxy.example.com/v1/' });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://my.proxy.example.com/v1/models');
  });

  it('sends the correct Bearer Authorization header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await checkOpenAiKey({ apiKey: 'sk-my-key' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-my-key');
  });

  it('does not call fetch when no key is provided', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await checkOpenAiKey({});

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// runCredentialChecks ------------------------------------------------------

describe('runCredentialChecks', () => {
  it('returns four results (one per check)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const report = await runCredentialChecks({ token: 'valid-token', openaiApiKey: 'sk-valid' });
    expect(report.results).toHaveLength(4);
    expect(report.results.map((r) => r.name)).toEqual([
      'discord-token',
      'openai-key',
      'workspace-path',
      'status-channel',
    ]);
  });

  it('sets allOk=true when all configured checks pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const report = await runCredentialChecks({ token: 'valid-token', openaiApiKey: 'sk-valid' });
    expect(report.allOk).toBe(true);
    expect(report.criticalFailures).toHaveLength(0);
  });

  it('sets allOk=true when the optional OpenAI key is not provided (skip counts as ok)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const report = await runCredentialChecks({ token: 'valid-token' });
    expect(report.allOk).toBe(true);
    expect(report.results.find((r) => r.name === 'openai-key')?.status).toBe('skip');
  });

  it('sets allOk=false and lists discord-token in criticalFailures when it fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    const report = await runCredentialChecks({ token: 'bad-token' });
    expect(report.allOk).toBe(false);
    expect(report.criticalFailures).toContain('discord-token');
  });

  it('sets allOk=false but no criticalFailures when only openai-key fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // discord: ok
        .mockResolvedValueOnce(new Response('{}', { status: 401 })), // openai: fail
    );
    const report = await runCredentialChecks({ token: 'valid-token', openaiApiKey: 'sk-bad' });
    expect(report.allOk).toBe(false);
    expect(report.criticalFailures).toHaveLength(0);
  });

  it('runs all checks concurrently (both fetch calls are made)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await runCredentialChecks({ token: 'token', openaiApiKey: 'sk-key' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('passes openaiBaseUrl through to checkOpenAiKey', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await runCredentialChecks({
      token: 'token',
      openaiApiKey: 'sk-key',
      openaiBaseUrl: 'https://custom.example.com/v1',
    });

    const openAiCall = fetchSpy.mock.calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('custom.example.com'),
    );
    expect(openAiCall).toBeDefined();
  });

  it('omits openai-key result when openai is not in activeProviders (key present)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const report = await runCredentialChecks({
      token: 'valid-token',
      openaiApiKey: 'sk-stale',
      activeProviders: new Set(['claude']),
    });

    expect(report.results.find((r) => r.name === 'openai-key')).toBeUndefined();
    // fetch should only be called once (for discord)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the openai-key check when openai is in activeProviders', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const report = await runCredentialChecks({
      token: 'valid-token',
      openaiApiKey: 'sk-valid',
      activeProviders: new Set(['openai']),
    });

    const openaiResult = report.results.find((r) => r.name === 'openai-key');
    expect(openaiResult).toBeDefined();
    expect(openaiResult?.status).toBe('ok');
  });

  it('preserves current behavior (runs openai check) when activeProviders is omitted', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const report = await runCredentialChecks({
      token: 'valid-token',
      openaiApiKey: 'sk-valid',
    });

    const openaiResult = report.results.find((r) => r.name === 'openai-key');
    expect(openaiResult).toBeDefined();
    expect(openaiResult?.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// formatCredentialReport ---------------------------------------------------

describe('formatCredentialReport', () => {
  it('formats a single ok result', () => {
    const report = makeReport([{ name: 'discord-token', status: 'ok' }]);
    expect(formatCredentialReport(report)).toBe('discord-token: ok');
  });

  it('formats a single skip result', () => {
    const report = makeReport([{ name: 'openai-key', status: 'skip' }]);
    expect(formatCredentialReport(report)).toBe('openai-key: skip');
  });

  it('formats a fail result with uppercase FAIL tag', () => {
    const report = makeReport([
      { name: 'discord-token', status: 'fail', message: 'invalid or revoked token (401)' },
    ]);
    const out = formatCredentialReport(report);
    expect(out).toContain('FAIL');
    expect(out).toContain('discord-token');
  });

  it('includes the message in parentheses for a fail result', () => {
    const report = makeReport([
      { name: 'discord-token', status: 'fail', message: 'network error: ECONNREFUSED' },
    ]);
    expect(formatCredentialReport(report)).toContain('(network error: ECONNREFUSED)');
  });

  it('omits parentheses when there is no message', () => {
    const report = makeReport([{ name: 'discord-token', status: 'ok' }]);
    expect(formatCredentialReport(report)).toBe('discord-token: ok');
  });

  it('joins multiple results with ", "', () => {
    const report = makeReport([
      { name: 'discord-token', status: 'ok' },
      { name: 'openai-key', status: 'skip' },
    ]);
    const out = formatCredentialReport(report);
    expect(out).toBe('discord-token: ok, openai-key: skip');
  });

  it('formats a mixed ok/fail report correctly', () => {
    const report = makeReport([
      { name: 'discord-token', status: 'ok' },
      { name: 'openai-key', status: 'fail', message: 'invalid or expired key (401)' },
    ]);
    const out = formatCredentialReport(report);
    expect(out).toContain('discord-token: ok');
    expect(out).toContain('openai-key: FAIL (invalid or expired key (401))');
  });
});
