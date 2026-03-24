/**
 * Lightweight provider auth probes for the dashboard.
 *
 * Each probe performs a single, inexpensive API call to verify that a
 * credential is valid.  All functions always resolve — they return a
 * structured result instead of throwing.
 */

const PROBE_TIMEOUT_MS = 5_000;

export type AuthProbeStatus = 'ok' | 'fail' | 'skip';

export type AuthProbeResult = {
  provider: string;
  status: AuthProbeStatus;
  message?: string;
};

// ---------------------------------------------------------------------------
// OpenAI / OpenAI-compat
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export async function probeOpenAi(opts: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<AuthProbeResult> {
  const provider = 'openai';
  if (!opts.apiKey) return { provider, status: 'skip' };

  const base = (opts.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { provider, status: 'ok' };
    if (res.status === 401) return { provider, status: 'fail', message: 'invalid or expired key (401)' };
    return { provider, status: 'fail', message: `unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { provider, status: 'fail', message: `network error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Gemini (Generative Language API)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function probeGemini(opts: {
  apiKey?: string;
}): Promise<AuthProbeResult> {
  const provider = 'gemini';
  if (!opts.apiKey) return { provider, status: 'skip' };

  try {
    const res = await fetch(`${GEMINI_API_BASE}/models?key=${opts.apiKey}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { provider, status: 'ok' };
    if (res.status === 400 || res.status === 403) {
      return { provider, status: 'fail', message: `invalid or restricted key (${res.status})` };
    }
    return { provider, status: 'fail', message: `unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { provider, status: 'fail', message: `network error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

export async function probeAnthropic(opts: {
  apiKey?: string;
}): Promise<AuthProbeResult> {
  const provider = 'anthropic';
  if (!opts.apiKey) return { provider, status: 'skip' };

  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 200 or 400 (invalid request shape) both indicate a valid key.
    // Only 401/403 indicate an invalid key.
    if (res.ok || res.status === 400) return { provider, status: 'ok' };
    if (res.status === 401) return { provider, status: 'fail', message: 'invalid or expired key (401)' };
    if (res.status === 403) return { provider, status: 'fail', message: 'permission denied (403)' };
    return { provider, status: 'fail', message: `unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { provider, status: 'fail', message: `network error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Batch probe
// ---------------------------------------------------------------------------

export type AuthProbeReport = {
  results: AuthProbeResult[];
  allOk: boolean;
};

/**
 * Run all relevant probes concurrently and return a summary.
 * Never throws.
 */
export async function probeProviderAuth(opts: {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
}): Promise<AuthProbeReport> {
  const results = await Promise.all([
    probeOpenAi({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl }),
    probeGemini({ apiKey: opts.geminiApiKey }),
    probeAnthropic({ apiKey: opts.anthropicApiKey }),
  ]);
  return {
    results,
    allOk: results.every((r) => r.status === 'ok' || r.status === 'skip'),
  };
}
