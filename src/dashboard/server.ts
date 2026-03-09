import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LoggerLike } from '../logging/logger-like.js';
import { getLocalVersion, isNpmManaged } from '../npm-managed.js';
import { getGitHash } from '../version.js';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import {
  collectDashboardSnapshot,
  countDoctorSeverities,
  formatDoctorSummary,
  updateModelConfig,
} from '../cli/dashboard.js';
import { DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT } from './options.js';
import { renderDashboardPage } from './page.js';
import { buildSnapshotResponse, type DashboardSnapshotApiResponse } from './api/snapshot.js';
import type { DoctorReport, FixResult, InspectOptions } from '../health/config-doctor.js';
import { applyFixes, inspect, KNOWN_RUNTIMES, loadDoctorContext } from '../health/config-doctor.js';
import { DEFAULTS as MODEL_DEFAULTS, type ModelConfig, type ModelRole, saveModelConfig } from '../model-config.js';
import { isModelTier } from '../runtime/model-tiers.js';
import type { RuntimeOverrides } from '../runtime-overrides.js';
import { saveOverrides } from '../runtime-overrides.js';
import type { CommandResult, ServiceControlDeps } from '../service-control.js';
import {
  getServiceLogs,
  getServiceStatus,
  normalizeServiceName,
  restartService,
  summarizeServiceStatus,
} from '../service-control.js';

const DASHBOARD_MODEL_ROLES: readonly ModelRole[] = [
  'chat',
  'fast',
  'summary',
  'cron',
  'cron-exec',
  'voice',
  'forge-drafter',
  'forge-auditor',
];

const MAX_BODY_BYTES = 64 * 1024;
const CROSS_ORIGIN_MUTATION_ERROR = 'Cross-origin mutation requests are not allowed.';

type KnownRuntimesType = typeof KNOWN_RUNTIMES;

export type { DashboardSnapshotApiResponse } from './api/snapshot.js';

export type DashboardServerOptions = {
  port?: number;
  host?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: LoggerLike;
  deps?: Partial<DashboardDeps>;
};

export type DashboardServer = {
  server: http.Server;
  close(): Promise<void>;
};

type JsonRecord = Record<string, unknown>;

type ModelChangeInput = {
  role?: unknown;
  model?: unknown;
};

export type DashboardServiceApiResponse = {
  ok: true;
  serviceName: string;
  summary: string;
  result: CommandResult;
};

export type DashboardDoctorApiResponse = {
  ok: true;
  summary: string;
  counts: Record<'error' | 'warn' | 'info', number>;
  report: DoctorReport;
};

export type DashboardDoctorFixApiResponse = {
  ok: true;
  message: string;
  summary: string;
  counts: Record<'error' | 'warn' | 'info', number>;
  result: FixResult;
  report: DoctorReport;
  snapshot: DashboardSnapshot;
};

export type DashboardRestartApiResponse = {
  ok: true;
  message: string;
  serviceName: string;
  result: CommandResult;
  snapshot: DashboardSnapshot;
};

export type DashboardModelApiResponse = {
  ok: true;
  message: string;
  snapshot: DashboardSnapshot;
};

function createDefaultDeps(): DashboardDeps {
  return {
    inspect,
    applyFixes,
    loadDoctorContext,
    saveModelConfig,
    saveOverrides,
    runCommand(cmd: string, args: string[]) {
      return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: typeof err?.code === 'number' ? err.code : err ? null : 0,
          });
        });
      });
    },
    getLocalVersion,
    isNpmManaged,
    getGitHash,
    platform: process.platform,
    homeDir: os.homedir(),
    getUid: () => process.getuid?.() ?? 501,
  };
}

function buildInspectOptions(opts: DashboardServerOptions): Required<Pick<InspectOptions, 'cwd' | 'env'>> {
  return {
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    env: opts.env ?? process.env,
  };
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function respondHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function normalizeDashboardHost(host: string | undefined): string {
  const value = (host ?? DASHBOARD_HOST).trim().toLowerCase();
  if (!value || value === 'localhost' || value === DASHBOARD_HOST) return DASHBOARD_HOST;
  throw new Error(`Dashboard server must bind to ${DASHBOARD_HOST}; received ${host ?? value}.`);
}

function normalizeOriginHost(hostname: string): string {
  const value = hostname.trim().toLowerCase();
  if (value === 'localhost' || value === '::1') return DASHBOARD_HOST;
  return value;
}

function originPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function hasSafeDashboardOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.trim() === '') return true;

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;

  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`http://${hostHeader}`);
    return (
      normalizeOriginHost(originUrl.hostname) === normalizeOriginHost(hostUrl.hostname)
      && originPort(originUrl) === originPort(hostUrl)
    );
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonRecord> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed as JsonRecord;
}

function isModelRole(value: string): value is ModelRole {
  return (DASHBOARD_MODEL_ROLES as readonly string[]).includes(value);
}

function normalizeRuntimeName(value: string | undefined, knownRuntimes: KnownRuntimesType): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const normalized = trimmed === 'claude_code' ? 'claude' : trimmed;
  return knownRuntimes.has(normalized) ? normalized : undefined;
}

async function loadServiceName(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<string> {
  const ctx = await deps.loadDoctorContext(inspectOpts);
  return normalizeServiceName(ctx.env.DISCOCLAW_SERVICE_NAME);
}

async function buildServiceResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
  loader: (serviceName: string, serviceDeps: ServiceControlDeps) => Promise<CommandResult>,
): Promise<DashboardServiceApiResponse> {
  const serviceName = await loadServiceName(inspectOpts, deps);
  const result = await loader(serviceName, deps as ServiceControlDeps);
  return {
    ok: true,
    serviceName,
    summary: summarizeServiceStatus(result, deps.platform),
    result,
  };
}

async function buildDoctorResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<DashboardDoctorApiResponse> {
  const report = await deps.inspect(inspectOpts);
  return {
    ok: true,
    summary: formatDoctorSummary(report),
    counts: countDoctorSeverities(report),
    report,
  };
}

async function buildDoctorFixResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<DashboardDoctorFixApiResponse> {
  const report = await deps.inspect(inspectOpts);
  const result = await deps.applyFixes(report, inspectOpts);
  const nextReport = await deps.inspect(inspectOpts);

  return {
    ok: true,
    message: `Doctor fixes finished. Applied=${result.applied.length} Skipped=${result.skipped.length} Errors=${result.errors.length}.`,
    summary: formatDoctorSummary(nextReport),
    counts: countDoctorSeverities(nextReport),
    result,
    report: nextReport,
    snapshot: await collectDashboardSnapshot(inspectOpts, deps),
  };
}

async function buildRestartResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<DashboardRestartApiResponse> {
  const serviceName = await loadServiceName(inspectOpts, deps);
  const result = await restartService(serviceName, deps as ServiceControlDeps);
  return {
    ok: true,
    message: `Restart/start requested for ${serviceName}.`,
    serviceName,
    result,
    snapshot: await collectDashboardSnapshot(inspectOpts, deps),
  };
}

async function applyModelChange(
  input: ModelChangeInput,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
  knownRuntimes: KnownRuntimesType,
): Promise<{ message: string; snapshot: DashboardSnapshot }> {
  const rawRole = typeof input.role === 'string' ? input.role : '';
  const roleInput = rawRole.trim().toLowerCase();
  if (!roleInput) throw new Error('Model role is required.');
  if (!isModelRole(roleInput)) throw new Error(`Unknown model role: ${roleInput}`);

  const rawModel = typeof input.model === 'string' ? input.model : '';
  const modelInput = rawModel.trim();
  if (!modelInput) throw new Error('Model value is required.');
  if (/\s/.test(modelInput)) throw new Error('Model names cannot contain whitespace.');

  const ctx = await deps.loadDoctorContext(inspectOpts);
  const clearOverride = modelInput.toLowerCase() === 'default' || modelInput.toLowerCase() === 'reset';
  const runtimeInput = normalizeRuntimeName(modelInput, knownRuntimes);

  if (clearOverride) {
    const fallback = ctx.envDefaults[roleInput] ?? MODEL_DEFAULTS[roleInput];
    if (!fallback) throw new Error(`No default model is configured for ${roleInput}.`);
    const nextConfig = updateModelConfig(ctx.models, roleInput, fallback);
    await deps.saveModelConfig(ctx.configPaths.models, nextConfig);

    let clearedRuntimeOverride: 'fastRuntime' | 'voiceRuntime' | null = null;
    if (roleInput === 'fast' && ctx.runtimeOverrides.fastRuntime) {
      const nextOverrides: RuntimeOverrides = { ...ctx.runtimeOverrides };
      delete nextOverrides.fastRuntime;
      await deps.saveOverrides(ctx.configPaths.runtimeOverrides, nextOverrides);
      clearedRuntimeOverride = 'fastRuntime';
    } else if (roleInput === 'voice' && ctx.runtimeOverrides.voiceRuntime) {
      const nextOverrides: RuntimeOverrides = { ...ctx.runtimeOverrides };
      delete nextOverrides.voiceRuntime;
      await deps.saveOverrides(ctx.configPaths.runtimeOverrides, nextOverrides);
      clearedRuntimeOverride = 'voiceRuntime';
    }

    const clearedRuntimeMessage = clearedRuntimeOverride ? ` Cleared ${clearedRuntimeOverride} override.` : '';
    return {
      message: `Reset ${roleInput} to default: ${fallback}.${clearedRuntimeMessage} Changes take effect on next service restart.`,
      snapshot: await collectDashboardSnapshot(inspectOpts, deps),
    };
  }

  if (runtimeInput) {
    if (roleInput === 'chat') {
      throw new Error('Chat runtime swaps are live-only and do not belong in models.json. Use a concrete model here, or change PRIMARY_RUNTIME in .env and restart.');
    }
    if (roleInput === 'fast' || roleInput === 'voice') {
      throw new Error(`${roleInput} accepts only model tiers (fast, capable, deep) or "default".`);
    }
    throw new Error(`Runtime names cannot be stored as the persisted ${roleInput} model. Use a concrete model or "default".`);
  }

  const normalizedModelInput = (roleInput === 'fast' || roleInput === 'voice')
    ? modelInput.toLowerCase()
    : modelInput;

  if ((roleInput === 'fast' || roleInput === 'voice') && !isModelTier(normalizedModelInput)) {
    throw new Error(`${roleInput} accepts only model tiers (fast, capable, deep) or "default".`);
  }

  const nextConfig: ModelConfig = updateModelConfig(ctx.models, roleInput, normalizedModelInput);
  await deps.saveModelConfig(ctx.configPaths.models, nextConfig);

  return {
    message: `Saved ${roleInput} override: ${normalizedModelInput}. Changes take effect on next service restart.`,
    snapshot: await collectDashboardSnapshot(inspectOpts, deps),
  };
}

async function buildModelResponse(
  input: ModelChangeInput,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
  knownRuntimes: KnownRuntimesType,
): Promise<DashboardModelApiResponse> {
  return {
    ok: true,
    ...await applyModelChange(input, inspectOpts, deps, knownRuntimes),
  };
}

function isDashboardBadRequest(message: string): boolean {
  return (
    message === 'Request body too large'
    || message === 'JSON body must be an object'
    || message.startsWith('Unknown model role:')
    || message === 'Model role is required.'
    || message === 'Model value is required.'
    || message === 'Model names cannot contain whitespace.'
    || message.startsWith('Chat runtime swaps are live-only')
    || message.startsWith('Runtime names cannot be stored')
    || message.startsWith('No default model is configured')
    || message.includes('accepts only model tiers')
  );
}

export async function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServer> {
  const inspectOpts = buildInspectOptions(opts);
  const deps: DashboardDeps = { ...createDefaultDeps(), ...opts.deps };
  const host = normalizeDashboardHost(opts.host);
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const log = opts.log;
  const html = renderDashboardPage();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}`).pathname;

    try {
      if (method === 'GET' && pathname === '/') {
        respondHtml(res, 200, html);
        return;
      }

      if (method === 'GET' && pathname === '/api/snapshot') {
        respondJson(res, 200, await buildSnapshotResponse(inspectOpts, deps));
        return;
      }

      if (method === 'GET' && pathname === '/api/status') {
        respondJson(res, 200, await buildServiceResponse(inspectOpts, deps, getServiceStatus));
        return;
      }

      if (method === 'GET' && pathname === '/api/logs') {
        respondJson(res, 200, await buildServiceResponse(inspectOpts, deps, getServiceLogs));
        return;
      }

      if (pathname === '/api/restart') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          respondJson(res, 400, { ok: false, message: 'Restart requires {"confirm": true}.' });
          return;
        }
        respondJson(res, 200, await buildRestartResponse(inspectOpts, deps));
        return;
      }

      if (method === 'GET' && pathname === '/api/doctor') {
        respondJson(res, 200, await buildDoctorResponse(inspectOpts, deps));
        return;
      }

      if (pathname === '/api/doctor/fix') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        respondJson(res, 200, await buildDoctorFixResponse(inspectOpts, deps));
        return;
      }

      if (pathname === '/api/model') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        respondJson(res, 200, await buildModelResponse(body, inspectOpts, deps, KNOWN_RUNTIMES));
        return;
      }

      respondJson(res, 404, { ok: false, message: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = isDashboardBadRequest(message) ? 400 : 500;

      if (status === 500) {
        log?.error({ err, method, pathname }, 'dashboard:http request failed');
      } else {
        log?.warn({ err, method, pathname }, 'dashboard:http bad request');
      }
      respondJson(res, status, { ok: false, message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log?.info({ host, port: (server.address() as { port: number } | null)?.port ?? port, cwd: inspectOpts.cwd }, 'dashboard:server listening');

  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
