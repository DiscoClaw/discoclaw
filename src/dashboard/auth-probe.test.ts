import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAnthropic, probeGemini, probeOpenAi, probeProviderAuth } from './auth-probe.js';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

afterEach(() => {
  fetchSpy.mockReset();
});

// ---------------------------------------------------------------------------
// probeOpenAi
// ---------------------------------------------------------------------------
describe('probeOpenAi', () => {
  it('returns skip when no API key is provided', async () => {
    const result = await probeOpenAi({});
    expect(result).toEqual({ provider: 'openai', status: 'skip' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok on 200', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await probeOpenAi({ apiKey: 'sk-test' });
    expect(result).toEqual({ provider: 'openai', status: 'ok' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
    );
  });

  it('returns fail on 401', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const result = await probeOpenAi({ apiKey: 'sk-bad' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('401');
  });

  it('returns fail on unexpected status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    const result = await probeOpenAi({ apiKey: 'sk-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('500');
  });

  it('returns fail on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connection refused'));
    const result = await probeOpenAi({ apiKey: 'sk-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('connection refused');
  });

  it('uses custom baseUrl when provided', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await probeOpenAi({ apiKey: 'sk-test', baseUrl: 'https://custom.api/v1/' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://custom.api/v1/models',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// probeGemini
// ---------------------------------------------------------------------------
describe('probeGemini', () => {
  it('returns skip when no API key is provided', async () => {
    const result = await probeGemini({});
    expect(result).toEqual({ provider: 'gemini', status: 'skip' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok on 200', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await probeGemini({ apiKey: 'AIza-test' });
    expect(result).toEqual({ provider: 'gemini', status: 'ok' });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('key=AIza-test'),
      expect.anything(),
    );
  });

  it('returns fail on 400', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    const result = await probeGemini({ apiKey: 'bad-key' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('400');
  });

  it('returns fail on 403', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 403 }));
    const result = await probeGemini({ apiKey: 'bad-key' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('403');
  });

  it('returns fail on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    const result = await probeGemini({ apiKey: 'AIza-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// probeAnthropic
// ---------------------------------------------------------------------------
describe('probeAnthropic', () => {
  it('returns skip when no API key is provided', async () => {
    const result = await probeAnthropic({});
    expect(result).toEqual({ provider: 'anthropic', status: 'skip' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok on 200', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await probeAnthropic({ apiKey: 'sk-ant-test' });
    expect(result).toEqual({ provider: 'anthropic', status: 'ok' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
      }),
    );
  });

  it('returns ok on 400 (valid key, bad request shape)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    const result = await probeAnthropic({ apiKey: 'sk-ant-test' });
    expect(result.status).toBe('ok');
  });

  it('returns fail on 401', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const result = await probeAnthropic({ apiKey: 'sk-ant-bad' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('401');
  });

  it('returns fail on 403', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 403 }));
    const result = await probeAnthropic({ apiKey: 'sk-ant-bad' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('403');
  });

  it('returns fail on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await probeAnthropic({ apiKey: 'sk-ant-test' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// probeProviderAuth
// ---------------------------------------------------------------------------
describe('probeProviderAuth', () => {
  it('runs all probes concurrently and includes anthropic', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const report = await probeProviderAuth({
      openaiApiKey: 'sk-test',
      geminiApiKey: 'AIza-test',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(report.results).toHaveLength(3);
    expect(report.results.map((r) => r.provider)).toEqual(['openai', 'gemini', 'anthropic']);
    expect(report.allOk).toBe(true);
  });

  it('reports allOk false when any probe fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('', { status: 401 }))  // openai
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))  // gemini
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));  // anthropic
    const report = await probeProviderAuth({
      openaiApiKey: 'sk-bad',
      geminiApiKey: 'AIza-test',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(report.allOk).toBe(false);
    expect(report.results[0]?.status).toBe('fail');
  });

  it('skips probes without keys', async () => {
    const report = await probeProviderAuth({});
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.status === 'skip')).toBe(true);
    expect(report.allOk).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
