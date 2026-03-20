import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoggerLike } from '../logging/logger-like.js';
import { ArtifactStore } from './artifact-store.js';
import type { CanvasArtifactRecord } from './artifact-store.js';
import type { CanvasBuiltinApps } from './apps.js';
import { CanvasFileExport } from './file-export.js';
import type { CanvasExportRequest } from './file-export.js';
import { LaunchStore } from './launch-store.js';
import type { CanvasLaunchContext } from './launch-store.js';
import { renderCanvasShellHtml } from './shell.js';
import { createSignedTokenSigner, type SignedTokenSigner } from './tokens.js';

const DEFAULT_REDIRECT_URI = 'https://127.0.0.1';
const MAX_JSON_BODY_BYTES = 6 * 1024 * 1024;
const DEFAULT_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LANDING_MESSAGE = 'Launch an artifact from a chat message to view it here.';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

type CanvasAuthClaims = {
  kind: 'canvas-auth';
  userId: string;
  iat: number;
  exp: number;
};

type JsonRecord = Record<string, unknown>;

export type CanvasLocalReadiness = {
  ready: boolean;
  missingChecks: string[];
  externalChecks: string[];
};

export type CanvasServerOptions = {
  port?: number;
  host?: string;
  discordClientId?: string;
  discordActivityClientSecret?: string;
  allowUserIds: ReadonlySet<string>;
  artifactStore: ArtifactStore;
  launchStore: LaunchStore;
  fileExport: CanvasFileExport;
  builtinApps: CanvasBuiltinApps;
  writeBridgeEnabled: boolean;
  fetchImpl?: typeof fetch;
  authSessionTtlMs?: number;
  allowMockAuth?: boolean;
  log?: LoggerLike;
};

export type CanvasServer = {
  server: http.Server;
  close(): Promise<void>;
  isListening(): boolean;
  getLocalReadiness(): CanvasLocalReadiness;
};

function buildCanvasExternalChecks(): string[] {
  return [
    'Add a URL Mapping in the Developer Portal pointing / to the public HTTPS canvas endpoint (e.g. your Tailscale Funnel or ngrok URL).',
    'Enable Activities on the Discord application in the Developer Portal (Application → Activities → Enable). Requires the URL Mapping first.',
  ];
}

export function buildCanvasLocalReadiness(opts: {
  discordClientId?: string;
  discordActivityClientSecret?: string;
  serverListening: boolean;
  artifactRoot: string;
  exportRoot: string;
}): CanvasLocalReadiness {
  const missingChecks: string[] = [];
  if (!opts.discordClientId) missingChecks.push('Discord application client ID is unavailable.');
  if (!opts.serverListening) missingChecks.push('Canvas server is not listening.');
  if (!opts.artifactRoot) missingChecks.push('Canvas artifact root could not be resolved.');
  if (!opts.exportRoot) missingChecks.push('Canvas export root could not be resolved.');
  return {
    ready: missingChecks.length === 0,
    missingChecks,
    externalChecks: buildCanvasExternalChecks(),
  };
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function parseJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('JSON body must be an object'));
          return;
        }
        resolve(parsed as JsonRecord);
      } catch {
        reject(new Error('Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function respondHtml(res: http.ServerResponse, status: number, body: string, headers?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function respondText(res: http.ServerResponse, status: number, body: string, headers?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function createAuthSigner(): SignedTokenSigner {
  return createSignedTokenSigner();
}

function normalizeGuildId(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function resolveDiscordUser(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; username?: string; global_name?: string } | null> {
  const response = await fetchImpl('https://discord.com/api/v10/users/@me', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!json || typeof json.id !== 'string') return null;
  return {
    id: json.id,
    username: typeof json.username === 'string' ? json.username : undefined,
    global_name: typeof json.global_name === 'string' ? json.global_name : undefined,
  };
}

async function exchangeDiscordCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
}): Promise<{ access_token: string } | null> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: DEFAULT_REDIRECT_URI,
  });

  const response = await input.fetchImpl('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!json || typeof json.access_token !== 'string') return null;
  return { access_token: json.access_token };
}

function buildShellCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com",
  ].join('; ');
}

function buildArtifactCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function buildInlineScriptTag(scriptSource: string): string {
  return `<script>${scriptSource.replace(/<\/script/gi, '<\\/script')}</script>`;
}

function injectArtifactRuntimeHtml(documentHtml: string, runtimeSource: string | null): string {
  if (!runtimeSource) return documentHtml;
  const runtimeTag = buildInlineScriptTag(runtimeSource);

  const headCloseMatch = documentHtml.match(/<\/head\s*>/i);
  if (headCloseMatch?.index != null) {
    return `${documentHtml.slice(0, headCloseMatch.index)}${runtimeTag}${documentHtml.slice(headCloseMatch.index)}`;
  }

  const htmlOpenMatch = documentHtml.match(/<html\b[^>]*>/i);
  if (htmlOpenMatch?.index != null) {
    const insertionIndex = htmlOpenMatch.index + htmlOpenMatch[0].length;
    return `${documentHtml.slice(0, insertionIndex)}<head>${runtimeTag}</head>${documentHtml.slice(insertionIndex)}`;
  }

  const bodyOpenMatch = documentHtml.match(/<body\b[^>]*>/i);
  if (bodyOpenMatch?.index != null) {
    return `${documentHtml.slice(0, bodyOpenMatch.index)}<head>${runtimeTag}</head>${documentHtml.slice(bodyOpenMatch.index)}`;
  }

  return `${runtimeTag}${documentHtml}`;
}

function buildAuthClaims(signer: SignedTokenSigner, userId: string, ttlMs: number): string {
  const now = Date.now();
  return signer.sign<CanvasAuthClaims>({
    kind: 'canvas-auth',
    userId,
    iat: now,
    exp: now + ttlMs,
  });
}

function verifyAuthClaims(signer: SignedTokenSigner, token: string | null): CanvasAuthClaims | null {
  if (!token) return null;
  const claims = signer.verify<CanvasAuthClaims>(token);
  if (
    !claims
    || claims.kind !== 'canvas-auth'
    || typeof claims.userId !== 'string'
    || typeof claims.iat !== 'number'
    || typeof claims.exp !== 'number'
  ) {
    return null;
  }
  if (claims.exp <= Date.now()) return null;
  return claims;
}

function requireAllowlistedUser(allowUserIds: ReadonlySet<string>, userId: string): boolean {
  return allowUserIds.has(userId);
}

export async function startCanvasServer(opts: CanvasServerOptions): Promise<CanvasServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 9402;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const authSigner = createAuthSigner();
  const authSessionTtlMs = opts.authSessionTtlMs ?? DEFAULT_AUTH_SESSION_TTL_MS;
  // Bundled SDK: dist/vendor/embedded-app-sdk.js — resolve from project root
  // so the path works whether MODULE_DIR is src/canvas/ or dist/canvas/.
  const bundledSdkPath = path.resolve(MODULE_DIR, '..', '..', 'dist', 'vendor', 'embedded-app-sdk.js');
  const bundledSdkCache = await fs.readFile(bundledSdkPath, 'utf8').catch(() => null);
  if (bundledSdkCache == null) {
    opts.log?.error({ path: bundledSdkPath }, 'canvas:sdk-bundle missing — run the bundle-embedded-sdk script');
  }
  const canvasRuntimePath = path.resolve(MODULE_DIR, '..', '..', 'dist', 'vendor', 'canvas-runtime.js');
  const canvasRuntimeCache = await fs.readFile(canvasRuntimePath, 'utf8').catch(() => null);
  if (canvasRuntimeCache == null) {
    opts.log?.error({ path: canvasRuntimePath }, 'canvas:runtime-bundle missing — build dist/vendor/canvas-runtime.js');
  }

  await opts.artifactStore.ensureReady();
  await opts.fileExport.ensureReady();

  let listening = false;

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    opts.log?.info(
      { method: req.method, pathname, userAgent: req.headers['user-agent'] },
      'canvas:request',
    );

    try {
      if ((req.method ?? 'GET') === 'GET' && pathname === '/healthz') {
        respondJson(res, 200, {
          ok: true,
          readiness: buildCanvasLocalReadiness({
            discordClientId: opts.discordClientId,
            discordActivityClientSecret: opts.discordActivityClientSecret,
            serverListening: listening,
            artifactRoot: opts.artifactStore.rootPath(),
            exportRoot: opts.fileExport.rootPath(),
          }),
        });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        const body = renderCanvasShellHtml({
          nonce,
          discordClientId: opts.discordClientId ?? '',
          writeBridgeEnabled: opts.writeBridgeEnabled,
          defaultLandingMessage: DEFAULT_LANDING_MESSAGE,
          authMode: opts.discordActivityClientSecret ? 'oauth' : 'preauth',
        });
        respondHtml(res, 200, body, {
          'Content-Security-Policy': buildShellCsp(nonce),
        });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname.startsWith('/vendor/embedded-app-sdk/')) {
        if (pathname === '/vendor/embedded-app-sdk/bundle.js') {
          if (bundledSdkCache == null) {
            respondJson(res, 404, { error: 'Bundled SDK not found — run the bundle-embedded-sdk script' });
            return;
          }
          respondText(res, 200, bundledSdkCache, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          });
          return;
        }
        respondJson(res, 404, { error: 'Not found' });
        return;
      }

      if ((req.method ?? 'POST') === 'POST' && pathname === '/api/token') {
        const body = await parseJsonBody(req, MAX_JSON_BODY_BYTES);
        const code = typeof body.code === 'string' ? body.code.trim() : '';

        // Pre-auth branch: authenticate by activity context when no OAuth secret is configured.
        // Peeks at the pending entry without consuming it so /api/launches/current can resolve it later.
        const preauthChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
        const preauthGuildId = typeof body.guildId === 'string' ? body.guildId.trim() : '';
        if (!code && preauthChannelId) {
          const pending = opts.launchStore.peekByActivity(
            preauthChannelId,
            preauthGuildId || null,
          );
          if (!pending || !requireAllowlistedUser(opts.allowUserIds, pending.userId)) {
            respondJson(res, 403, { error: 'No authorized pending launch for this activity context' });
            return;
          }
          respondJson(res, 200, {
            authToken: buildAuthClaims(authSigner, pending.userId, authSessionTtlMs),
            user: { id: pending.userId },
          });
          return;
        }

        if (!code) {
          respondJson(res, 400, { error: 'Missing OAuth code' });
          return;
        }

        let accessToken = '';
        let user: { id: string; username?: string; global_name?: string } | null = null;

        if (opts.allowMockAuth && code.startsWith('mock:')) {
          const userId = code.slice('mock:'.length).trim() || 'mock-user';
          accessToken = `mock-access:${userId}`;
          user = { id: userId, username: userId };
        } else {
          if (!opts.discordClientId || !opts.discordActivityClientSecret) {
            respondJson(res, 503, { error: 'Canvas OAuth configuration is incomplete' });
            return;
          }

          const tokenResult = await exchangeDiscordCode({
            code,
            clientId: opts.discordClientId,
            clientSecret: opts.discordActivityClientSecret,
            fetchImpl,
          });
          if (!tokenResult) {
            respondJson(res, 502, { error: 'Discord OAuth token exchange failed' });
            return;
          }

          accessToken = tokenResult.access_token;
          user = await resolveDiscordUser(accessToken, fetchImpl);
        }

        if (!user || !requireAllowlistedUser(opts.allowUserIds, user.id)) {
          respondJson(res, 403, { error: 'Discord user is not authorized for this install' });
          return;
        }

        respondJson(res, 200, {
          access_token: accessToken,
          authToken: buildAuthClaims(authSigner, user.id, authSessionTtlMs),
          user,
        });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname === '/api/launches/current') {
        const authClaims = verifyAuthClaims(authSigner, extractBearerToken(req));
        if (!authClaims || !requireAllowlistedUser(opts.allowUserIds, authClaims.userId)) {
          respondJson(res, 401, { error: 'Canvas auth session is missing or expired' });
          return;
        }

        const channelId = requestUrl.searchParams.get('channelId')?.trim() ?? '';
        const guildId = normalizeGuildId(requestUrl.searchParams.get('guildId'));
        if (!channelId) {
          respondJson(res, 404, { error: 'No pending canvas launch for this activity context' });
          return;
        }

        const context: CanvasLaunchContext = {
          userId: authClaims.userId,
          channelId,
          guildId,
        };
        const resolution = opts.launchStore.resolveCurrent(
          context,
          typeof req.headers['x-canvas-bound-session'] === 'string'
            ? req.headers['x-canvas-bound-session']
            : null,
        );
        if (!resolution) {
          respondJson(res, 404, { error: 'No pending canvas launch for this activity context' });
          return;
        }

        if (resolution.target.type === 'artifact') {
          const meta = await opts.artifactStore.getArtifactMeta(resolution.target.artifactId);
          if (!meta) {
            respondJson(res, 404, { error: 'Canvas artifact no longer exists' });
            return;
          }
          respondJson(res, 200, {
            target: {
              type: 'artifact' as const,
              id: meta.id,
              title: meta.title,
            },
            boundSessionToken: resolution.boundSessionToken,
            source: resolution.source,
          });
          return;
        }

        if (resolution.target.type === 'app') {
          const appTitle = opts.builtinApps.getAppTitle(resolution.target.appName);
          if (!appTitle) {
            respondJson(res, 404, { error: 'Canvas app is not available on this install' });
            return;
          }
          respondJson(res, 200, {
            target: {
              type: 'app' as const,
              name: resolution.target.appName,
              title: appTitle,
            },
            boundSessionToken: resolution.boundSessionToken,
            source: resolution.source,
          });
          return;
        }

        respondJson(res, 404, { error: 'Canvas launch target is invalid' });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname === '/api/session/refresh') {
        const authClaims = verifyAuthClaims(authSigner, extractBearerToken(req));
        if (!authClaims || !requireAllowlistedUser(opts.allowUserIds, authClaims.userId)) {
          respondJson(res, 401, { error: 'Canvas auth session is missing or expired' });
          return;
        }

        const channelId = requestUrl.searchParams.get('channelId')?.trim() ?? '';
        const guildId = normalizeGuildId(requestUrl.searchParams.get('guildId'));
        if (!channelId) {
          respondJson(res, 400, { error: 'Canvas session refresh requires channelId' });
          return;
        }

        const boundSessionToken = typeof req.headers['x-canvas-bound-session'] === 'string'
          ? req.headers['x-canvas-bound-session']
          : '';
        const refreshed = opts.launchStore.refreshBoundSession(boundSessionToken, {
          userId: authClaims.userId,
          channelId,
          guildId,
        });
        if (!refreshed) {
          respondJson(res, 401, { error: 'Canvas launch session is missing or expired' });
          return;
        }

        respondJson(res, 200, {
          authToken: buildAuthClaims(authSigner, authClaims.userId, authSessionTtlMs),
          boundSessionToken: refreshed.boundSessionToken,
          target: refreshed.target,
        });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname.startsWith('/api/artifacts/')) {
        const remainder = pathname.slice('/api/artifacts/'.length);
        const isRenderRequest = remainder.endsWith('/render');
        const artifactId = decodeURIComponent(isRenderRequest ? remainder.slice(0, -'/render'.length) : remainder);

        // Render endpoint: auth via query params (iframe src can't send headers).
        // JSON endpoint: auth via Bearer header (shell JS fetch).
        let authClaims: CanvasAuthClaims | null;
        let boundSession: ReturnType<typeof opts.launchStore.verifyBoundSession>;

        if (isRenderRequest) {
          const authParam = requestUrl.searchParams.get('auth') ?? '';
          const sessionParam = requestUrl.searchParams.get('session') ?? '';
          authClaims = verifyAuthClaims(authSigner, authParam || null);
          boundSession = opts.launchStore.verifyBoundSession(sessionParam);
        } else {
          authClaims = verifyAuthClaims(authSigner, extractBearerToken(req));
          const boundSessionHeader = typeof req.headers['x-canvas-bound-session'] === 'string'
            ? req.headers['x-canvas-bound-session']
            : '';
          boundSession = opts.launchStore.verifyBoundSession(boundSessionHeader);
        }

        if (!authClaims || !requireAllowlistedUser(opts.allowUserIds, authClaims.userId)) {
          respondJson(res, 401, { error: 'Canvas auth session is missing or expired' });
          return;
        }
        if (!boundSession || boundSession.userId !== authClaims.userId) {
          respondJson(res, 401, { error: 'Canvas launch session is missing or expired' });
          return;
        }
        if (boundSession.target.type !== 'artifact') {
          respondJson(res, 403, { error: 'Canvas launch session does not allow artifact access' });
          return;
        }
        if (artifactId !== boundSession.target.artifactId) {
          respondJson(res, 403, { error: 'Canvas launch session does not match the requested artifact' });
          return;
        }

        const artifact = await opts.artifactStore.getArtifact(artifactId);
        if (!artifact) {
          respondJson(res, 404, { error: 'Canvas artifact not found' });
          return;
        }

        if (isRenderRequest) {
          // Serve raw HTML with a permissive CSP for artifact content.
          // The iframe is sandboxed (no allow-same-origin) so inline scripts
          // cannot access the parent's origin, cookies, or storage.
          respondHtml(res, 200, injectArtifactRuntimeHtml(artifact.content, canvasRuntimeCache), {
            'Content-Security-Policy': buildArtifactCsp(),
          });
          return;
        }

        const response: CanvasArtifactRecord = artifact;
        respondJson(res, 200, response);
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && pathname.startsWith('/api/apps/')) {
        const authClaims = verifyAuthClaims(authSigner, extractBearerToken(req));
        if (!authClaims || !requireAllowlistedUser(opts.allowUserIds, authClaims.userId)) {
          respondJson(res, 401, { error: 'Canvas auth session is missing or expired' });
          return;
        }

        const remainder = pathname.slice('/api/apps/'.length);
        const isDataRequest = remainder.endsWith('/data');
        const appName = decodeURIComponent(isDataRequest ? remainder.slice(0, -'/data'.length) : remainder);
        if (!appName) {
          respondJson(res, 404, { error: 'Not found' });
          return;
        }

        const boundSessionToken = typeof req.headers['x-canvas-bound-session'] === 'string'
          ? req.headers['x-canvas-bound-session']
          : '';
        const boundSession = opts.launchStore.verifyBoundSession(boundSessionToken);
        if (!boundSession || boundSession.userId !== authClaims.userId) {
          respondJson(res, 401, { error: 'Canvas launch session is missing or expired' });
          return;
        }
        if (boundSession.target.type !== 'app' || boundSession.target.appName !== appName) {
          respondJson(res, 403, { error: 'Canvas launch session does not match the requested app' });
          return;
        }

        if (isDataRequest) {
          const data = await opts.builtinApps.getAppData(appName);
          if (data == null) {
            respondJson(res, 404, { error: 'Canvas app is not available on this install' });
            return;
          }
          respondJson(res, 200, { app: appName, data });
          return;
        }

        const app = await opts.builtinApps.renderApp(appName);
        if (!app) {
          respondJson(res, 404, { error: 'Canvas app is not available on this install' });
          return;
        }
        respondJson(res, 200, app);
        return;
      }

      if ((req.method ?? 'POST') === 'POST' && pathname === '/api/files/save') {
        const authClaims = verifyAuthClaims(authSigner, extractBearerToken(req));
        if (!authClaims || !requireAllowlistedUser(opts.allowUserIds, authClaims.userId)) {
          respondJson(res, 401, { error: 'Canvas auth session is missing or expired' });
          return;
        }

        if (!opts.writeBridgeEnabled) {
          respondJson(res, 403, { error: 'Canvas file export is disabled' });
          return;
        }

        const boundSessionToken = typeof req.headers['x-canvas-bound-session'] === 'string'
          ? req.headers['x-canvas-bound-session']
          : '';
        const boundSession = opts.launchStore.verifyBoundSession(boundSessionToken);
        if (!boundSession || boundSession.userId !== authClaims.userId) {
          respondJson(res, 401, { error: 'Canvas launch session is missing or expired' });
          return;
        }

        const body = await parseJsonBody(req, MAX_JSON_BODY_BYTES);
        const saveRequest: CanvasExportRequest = {
          suggestedName: typeof body.suggestedName === 'string' ? body.suggestedName : undefined,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : '',
          encoding: body.encoding === 'base64' ? 'base64' : 'utf8',
          content: typeof body.content === 'string' ? body.content : '',
        };

        let result;
        try {
          result = await opts.fileExport.saveExport(saveRequest);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Unsupported export MIME type') || message.includes('Suggested export filename')) {
            respondJson(res, 400, { error: message });
            return;
          }
          if (message.includes('exceeds')) {
            respondJson(res, 413, { error: message });
            return;
          }
          throw err;
        }
        opts.log?.info(
          {
            userId: authClaims.userId,
            channelId: boundSession.channelId,
            guildId: boundSession.guildId,
            targetType: boundSession.target.type,
            targetId: boundSession.target.type === 'artifact' ? boundSession.target.artifactId : boundSession.target.appName,
            path: result.absolutePath,
            bytes: result.bytes,
          },
          'canvas:file-export saved',
        );

        respondJson(res, 200, {
          ok: true,
          fileName: result.fileName,
          relativePath: result.relativePath,
          bytes: result.bytes,
          mimeType: result.mimeType,
        });
        return;
      }

      respondJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Request body too large' ? 413 : 500;
      opts.log?.error({ err, pathname }, 'canvas:request failed');
      respondJson(res, status, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  listening = true;
  opts.log?.info({ host, port }, 'canvas:server listening');

  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          listening = false;
          if (err) reject(err);
          else resolve();
        });
      });
    },
    isListening(): boolean {
      return listening;
    },
    getLocalReadiness(): CanvasLocalReadiness {
      return buildCanvasLocalReadiness({
        discordClientId: opts.discordClientId,
        discordActivityClientSecret: opts.discordActivityClientSecret,
        serverListening: listening,
        artifactRoot: opts.artifactStore.rootPath(),
        exportRoot: opts.fileExport.rootPath(),
      });
    },
  };
}

export function buildCanvasSetupWalkthrough(readiness: CanvasLocalReadiness): string {
  const localLines = readiness.missingChecks.length > 0
    ? readiness.missingChecks.map((line, index) => `${index + 1}. ${line}`)
    : ['1. Local readiness checks passed.'];
  const externalLines = readiness.externalChecks.map((line, index) => `${index + 1}. ${line}`);

  return [
    'Canvas Activities are available in Discord actions, but this install is not fully configured yet.',
    'Local checks:',
    ...localLines,
    'Manual Discord setup:',
    ...externalLines,
    'After updating configuration, restart the bot and retry the request.',
  ].join(' ');
}
