import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDeps } from '../cli/dashboard.js';
import type { DoctorContext, DoctorReport, FixResult } from '../health/config-doctor.js';

type RequestOptions = {
  method?: string;
  path?: string;
  body?: string;
  headers?: Record<string, string>;
};

type Response = {
  status: number;
  text: string;
};

type ShippedHandle = {
  server: http.Server;
  close(): Promise<void>;
};

let handle: ShippedHandle | null = null;

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
    runtimeOverrides: {},
    runtimeOverridesFile: {
      exists: true,
      unknownKeys: [],
      raw: {},
      values: {},
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

async function loadShippedEntrypoint(): Promise<{ startDashboardServer: (opts?: Record<string, unknown>) => Promise<ShippedHandle> }> {
  return import(new URL('../../dashboard/server.js', import.meta.url).href) as Promise<{
    startDashboardServer: (opts?: Record<string, unknown>) => Promise<ShippedHandle>;
  }>;
}

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe('dashboard/server.js shipped entrypoint', () => {
  it('loads the built dashboard server and enforces loopback Host validation before routing', async () => {
    const { startDashboardServer } = await loadShippedEntrypoint();
    const restartExecutor = vi.fn();
    handle = await startDashboardServer({
      port: 0,
      host: '127.0.0.1',
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      restartExecutor,
    });
    const port = (handle.server.address() as { port: number }).port;

    const blockedRead = await makeRequest(port, {
      path: '/api/snapshot',
      headers: {
        Host: `evil.example:${port}`,
      },
    });
    expect(blockedRead.status).toBe(403);
    expect(parseJson<{ ok: boolean; message: string }>(blockedRead.text)).toEqual({
      ok: false,
      message: 'Dashboard requests must use a loopback Host header.',
    });

    const blockedWrite = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
      },
    });
    expect(blockedWrite.status).toBe(403);
    expect(parseJson<{ ok: boolean; message: string }>(blockedWrite.text)).toEqual({
      ok: false,
      message: 'Dashboard requests must use a loopback Host header.',
    });

    const allowed = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    expect(allowed.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartExecutor).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'discoclaw-beta']);
  });
});
