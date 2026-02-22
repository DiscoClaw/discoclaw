import fs from 'node:fs/promises';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const OPENAI_API_DEFAULT_BASE = 'https://api.openai.com/v1';
const OPENROUTER_API_DEFAULT_BASE = 'https://openrouter.ai/api/v1';

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
 * Validate the OpenRouter API key by calling GET /models on the configured base URL.
 * Returns 'skip' when no key is configured.
 * Always resolves — returns a 'fail' result on network error instead of throwing.
 */
export async function checkOpenRouterKey(opts: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<CredentialCheckResult> {
  const name = 'openrouter-key';
  const { apiKey, baseUrl } = opts;

  if (!apiKey) {
    return { name, status: 'skip' };
  }

  const base = (baseUrl ?? OPENROUTER_API_DEFAULT_BASE).replace(/\/$/, '');
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
 * Check that the workspace path exists and is read/write accessible.
 * Returns 'skip' if no path is provided.
 * Always resolves — returns a 'fail' result on access error instead of throwing.
 */
export async function checkWorkspacePath(workspacePath?: string): Promise<CredentialCheckResult> {
  const name = 'workspace-path';
  if (!workspacePath) {
    return { name, status: 'skip' };
  }
  try {
    await fs.access(workspacePath, fs.constants.R_OK | fs.constants.W_OK);
    return { name, status: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `workspace not accessible: ${msg}` };
  }
}

/**
 * Validate that a status channel is configured (either a name or Discord snowflake ID).
 * Returns 'skip' if no channel is configured.
 */
export function checkStatusChannel(channelId?: string): CredentialCheckResult {
  const name = 'status-channel';
  if (!channelId) {
    return { name, status: 'skip', message: 'not configured' };
  }
  return { name, status: 'ok' };
}

/**
 * Run all credential checks concurrently and return a structured report.
 * Never throws — individual validators are responsible for their own error handling.
 *
 * When `activeProviders` is provided, the OpenAI key check is only run if
 * `'openai'` is in the set; otherwise the result is omitted from the report
 * entirely. The OpenRouter key check is only run if `'openrouter'` is in the
 * set; otherwise the result is omitted from the report entirely. The Discord
 * token check always runs. If `activeProviders` is omitted, the current
 * behavior is preserved (OpenAI check runs as normal).
 */
export async function runCredentialChecks(opts: {
  token: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  workspacePath?: string;
  statusChannelId?: string;
  activeProviders?: Set<string>;
}): Promise<CredentialCheckReport> {
  const runOpenAi = opts.activeProviders === undefined || opts.activeProviders.has('openai');
  const runOpenRouter = opts.activeProviders !== undefined && opts.activeProviders.has('openrouter');

  const [discordResult, openaiResult, openrouterResult, workspaceResult, statusResult] =
    await Promise.all([
      checkDiscordToken(opts.token),
      runOpenAi
        ? checkOpenAiKey({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl })
        : null,
      runOpenRouter
        ? checkOpenRouterKey({ apiKey: opts.openrouterApiKey, baseUrl: opts.openrouterBaseUrl })
        : null,
      checkWorkspacePath(opts.workspacePath),
      Promise.resolve(checkStatusChannel(opts.statusChannelId)),
    ]);

  const results: CredentialCheckResult[] = [discordResult];
  if (openaiResult !== null) results.push(openaiResult);
  if (openrouterResult !== null) results.push(openrouterResult);
  results.push(workspaceResult, statusResult);

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
