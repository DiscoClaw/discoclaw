const DISCORD_API_BASE = 'https://discord.com/api/v10';
const OPENAI_API_DEFAULT_BASE = 'https://api.openai.com/v1';

export type CredentialStatus = 'ok' | 'fail' | 'skip';

export type CredentialCheckResult = {
  /** Stable identifier for this check (e.g. 'discord-token', 'openai-key'). */
  name: string;
  status: CredentialStatus;
  /** Human-readable detail; present on 'fail' and sometimes 'skip'. */
  message?: string;
};

export type CredentialCheckReport = {
  results: CredentialCheckResult[];
  /** Names of checks that are both critical AND failed. */
  criticalFailures: string[];
  /** True when every check is 'ok' or 'skip' (nothing failed). */
  allOk: boolean;
};

// Credentials in this set gate core bot functionality; failure is surfaced prominently.
const CRITICAL = new Set(['discord-token']);

/**
 * Validate the Discord bot token by calling GET /users/@me.
 * Always resolves — returns a 'fail' result on network error instead of throwing.
 */
export async function checkDiscordToken(token: string): Promise<CredentialCheckResult> {
  const name = 'discord-token';
  try {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      return { name, status: 'ok' };
    }
    if (res.status === 401) {
      return { name, status: 'fail', message: 'invalid or revoked token (401)' };
    }
    return { name, status: 'fail', message: `unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `network error: ${msg}` };
  }
}

/**
 * Validate the OpenAI API key by calling GET /models on the configured base URL.
 * Returns 'skip' when no key is configured.
 * Always resolves — returns a 'fail' result on network error instead of throwing.
 */
export async function checkOpenAiKey(opts: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<CredentialCheckResult> {
  const name = 'openai-key';
  const { apiKey, baseUrl } = opts;

  if (!apiKey) {
    return { name, status: 'skip' };
  }

  const base = (baseUrl ?? OPENAI_API_DEFAULT_BASE).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      return { name, status: 'ok' };
    }
    if (res.status === 401) {
      return { name, status: 'fail', message: 'invalid or expired key (401)' };
    }
    if (res.status === 403) {
      return { name, status: 'fail', message: 'key lacks required permissions (403)' };
    }
    return { name, status: 'fail', message: `unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `network error: ${msg}` };
  }
}

/**
 * Run all credential checks concurrently and return a structured report.
 * Never throws — individual validators are responsible for their own error handling.
 */
export async function runCredentialChecks(opts: {
  token: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): Promise<CredentialCheckReport> {
  const results = await Promise.all([
    checkDiscordToken(opts.token),
    checkOpenAiKey({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl }),
  ]);

  const criticalFailures = results
    .filter((r) => r.status === 'fail' && CRITICAL.has(r.name))
    .map((r) => r.name);

  const allOk = results.every((r) => r.status === 'ok' || r.status === 'skip');

  return { results, criticalFailures, allOk };
}

/**
 * Format a credential check report into a compact, single-line string
 * suitable for inclusion in the boot report posted to the status channel.
 *
 * Example: "discord-token: ok, openai-key: FAIL (invalid or expired key (401))"
 */
export function formatCredentialReport(report: CredentialCheckReport): string {
  return report.results
    .map((r) => {
      const tag = r.status === 'ok' ? 'ok' : r.status === 'skip' ? 'skip' : 'FAIL';
      const detail = r.message ? ` (${r.message})` : '';
      return `${r.name}: ${tag}${detail}`;
    })
    .join(', ');
}
