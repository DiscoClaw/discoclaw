import fs from 'node:fs/promises';
import path from 'node:path';

// Codex CLI's registered OAuth client_id — see https://github.com/openai/codex
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

export type AuthFileData = {
  auth_mode: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

type RefreshResult = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
};

type Logger = {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type ChatGptTokenProvider = {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
};

/** Read and parse the Codex auth file. Expects an absolute path. */
export async function loadAuthFile(filePath: string): Promise<AuthFileData> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as AuthFileData;

  if (!data.tokens?.access_token || !data.tokens?.refresh_token) {
    throw new Error(
      `Auth file ${filePath} missing required tokens (access_token, refresh_token)`,
    );
  }

  return data;
}

/** Base64url-decode the JWT payload and extract the `exp` claim. */
export function decodeJwtExp(token: string): number {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT: expected at least 2 dot-separated segments');
  }

  // Base64url → Base64 → Buffer → JSON
  const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  const payload = JSON.parse(json) as { exp?: number };

  if (typeof payload.exp !== 'number') {
    throw new Error('JWT payload missing numeric "exp" claim');
  }

  return payload.exp;
}

/**
 * Returns true if the token's `exp` minus `bufferSecs` is before now.
 * 5-minute buffer by default to avoid edge-case expiry mid-request.
 */
export function isTokenExpired(token: string, bufferSecs = 300): boolean {
  try {
    const exp = decodeJwtExp(token);
    return exp - bufferSecs < Date.now() / 1000;
  } catch {
    // If we can't decode, treat as expired so we refresh
    return true;
  }
}

/** POST to OpenAI's OAuth endpoint to refresh the access token. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId = CODEX_CLIENT_ID,
): Promise<RefreshResult> {
  const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Token refresh failed (${response.status}): ${body} [client_id=${clientId}]`,
    );
  }

  const result = (await response.json()) as RefreshResult;

  if (!result.access_token) {
    throw new Error(
      `Token refresh returned no access_token [client_id=${clientId}]`,
    );
  }

  return result;
}

/**
 * Write updated tokens back to the auth file.
 * Atomic write via temp file + rename. On failure, logs a warning but does not throw
 * — the in-memory token is still valid.
 */
export async function saveAuthFile(
  filePath: string,
  data: AuthFileData,
  log?: Logger,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.auth.tmp.${process.pid}`);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    log?.warn({ err, filePath }, 'openai-auth: failed to persist auth file (in-memory token still valid)');
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Create a token provider that manages ChatGPT OAuth access tokens.
 * Reads from the Codex CLI auth file, refreshes when expired, and persists updates.
 * Uses a mutex to prevent concurrent refresh storms.
 */
export function createChatGptTokenProvider(opts: {
  authFilePath: string;
  log: Logger;
}): ChatGptTokenProvider {
  const { authFilePath, log } = opts;

  let cachedToken: string | null = null;
  let cachedAuthData: AuthFileData | null = null;
  let acquirePromise: Promise<string> | null = null;

  /** Load file, check expiry, refresh if needed — all under a single mutex. */
  async function acquireToken(forceRefresh: boolean): Promise<string> {
    // Load auth data from file if not yet cached
    if (!cachedAuthData) {
      try {
        cachedAuthData = await loadAuthFile(authFilePath);
        cachedToken = cachedAuthData.tokens.access_token;
      } catch (err) {
        log.error({ err }, 'openai-auth: failed to load auth file');
        throw err;
      }
    }

    // If token is still valid and not forcing, return it
    if (!forceRefresh && cachedToken && !isTokenExpired(cachedToken)) {
      return cachedToken;
    }

    // Refresh
    log.debug('openai-auth: refreshing access token');

    const result = await refreshAccessToken(cachedAuthData.tokens.refresh_token);

    // Update cached auth data with new tokens
    cachedAuthData = {
      ...cachedAuthData,
      tokens: {
        ...cachedAuthData.tokens,
        access_token: result.access_token,
        ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
        ...(result.id_token ? { id_token: result.id_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };

    cachedToken = result.access_token;

    // Persist to disk (non-throwing)
    await saveAuthFile(authFilePath, cachedAuthData, log);

    log.debug('openai-auth: token refreshed successfully');
    return cachedToken;
  }

  return {
    async getAccessToken(forceRefresh = false): Promise<string> {
      // Fast path: return cached non-expired token (no async work)
      if (!forceRefresh && cachedToken && !isTokenExpired(cachedToken)) {
        return cachedToken;
      }

      // Mutex: if an acquire is already in progress, wait for it
      if (acquirePromise) {
        return acquirePromise;
      }

      acquirePromise = acquireToken(forceRefresh).finally(() => {
        acquirePromise = null;
      });

      return acquirePromise;
    },
  };
}
