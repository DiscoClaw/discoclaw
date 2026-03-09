import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import type { DoctorContext, DoctorReport, FixResult } from '../health/config-doctor.js';
import {
  startDashboardServer,
  type DashboardDoctorApiResponse,
  type DashboardDoctorFixApiResponse,
  type DashboardModelApiResponse,
  type DashboardRestartApiResponse,
  type DashboardServer,
  type DashboardServiceApiResponse,
  type DashboardSnapshotApiResponse,
} from './server.js';

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

type StartServerOptions = {
  restartExecutor?: (cmd: string, args: string[]) => void;
  host?: string;
  trustedHosts?: Set<string>;
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

function makeRawRequest(port: number, rawRequest: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];

    socket.on('connect', () => {
      socket.write(rawRequest);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const separator = '\r\n\r\n';
      const separatorIndex = text.indexOf(separator);
      const head = separatorIndex >= 0 ? text.slice(0, separatorIndex) : text;
      const body = separatorIndex >= 0 ? text.slice(separatorIndex + separator.length) : '';
      const lines = head.split('\r\n');
      const statusMatch = lines[0]?.match(/^HTTP\/1\.[01] (\d{3})/);

      if (!statusMatch) {
        reject(new Error(`Could not parse raw HTTP response: ${lines[0] ?? '<empty>'}`));
        return;
      }

      const headers: http.IncomingHttpHeaders = {};
      for (const line of lines.slice(1)) {
        const separatorOffset = line.indexOf(':');
        if (separatorOffset <= 0) continue;
        headers[line.slice(0, separatorOffset).toLowerCase()] = line.slice(separatorOffset + 1).trim();
      }

      resolve({
        status: Number(statusMatch[1]),
        text: body,
        headers,
      });
    });
    socket.on('error', reject);
  });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function startServer(
  deps: Partial<DashboardDeps> = {},
  options: StartServerOptions = {},
): Promise<{ port: number; deps: DashboardDeps }> {
  const fullDeps = makeDeps(deps);
  handle = await startDashboardServer({
    port: 0,
    host: options.host ?? '127.0.0.1',
    trustedHosts: options.trustedHosts,
    cwd: '/repo',
    env: {},
    deps: fullDeps,
    restartExecutor: options.restartExecutor,
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
    const body = parseJson<DashboardSnapshotApiResponse>(response.text);
    const snapshot: DashboardSnapshot = body.snapshot;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
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

  it('rejects read requests with a non-loopback Host header', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, {
      path: '/api/snapshot',
      headers: {
        Host: `evil.example:${port}`,
      },
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(403);
    expect(body).toEqual({
      ok: false,
      message: 'Dashboard requests must use a loopback Host header.',
    });
  });

  it('fails closed when the Host header is missing', async () => {
    const { port } = await startServer();
    const response = await makeRawRequest(
      port,
      'GET /api/snapshot HTTP/1.0\r\nConnection: close\r\n\r\n',
    );
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(403);
    expect(body).toEqual({
      ok: false,
      message: 'Dashboard requests must use a loopback Host header.',
    });
  });

  it('allows loopback reads with an IPv6 Host header', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, {
      path: '/api/snapshot',
      headers: {
        Host: `[::1]:${port}`,
      },
    });
    const body = parseJson<DashboardSnapshotApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('allows loopback reads with a localhost Host alias', async () => {
    const { port } = await startServer();
    const response = await makeRequest(port, {
      path: '/api/snapshot',
      headers: {
        Host: `localhost.:${port}`,
      },
    });
    const body = parseJson<DashboardSnapshotApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('allows trusted host reads when configured', async () => {
    const { port } = await startServer({}, {
      host: '0.0.0.0',
      trustedHosts: new Set(['phone.tailnet.ts.net']),
    });
    const response = await makeRequest(port, {
      path: '/api/snapshot',
      headers: {
        Host: `PHONE.TAILNET.TS.NET.:${port}`,
      },
    });
    const body = parseJson<DashboardSnapshotApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('returns service status JSON from /api/status', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: '   Active: active (running) since today\n   Docs: https://discoclaw.ai\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand });
    const body = parseJson<DashboardServiceApiResponse>((await makeRequest(port, { path: '/api/status' })).text);

    expect(body).toEqual({
      ok: true,
      serviceName: 'discoclaw-beta',
      summary: 'active (running) since today',
      result: {
        stdout: '   Active: active (running) since today\n   Docs: https://discoclaw.ai\n',
        stderr: '',
        exitCode: 0,
      },
    });
    expect(runCommand).toHaveBeenCalledWith('systemctl', ['--user', 'status', 'discoclaw-beta']);
  });

  it('returns service logs JSON from /api/logs', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: 'Mar 08 12:00:00 host discoclaw[123]: startup complete\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand });
    const response = await makeRequest(port, { path: '/api/logs' });
    const body = parseJson<DashboardServiceApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      serviceName: 'discoclaw-beta',
      summary: 'Mar 08 12:00:00 host discoclaw[123]: startup complete',
      result: {
        stdout: 'Mar 08 12:00:00 host discoclaw[123]: startup complete\n',
        stderr: '',
        exitCode: 0,
      },
    });
    expect(runCommand).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'discoclaw-beta', '--no-pager', '-n', '30']);
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

  it('rejects cross-origin mutation requests', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: 'unexpected\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Origin: 'http://evil.example',
      },
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(403);
    expect(body).toEqual({
      ok: false,
      message: 'Cross-origin mutation requests are not allowed.',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects rebinding-style mutation requests even when Origin matches Host', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: 'unexpected\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
      },
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(403);
    expect(body).toEqual({
      ok: false,
      message: 'Dashboard requests must use a loopback Host header.',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('queues a deferred restart and returns a 202 from /api/restart', async () => {
    const restartExecutor = vi.fn();
    const runCommand = vi.fn(async () => {
      return {
        stdout: '   Active: active (running) since today\n',
        stderr: '',
        exitCode: 0,
      };
    });
    const { port } = await startServer({ runCommand }, { restartExecutor });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    const body = parseJson<DashboardRestartApiResponse>(response.text);

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Restarting discoclaw-beta. This dashboard may disconnect; reload in a few seconds.');
    expect(body.serviceName).toBe('discoclaw-beta');
    expect(body.expectedDisconnect).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('systemctl', ['--user', 'status', 'discoclaw-beta']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartExecutor).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'discoclaw-beta']);
  });

  it('accepts mutation requests when Host and Origin use localhost', async () => {
    const restartExecutor = vi.fn();
    const runCommand = vi.fn(async () => ({
      stdout: '   Active: active (running) since today\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand }, { restartExecutor });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Host: `localhost:${port}`,
        Origin: `http://localhost:${port}`,
      },
    });
    const body = parseJson<DashboardRestartApiResponse>(response.text);

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartExecutor).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'discoclaw-beta']);
  });

  it('accepts mutation requests when Host and Origin use a localhost alias', async () => {
    const restartExecutor = vi.fn();
    const runCommand = vi.fn(async () => ({
      stdout: '   Active: active (running) since today\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand }, { restartExecutor });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Host: `localhost.:${port}`,
        Origin: `http://localhost.:${port}`,
      },
    });
    const body = parseJson<DashboardRestartApiResponse>(response.text);

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartExecutor).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'discoclaw-beta']);
  });

  it('accepts mutation requests when Host and Origin use a trusted host', async () => {
    const restartExecutor = vi.fn();
    const runCommand = vi.fn(async () => ({
      stdout: '   Active: active (running) since today\n',
      stderr: '',
      exitCode: 0,
    }));
    const { port } = await startServer({ runCommand }, {
      host: '0.0.0.0',
      trustedHosts: new Set(['phone.tailnet.ts.net']),
      restartExecutor,
    });

    const response = await makeRequest(port, {
      path: '/api/restart',
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: {
        Host: `phone.tailnet.ts.net:${port}`,
        Origin: `http://PHONE.TAILNET.TS.NET.:${port}`,
      },
    });
    const body = parseJson<DashboardRestartApiResponse>(response.text);

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartExecutor).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'discoclaw-beta']);
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
    const body = parseJson<DashboardDoctorApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('1 findings (errors=1, warnings=0, info=0)');
    expect(body.counts).toEqual({ error: 1, warn: 0, info: 0 });
    expect(Array.isArray(body.report.findings)).toBe(true);
    expect(body.report.findings).toHaveLength(1);
    expect(body.report.findings[0]?.id).toBe('missing-secret:OPENAI_API_KEY');
  });

  it('applies doctor fixes and returns refreshed dashboard state from /api/doctor/fix', async () => {
    const initialReport = makeDoctorReport({
      findings: [
        {
          id: 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
          severity: 'warn',
          message: 'Legacy env var is present.',
          recommendation: 'Rename it.',
          autoFixable: true,
        },
      ],
    });
    const refreshedReport = makeDoctorReport();
    let inspectCalls = 0;
    const inspect = vi.fn(async () => {
      inspectCalls += 1;
      return inspectCalls === 1 ? initialReport : refreshedReport;
    });
    const applyFixes = vi.fn(async () => makeFixResult({
      applied: ['deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL'],
    }));
    const { port } = await startServer({ inspect, applyFixes });

    const response = await makeRequest(port, {
      path: '/api/doctor/fix',
      method: 'POST',
      body: JSON.stringify({}),
    });
    const body = parseJson<DashboardDoctorFixApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Doctor fixes finished. Applied=1 Skipped=0 Errors=0.');
    expect(body.summary).toBe('0 findings (errors=0, warnings=0, info=0)');
    expect(body.counts).toEqual({ error: 0, warn: 0, info: 0 });
    expect(body.result).toEqual({
      applied: ['deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL'],
      skipped: [],
      errors: [],
    });
    expect(body.report.findings).toEqual([]);
    expect(body.snapshot.doctorSummary).toBe('0 findings (errors=0, warnings=0, info=0)');
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(applyFixes).toHaveBeenCalledWith(initialReport, { cwd: '/repo', env: {} });
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

  it('saves model changes and returns the updated snapshot from /api/model', async () => {
    const ctx = makeDoctorContext();
    const loadDoctorContext = vi.fn(async () => ctx);
    const saveModelConfig = vi.fn(async (_filePath: string, config: DoctorContext['models']) => {
      ctx.models = { ...config };
    });
    const { port } = await startServer({
      loadDoctorContext,
      saveModelConfig,
    });

    const response = await makeRequest(port, {
      path: '/api/model',
      method: 'POST',
      body: JSON.stringify({ role: 'chat', model: 'sonnet-max' }),
    });
    const body = parseJson<DashboardModelApiResponse>(response.text);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Saved chat override: sonnet-max. Changes take effect on next service restart.');
    expect(body.snapshot.modelRows).toContainEqual({
      role: 'chat',
      effectiveModel: 'sonnet-max',
      source: 'override',
      overrideValue: 'sonnet-max',
    });
    expect(saveModelConfig).toHaveBeenCalledWith('/repo/data/models.json', {
      chat: 'sonnet-max',
    });
    expect(loadDoctorContext).toHaveBeenCalled();
  });

  it('rejects GET requests on /api/model', async () => {
    const { port } = await startServer();

    const response = await makeRequest(port, {
      path: '/api/model',
      method: 'GET',
    });
    const body = parseJson<{ ok: boolean; message: string }>(response.text);

    expect(response.status).toBe(405);
    expect(body).toEqual({ ok: false, message: 'Method Not Allowed' });
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

  it('rejects non-loopback host bindings', async () => {
    await expect(startDashboardServer({
      port: 0,
      host: '0.0.0.0',
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      log: mockLog(),
    })).rejects.toThrow('Dashboard server must bind to 127.0.0.1; received 0.0.0.0.');
  });

  it('allows 0.0.0.0 host bindings when trusted hosts are configured', async () => {
    handle = await startDashboardServer({
      port: 0,
      host: '0.0.0.0',
      trustedHosts: new Set(['phone.tailnet.ts.net']),
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      log: mockLog(),
    });

    expect(handle.server.address()).toBeTruthy();
  });

  it('maps listen EADDRINUSE errors to an actionable dashboard port message', async () => {
    handle = await startDashboardServer({
      port: 0,
      host: '127.0.0.1',
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      log: mockLog(),
    });
    const port = (handle.server.address() as { port: number }).port;

    await expect(startDashboardServer({
      port,
      host: '127.0.0.1',
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      log: mockLog(),
    })).rejects.toThrow(
      `Dashboard port ${port} is already in use. Another DiscoClaw instance or process may be using it. Set DISCOCLAW_DASHBOARD_PORT to a different value in .env.`,
    );
  });

  it('logs the formatted dashboard URL when the server starts listening', async () => {
    const log = mockLog();

    handle = await startDashboardServer({
      port: 0,
      host: '127.0.0.1',
      cwd: '/repo',
      env: {},
      deps: makeDeps(),
      log,
    });
    const port = (handle.server.address() as { port: number }).port;

    expect(log.info).toHaveBeenCalledWith(
      {
        host: '127.0.0.1',
        port,
        cwd: '/repo',
        url: `http://127.0.0.1:${port}/`,
      },
      'dashboard:server listening',
    );
  });
});
