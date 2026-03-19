import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from './artifact-store.js';
import { createCanvasBuiltinApps } from './apps.js';
import { CanvasFileExport } from './file-export.js';
import { LaunchStore } from './launch-store.js';
import { startCanvasServer } from './server.js';

const tempDirs: string[] = [];
const serversToClose: Array<{ close(): Promise<void> }> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(serversToClose.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function startHarness(input?: {
  writeBridgeEnabled?: boolean;
  allowMockAuth?: boolean;
  fetchImpl?: typeof fetch;
  discordActivityClientSecret?: string;
}) {
  const dir = await makeTempDir('discoclaw-canvas-server-');
  const artifactStore = new ArtifactStore({
    rootDir: path.join(dir, 'artifacts'),
    maxArtifacts: 10,
  });
  const launchStore = new LaunchStore({
    pendingTtlMs: 120_000,
    boundSessionTtlMs: 600_000,
  });
  const fileExport = new CanvasFileExport({
    rootDir: path.join(dir, 'exports'),
    maxBytes: 1024 * 1024,
  });
  const builtinApps = createCanvasBuiltinApps({
    getDashboardSnapshot: async () => ({
      cwd: '/workspace',
      version: '1.0.0',
      installMode: 'source',
      gitHash: 'abc1234',
      serviceName: 'discoclaw',
      serviceSummary: 'active',
      doctorSummary: '0 findings (errors=0, warnings=0, info=0)',
      roles: ['chat'],
      modelOptions: { chat: ['default', 'capable'] },
      modelRows: [{ role: 'chat', effectiveModel: 'capable', source: 'default' }],
      configPaths: {
        cwd: '/workspace',
        env: '/workspace/.env',
        dataDir: '/workspace/data',
        models: '/workspace/models.json',
        runtimeOverrides: '/workspace/runtime-overrides.json',
      },
      runtimeOverrides: {},
      mcpStatus: { status: 'missing' },
      mcpWarnings: 0,
      primaryRuntime: 'claude',
    }),
  });
  const server = await startCanvasServer({
    host: '127.0.0.1',
    port: 0,
    discordClientId: 'test-client',
    discordActivityClientSecret: input?.discordActivityClientSecret ?? 'test-secret',
    allowUserIds: new Set(['user-1']),
    artifactStore,
    launchStore,
    fileExport,
    builtinApps,
    writeBridgeEnabled: input?.writeBridgeEnabled ?? true,
    allowMockAuth: input?.allowMockAuth ?? true,
    fetchImpl: input?.fetchImpl,
  });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  serversToClose.push(server);

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    artifactStore,
    launchStore,
    fileExport,
  };
}

async function postJson(baseUrl: string, pathname: string, body: unknown, headers?: HeadersInit) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function getJson(baseUrl: string, pathname: string, headers?: HeadersInit) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

describe('Canvas server', () => {
  it('exchanges OAuth codes using mocked Discord responses', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'discord-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ id: 'user-1', username: 'Weston' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const harness = await startHarness({ allowMockAuth: false, fetchImpl });
    const { response, json } = await postJson(harness.baseUrl, '/api/token', { code: 'oauth-code' });

    expect(response.status).toBe(200);
    expect(json.access_token).toBe('discord-access-token');
    expect(typeof json.authToken).toBe('string');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves pending launches, supports bound-session replay, and serves inert artifact JSON', async () => {
    const harness = await startHarness();
    const artifact = await harness.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    harness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      artifact.id,
    );

    const tokenResult = await postJson(harness.baseUrl, '/api/token', { code: 'mock:user-1' });
    const authToken = String(tokenResult.json.authToken);

    const launch = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );
    expect(launch.response.status).toBe(200);
    expect(launch.json.target).toEqual({ type: 'artifact', id: artifact.id, title: 'Demo' });

    const boundSessionToken = String(launch.json.boundSessionToken);
    const replay = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(replay.response.status).toBe(200);
    expect(replay.json.source).toBe('bound-session');

    const artifactResponse = await getJson(
      harness.baseUrl,
      `/api/artifacts/${artifact.id}`,
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(artifactResponse.response.status).toBe(200);
    expect(artifactResponse.json.content).toContain('Hello');
  });

  it('serves built-in dashboard apps through the same launch/session flow', async () => {
    const harness = await startHarness();
    harness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      { type: 'app', appName: 'dashboard' },
    );

    const tokenResult = await postJson(harness.baseUrl, '/api/token', { code: 'mock:user-1' });
    const authToken = String(tokenResult.json.authToken);

    const launch = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );
    expect(launch.response.status).toBe(200);
    expect(launch.json.target).toEqual({ type: 'app', name: 'dashboard', title: 'Dashboard' });

    const boundSessionToken = String(launch.json.boundSessionToken);
    const appPage = await getJson(
      harness.baseUrl,
      '/api/apps/dashboard',
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(appPage.response.status).toBe(200);
    expect(appPage.json.content).toContain('Discoclaw Activity App');
    expect(appPage.json.refreshSeconds).toBeGreaterThan(0);

    const appData = await getJson(
      harness.baseUrl,
      '/api/apps/dashboard/data',
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(appData.response.status).toBe(200);
    expect(appData.json.app).toBe('dashboard');
    expect(appData.json.data.serviceName).toBe('discoclaw');
  });

  it('refreshes auth and bound sessions without consuming a new launch', async () => {
    const harness = await startHarness();
    const artifact = await harness.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    harness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      artifact.id,
    );

    const tokenResult = await postJson(harness.baseUrl, '/api/token', { code: 'mock:user-1' });
    const authToken = String(tokenResult.json.authToken);
    const launch = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );
    const firstBoundSessionToken = String(launch.json.boundSessionToken);

    const refreshed = await getJson(
      harness.baseUrl,
      '/api/session/refresh?channelId=channel-1&guildId=guild-1',
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': firstBoundSessionToken,
      },
    );
    expect(refreshed.response.status).toBe(200);
    expect(typeof refreshed.json.authToken).toBe('string');
    expect(typeof refreshed.json.boundSessionToken).toBe('string');
    expect(refreshed.json.target).toEqual({ type: 'artifact', artifactId: artifact.id });

    const artifactResponse = await getJson(
      harness.baseUrl,
      `/api/artifacts/${artifact.id}`,
      {
        Authorization: `Bearer ${String(refreshed.json.authToken)}`,
        'X-Canvas-Bound-Session': String(refreshed.json.boundSessionToken),
      },
    );
    expect(artifactResponse.response.status).toBe(200);
    expect(artifactResponse.json.content).toContain('Hello');
  });

  it('returns 404 when there is no pending launch for the current activity context', async () => {
    const harness = await startHarness();
    const tokenResult = await postJson(harness.baseUrl, '/api/token', { code: 'mock:user-1' });
    const authToken = String(tokenResult.json.authToken);

    const result = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );

    expect(result.response.status).toBe(404);
    expect(result.json.error).toContain('No pending canvas launch');
  });

  it('rejects invalid file-save requests with user-correctable 4xx responses', async () => {
    const harness = await startHarness();
    const artifact = await harness.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    harness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      artifact.id,
    );

    const tokenResult = await postJson(harness.baseUrl, '/api/token', { code: 'mock:user-1' });
    const authToken = String(tokenResult.json.authToken);
    const launch = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );
    const boundSessionToken = String(launch.json.boundSessionToken);

    const badMime = await postJson(
      harness.baseUrl,
      '/api/files/save',
      {
        suggestedName: 'data.zip',
        mimeType: 'application/zip',
        encoding: 'utf8',
        content: 'bad',
      },
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(badMime.response.status).toBe(400);

    const disabledHarness = await startHarness({ writeBridgeEnabled: false });
    const disabledArtifact = await disabledHarness.artifactStore.createArtifact({
      title: 'Disabled',
      content: '<!doctype html><html><body>Disabled</body></html>',
    });
    const disabledToken = await postJson(disabledHarness.baseUrl, '/api/token', { code: 'mock:user-1' });
    disabledHarness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      disabledArtifact.id,
    );
    const disabledLaunch = await getJson(
      disabledHarness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${String(disabledToken.json.authToken)}` },
    );
    const disabledSave = await postJson(
      disabledHarness.baseUrl,
      '/api/files/save',
      {
        suggestedName: 'report.md',
        mimeType: 'text/markdown',
        encoding: 'utf8',
        content: '# Report',
      },
      {
        Authorization: `Bearer ${String(disabledToken.json.authToken)}`,
        'X-Canvas-Bound-Session': String(disabledLaunch.json.boundSessionToken),
      },
    );
    expect(disabledSave.response.status).toBe(403);
  });

  it('authenticates via preauth (no OAuth secret) and resolves pending launch', async () => {
    const harness = await startHarness({ discordActivityClientSecret: '' });
    const artifact = await harness.artifactStore.createArtifact({
      title: 'Preauth Demo',
      content: '<!doctype html><html><body>Preauth</body></html>',
    });
    harness.launchStore.registerPending(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
      artifact.id,
    );

    // Preauth: POST /api/token with channelId/guildId instead of code
    const tokenResult = await postJson(harness.baseUrl, '/api/token', {
      channelId: 'channel-1',
      guildId: 'guild-1',
    });
    expect(tokenResult.response.status).toBe(200);
    expect(typeof tokenResult.json.authToken).toBe('string');
    expect(tokenResult.json.user).toEqual({ id: 'user-1' });

    const authToken = String(tokenResult.json.authToken);

    // The pending entry must still be available for /api/launches/current
    const launch = await getJson(
      harness.baseUrl,
      '/api/launches/current?channelId=channel-1&guildId=guild-1',
      { Authorization: `Bearer ${authToken}` },
    );
    expect(launch.response.status).toBe(200);
    expect(launch.json.target).toEqual({ type: 'artifact', id: artifact.id, title: 'Preauth Demo' });
    expect(launch.json.source).toBe('pending');

    // Verify the artifact itself is accessible
    const boundSessionToken = String(launch.json.boundSessionToken);
    const artifactResponse = await getJson(
      harness.baseUrl,
      `/api/artifacts/${artifact.id}`,
      {
        Authorization: `Bearer ${authToken}`,
        'X-Canvas-Bound-Session': boundSessionToken,
      },
    );
    expect(artifactResponse.response.status).toBe(200);
    expect(artifactResponse.json.content).toContain('Preauth');
  });

  it('rejects preauth when no pending launch matches the activity context', async () => {
    const harness = await startHarness({ discordActivityClientSecret: '' });

    const tokenResult = await postJson(harness.baseUrl, '/api/token', {
      channelId: 'no-such-channel',
      guildId: 'no-such-guild',
    });
    expect(tokenResult.response.status).toBe(403);
    expect(tokenResult.json.error).toContain('No authorized pending launch');
  });
});
