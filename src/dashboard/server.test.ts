import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import type { DoctorContext, DoctorReport, FixResult } from '../health/config-doctor.js';
import { startDashboardServer, type DashboardServer } from './server.js';

type RequestOptions = {
  method?: string;
  path?: string;
  body?: string;
  headers?: Record<string, string>;
};

type Response = {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
};

let handle: DashboardServer | null = null;

function makeDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    cwd: '/repo',
    installMode: 'source',
    env: {
      DISCOCLAW_SERVICE_NAME: 'discoclaw-beta',
      PRIMARY_RUNTIME: 'claude',
    },
    explicitEnvKeys: new Set<string>(),
    configPaths: {
      cwd: '/repo',
      env: '/repo/.env',
      dataDir: '/repo/data',
      models: '/repo/data/models.json',
      runtimeOverrides: '/repo/data/runtime-overrides.json',
    },
    defaultDataDir: '/repo/data',
    models: {
      chat: 'opus',
    },
    modelsFile: {
      exists: true,
      values: {
        chat: 'opus',
      },
    },
    runtimeOverrides: {
      fastRuntime: 'openrouter',
    },
    runtimeOverridesFile: {
      exists: true,
      unknownKeys: [],
      raw: {},
      values: {
        fastRuntime: 'openrouter',
      },
    },
    envDefaults: {
      chat: 'capable',
      fast: 'fast',
      summary: 'fast',
      cron: 'fast',
      'cron-exec': 'capable',
      voice: 'capable',
      'forge-drafter': 'capable',
      'forge-auditor': 'deep',
    },
    ...overrides,
  };
}

function makeDoctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    installMode: 'source',
    findings: [],
    configPaths: {
      cwd: '/repo',
      env: '/repo/.env',
      dataDir: '/repo/data',
      models: '/repo/data/models.json',
      runtimeOverrides: '/repo/data/runtime-overrides.json',
    },
    ...overrides,
  };
}

function makeFixResult(overrides: Partial<FixResult> = {}): FixResult {
  return {
    applied: [],
    skipped: [],
    errors: [],
    ...overrides,
  };
}

function mockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    inspect: vi.fn(async () => makeDoctorReport()),
    applyFixes: vi.fn(async () => makeFixResult()),
    loadDoctorContext: vi.fn(async () => makeDoctorContext()),
    saveModelConfig: vi.fn(async () => undefined),
    saveOverrides: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      stdout: '   Active: active (running) since today\n',
      stderr: '',
      exitCode: 0,
    })),
    getLocalVersion: vi.fn(() => '1.2.3'),
    isNpmManaged: vi.fn(async () => false),
    getGitHash: vi.fn(async () => 'abc1234'),
    platform: 'linux',
    homeDir: '/Users/david',
    getUid: () => 501,
    ...overrides,
  };
}

function makeRequest(port: number, opts: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const rawBody = opts.body ?? '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path ?? '/',
        method: opts.method ?? 'GET',
        headers: {
          ...(rawBody ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(rawBody).toString(),
          } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function startServer(deps: Partial<DashboardDeps> = {}): Promise<{ port: number; deps: DashboardDeps }> {
  const fullDeps = makeDeps(deps);
  handle = await startDashboardServer({
    port: 0,
    host: '127.0.0.1',
    cwd: '/repo',
    env: {},
    deps: fullDeps,
    log: mockLog(),
  });
  const address = handle.server.address() as { port: number };
  return { port: address.port, deps: fullDeps };
}

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe('startDashboardServer', () => {
  it('serves the dashboard shell on GET /', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, { path: '/' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Discoclaw Dashboard');
  });

  it('returns dashboard snapshot JSON from /api/snapshot', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, { path: '/api/snapshot' });
    const snapshot = parseJson<DashboardSnapshot>(response.text);

    expect(response.status).toBe(200);
    expect(snapshot).toMatchObject({
      cwd: '/repo',
      version: '1.2.3',
      installMode: 'source',
      gitHash: 'abc1234',
      serviceName: 'discoclaw-beta',
      serviceSummary: 'active (running) since today',
      doctorSummary: '0 findings (errors=0, warnings=0, info=0)',
      configPaths: {
        env: '/repo/.env',
        models: '/repo/data/models.json',
      },
      runtimeOverrides: {
        fastRuntime: 'openrouter',
      },
    });
    expect(Array.isArray(snapshot.modelRows)).toBe(true);
    expect(snapshot.modelRows).toContainEqual({
      role: 'chat',
      effectiveModel: 'opus',
      source: 'override',
      overrideValue: 'opus',
    });
  });

  it('rejects restart requests without confirm: true', async () => {
    const loadDoctorContextMock = vi.fn(async () => makeDoctorContext());
    const runCommandMock = vi.fn(async () => ({
      stdout: 'unexpected\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({
      loadDoctorContext: loadDoctorContextMock,
      runCommand: runCommandMock,
    });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({}),
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('confirm');
    expect(loadDoctorContextMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('returns doctor report JSON from /api/doctor', async () => {
    const report = makeDoctorReport({
      findings: [
        {
          id: 'missing-secret:OPENAI_API_KEY',
          severity: 'error',
          message: 'OPENAI_API_KEY is missing.',
          recommendation: 'Set OPENAI_API_KEY.',
          autoFixable: false,
        },
      ],
    });
    const { port } = await startServer({
      inspect: vi.fn(async () => report),
    });

    const response = await makeRequest(port, { path: '/api/doctor' });
    const body = parseJson<DoctorReport>(response.text);

    expect(response.status).toBe(200);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]?.id).toBe('missing-secret:OPENAI_API_KEY');
  });

  it('validates model role names on /api/model', async () => {
    const saveModelConfigMock = vi.fn(async () => undefined);
    const { port } = await startServer({
      saveModelConfig: saveModelConfigMock,
    });

    const response = await makeRequest(port, {
      path: '/api/model',
      method: 'POST',
      body: JSON.stringify({ role: 'not-a-role', model: 'opus' }),
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.message).toBe('Unknown model role: not-a-role');
    expect(saveModelConfigMock).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, { path: '/api/nope' });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, message: 'Not found' });
  });

  it('does not emit CORS headers', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, { path: '/api/snapshot' });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-headers']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });
});
