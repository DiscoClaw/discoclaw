import { execFile } from 'node:child_process';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BootReportMcpStatus } from '../discord/status-channel.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { getLocalVersion, isNpmManaged } from '../npm-managed.js';
import { getGitHash } from '../version.js';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import {
  buildModelOptions,
  collectDashboardSnapshot,
  countDoctorSeverities,
  formatDoctorSummary,
  updateModelConfig,
} from '../cli/dashboard.js';
import { DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT, formatDashboardUrl } from './options.js';
import { renderDashboardPage } from './page.js';
import { buildSnapshotResponse, type DashboardSnapshotApiResponse } from './api/snapshot.js';
import {
  buildSettingsGetResponse,
  buildSettingsPostResponse,
  type DashboardSettingsGetResponse,
  type DashboardSettingsPostResponse,
} from './api/settings.js';
import { buildMetricsResponse, type DashboardMetricsApiResponse } from './api/metrics.js';
import { buildTracesResponse, type DashboardTracesApiResponse } from './api/traces.js';
import type { LiveRuntimeSnapshot, LiveSnapshotProvider } from './snapshot.js';
import type { AuthProbeReport } from './auth-probe.js';
import { hasErrorCode, mapListenError } from './server-errors.js';
import type { DoctorReport, FixResult, InspectOptions } from '../health/config-doctor.js';
import { applyFixes, inspect, KNOWN_RUNTIMES, loadDoctorContext, updateEnvKey } from '../health/config-doctor.js';
import { DEFAULTS as MODEL_DEFAULTS, type ModelConfig, type ModelRole, saveModelConfig } from '../model-config.js';
import { isModelTier } from '../runtime/model-tiers.js';
import type { RuntimeOverrides } from '../runtime-overrides.js';
import { saveOverrides } from '../runtime-overrides.js';
import { findRuntimeForModel } from '../runtime/model-tiers.js';
import { getRuntimePathDefinition } from '../runtime/runtime-path-contract.js';
import type { CommandResult, ServiceControlDeps } from '../service-control.js';
import {
  getPlatformCommands,
  getServiceLogs,
  getServiceStatus,
  normalizeServiceName,
  summarizeServiceStatus,
} from '../service-control.js';

const DASHBOARD_MODEL_ROLES: readonly ModelRole[] = [
  'chat',
  'plan-run',
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
const DNS_REBIND_ERROR = 'Dashboard requests must use a loopback Host header.';

type KnownRuntimesType = typeof KNOWN_RUNTIMES;

export type { DashboardSnapshotApiResponse } from './api/snapshot.js';
export type { DashboardSettingsGetResponse, DashboardSettingsPostResponse } from './api/settings.js';

/**
 * Result of a live model change applied to the running bot's in-memory state.
 */
export type LiveModelResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

/**
 * Callback that applies a live (in-memory) model change to the running bot.
 * The role and model mirror the executeConfigAction modelSet interface.
 */
export type LiveModelHandler = (role: string, model: string) => LiveModelResult;

/**
 * Callback that runs API key auth probes against the running bot's credentials.
 * The target selects which provider group to check ('imagegen' or 'chat').
 */
export type LiveAuthCheckHandler = (target: string) => Promise<AuthProbeReport>;

export type DashboardServerOptions = {
  port?: number;
  host?: string;
  trustedHosts?: Set<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupMcpStatus?: BootReportMcpStatus;
  startupMcpWarnings?: number;
  log?: LoggerLike;
  deps?: Partial<DashboardDeps>;
  restartExecutor?: (cmd: string, args: string[]) => void;
  liveSnapshotProvider?: LiveSnapshotProvider;
  liveModelHandler?: LiveModelHandler;
  liveAuthCheckHandler?: LiveAuthCheckHandler;
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
  expectedDisconnect: boolean;
};

export type DashboardModelApiResponse = {
  ok: true;
  message: string;
  snapshot: DashboardSnapshot;
};

export type DashboardPresetApiResponse = {
  ok: true;
  message: string;
  snapshot: DashboardSnapshot;
};

export type DashboardLiveModelApiResponse = {
  ok: true;
  message: string;
  snapshot: DashboardSnapshot;
};

export type DashboardSecretApiResponse = {
  ok: true;
  message: string;
  snapshot: DashboardSnapshot;
};

export type DashboardAuthCheckApiResponse = {
  ok: true;
  status: 'ok' | 'warn' | 'error';
  message: string;
  results: AuthProbeReport['results'];
};

export type { DashboardTracesApiResponse } from './api/traces.js';
export type { DashboardMetricsApiResponse } from './api/metrics.js';

function createDefaultDeps(): DashboardDeps {
  return {
    inspect,
    applyFixes,
    loadDoctorContext,
    saveModelConfig,
    saveOverrides,
    updateEnvKey,
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

function normalizeDashboardHost(host: string | undefined, trustedHosts?: ReadonlySet<string>): string {
  const value = (host ?? DASHBOARD_HOST).trim().toLowerCase();
  if (!value || value === 'localhost' || value === DASHBOARD_HOST) return DASHBOARD_HOST;
  if (value === '0.0.0.0' && trustedHosts && trustedHosts.size > 0) return value;
  throw new Error(`Dashboard server must bind to ${DASHBOARD_HOST}; received ${host ?? value}.`);
}

function normalizeHostname(hostname: string): string {
  let value = hostname.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\.+$/, '');
  return value;
}

function normalizeOriginHost(hostname: string): string {
  const value = normalizeHostname(hostname);
  if (value === 'localhost' || value === '::1') return DASHBOARD_HOST;
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const value = normalizeHostname(hostname);
  if (value === 'localhost' || value === '::1') return true;
  if (isIP(value) !== 4) return value === DASHBOARD_HOST;
  return value.split('.').every((segment) => segment !== '') && value.startsWith('127.');
}

function isAllowedHostname(hostname: string, trustedHosts?: ReadonlySet<string>): boolean {
  const value = normalizeHostname(hostname);
  return isLoopbackHostname(value) || trustedHosts?.has(value) === true;
}

function parseHostHeaderHostname(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return null;

  try {
    return new URL(`http://${hostHeader.trim()}`).hostname;
  } catch {
    return null;
  }
}

function originPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function hasSafeDashboardOrigin(req: http.IncomingMessage, trustedHosts?: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.trim() === '') return true;

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;

  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`http://${hostHeader.trim()}`);
    if (!isAllowedHostname(hostUrl.hostname, trustedHosts)) return false;
    if (!isAllowedHostname(originUrl.hostname, trustedHosts)) return false;
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

function presetToPrimaryRuntime(preset: string): 'claude-cli' | 'codex-cli' {
  return preset === 'codex' ? 'codex-cli' : 'claude-cli';
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

function withStartupMcpSnapshot<T extends { snapshot: DashboardSnapshot }>(
  response: T,
  startupMcpStatus?: BootReportMcpStatus,
  startupMcpWarnings?: number,
): T {
  if (startupMcpStatus === undefined && startupMcpWarnings === undefined) {
    return response;
  }

  return {
    ...response,
    snapshot: {
      ...response.snapshot,
      ...(startupMcpStatus !== undefined ? { mcpStatus: startupMcpStatus } : {}),
      ...(startupMcpWarnings !== undefined ? { mcpWarnings: startupMcpWarnings } : {}),
    },
  };
}

function withLiveSnapshot<T extends { snapshot: DashboardSnapshot }>(
  response: T,
  liveSnapshotProvider?: LiveSnapshotProvider,
  pendingRestartOverride?: boolean,
): T {
  if (!liveSnapshotProvider) return response;
  const live = liveSnapshotProvider();
  if (!live) return response;

  return {
    ...response,
    snapshot: {
      ...response.snapshot,
      live: pendingRestartOverride !== undefined
        ? { ...live, pendingRestart: live.pendingRestart || pendingRestartOverride }
        : live,
    },
  };
}

type DeferredRestart = {
  response: DashboardRestartApiResponse;
  deferred: () => void;
};

async function buildRestartResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
  restartExecutor: (cmd: string, args: string[]) => void,
): Promise<DeferredRestart> {
  const serviceName = await loadServiceName(inspectOpts, deps);
  const commands = getPlatformCommands(serviceName, deps.platform, deps.homeDir, deps.getUid());
  if (!commands) {
    throw new Error(`Service actions are not supported on ${deps.platform}.`);
  }
  const before = await deps.runCommand(commands.checkActiveCmd[0], commands.checkActiveCmd[1]);
  const wasActive = commands.isActive(before);
  const [cmd, args] = commands.restartCmd(wasActive);

  return {
    response: {
      ok: true,
      message: wasActive
        ? `Restarting ${serviceName}. This dashboard may disconnect; reload in a few seconds.`
        : `Starting ${serviceName}. Reload in a few seconds if the service was down.`,
      serviceName,
      expectedDisconnect: wasActive,
    },
    deferred: () => {
      restartExecutor(cmd, args);
    },
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
    const nextConfig = updateModelConfig(ctx.models, roleInput, null);
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

  const allowedModels = buildModelOptions(ctx)[roleInput] ?? [];
  if (!allowedModels.includes(normalizedModelInput)) {
    throw new Error(`Model value must be one of the known saved options for ${roleInput}.`);
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

const ALLOWED_SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'IMAGEGEN_GEMINI_API_KEY',
]);

const ALLOWED_PRESETS = new Set(['claude', 'codex']);

async function applyPreset(
  preset: string,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<{ message: string; snapshot: DashboardSnapshot; primaryRuntime: 'claude-cli' | 'codex-cli' }> {
  if (!ALLOWED_PRESETS.has(preset)) {
    throw new Error(`Unknown preset: ${preset}. Allowed values: ${[...ALLOWED_PRESETS].join(', ')}`);
  }

  const ctx = await deps.loadDoctorContext(inspectOpts);
  const primaryRuntime = presetToPrimaryRuntime(preset);
  await deps.updateEnvKey(ctx.configPaths.env, 'PRIMARY_RUNTIME', primaryRuntime);

  await deps.saveOverrides(ctx.configPaths.runtimeOverrides, {});
  await deps.saveModelConfig(ctx.configPaths.models, { ...MODEL_DEFAULTS });

  return {
    message: `Preset switched to ${preset}. Models reset to tier defaults. Restart the service to apply.`,
    snapshot: await collectDashboardSnapshot(
      { cwd: inspectOpts.cwd, env: { ...inspectOpts.env, PRIMARY_RUNTIME: primaryRuntime } },
      deps,
    ),
    primaryRuntime,
  };
}

async function buildPresetResponse(
  input: JsonRecord,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<DashboardPresetApiResponse> {
  const preset = typeof input.preset === 'string' ? input.preset.trim().toLowerCase() : '';
  if (!preset) throw new Error('Preset is required.');

  return {
    ok: true,
    ...await applyPreset(preset, inspectOpts, deps),
  };
}

async function persistChatRuntimeSelection(
  runtimeName: string,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<{ message: string; snapshot: DashboardSnapshot; primaryRuntime: string }> {
  const ctx = await deps.loadDoctorContext(inspectOpts);
  await deps.updateEnvKey(ctx.configPaths.env, 'PRIMARY_RUNTIME', runtimeName);

  let nextModels = ctx.models;
  let clearedCrossRuntimeOverride = false;
  const targetRuntimeId = getRuntimePathDefinition(runtimeName)?.runtimeId;
  const savedChatModel = ctx.models['chat'];
  const savedChatModelRuntimeId = savedChatModel ? findRuntimeForModel(savedChatModel) : undefined;
  if (savedChatModel && targetRuntimeId && savedChatModelRuntimeId && savedChatModelRuntimeId !== targetRuntimeId) {
    nextModels = updateModelConfig(nextModels, 'chat', null);
    await deps.saveModelConfig(ctx.configPaths.models, nextModels);
    clearedCrossRuntimeOverride = true;
  }

  return {
    message: clearedCrossRuntimeOverride
      ? `Saved startup chat runtime: ${runtimeName}. Cleared the saved chat model override because it targeted a different provider. Restart the service to apply.`
      : `Saved startup chat runtime: ${runtimeName}. Restart the service to apply.`,
    snapshot: await collectDashboardSnapshot(
      { cwd: inspectOpts.cwd, env: { ...inspectOpts.env, PRIMARY_RUNTIME: runtimeName } },
      deps,
    ),
    primaryRuntime: runtimeName,
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
    || message.startsWith('Model value must be one of the known saved options')
    || message.startsWith('Unknown preset:')
    || message === 'Preset is required.'
    || message === 'Auth check target is required.'
    || message === 'Secret key is required.'
    || message === 'Secret value is required.'
    || message.startsWith('Unknown secret key:')
    || message === 'Setting key is required.'
    || message === 'Setting value is required.'
    || message.startsWith('Unknown setting key:')
    || message.startsWith('Setting value must be')
  );
}

export async function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServer> {
  const inspectOpts = buildInspectOptions(opts);
  const deps: DashboardDeps = { ...createDefaultDeps(), ...opts.deps };
  const trustedHosts = opts.trustedHosts;
  const host = normalizeDashboardHost(opts.host, trustedHosts);
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const log = opts.log;
  const html = renderDashboardPage();
  const restartExecutor = opts.restartExecutor ?? ((cmd: string, args: string[]) => {
    execFile(cmd, args, (err) => {
      if (err) {
        log?.error({ err, cmd, args }, 'dashboard:restart failed');
      }
    });
  });
  const liveModelHandler = opts.liveModelHandler;
  const liveAuthCheckHandler = opts.liveAuthCheckHandler;

  // Mutable flag — set when a persisted config change requires a restart to take effect.
  let pendingRestart = false;
  const previewEnvOverrides: Record<string, string> = {};
  const configInspectOpts = (): Required<Pick<InspectOptions, 'cwd' | 'env'>> => ({
    cwd: inspectOpts.cwd,
    env: { ...inspectOpts.env, ...previewEnvOverrides },
  });

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const requestHostname = parseHostHeaderHostname(req.headers.host);
    if (!requestHostname || !isAllowedHostname(requestHostname, trustedHosts)) {
      respondJson(res, 403, { ok: false, message: DNS_REBIND_ERROR });
      return;
    }
    const parsedUrl = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}`);
    const pathname = parsedUrl.pathname;

    try {
      if (method === 'GET' && pathname === '/') {
        respondHtml(res, 200, html);
        return;
      }

      if (method === 'GET' && pathname === '/api/snapshot') {
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              await buildSnapshotResponse(configInspectOpts(), deps),
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ),
        );
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
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          respondJson(res, 400, { ok: false, message: 'Restart requires {"confirm": true}.' });
          return;
        }
        const restart = await buildRestartResponse(inspectOpts, deps, restartExecutor);
        pendingRestart = false;
        res.once('finish', () => {
          setTimeout(restart.deferred, 25);
        });
        respondJson(res, 202, restart.response);
        return;
      }

      if (method === 'GET' && pathname === '/api/doctor') {
        respondJson(res, 200, await buildDoctorResponse(configInspectOpts(), deps));
        return;
      }

      if (pathname === '/api/doctor/fix') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              await buildDoctorFixResponse(configInspectOpts(), deps),
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ),
        );
        return;
      }

      if (pathname === '/api/live-model') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        if (!liveModelHandler) {
          respondJson(res, 501, { ok: false, message: 'Live model changes are not available (bot not fully initialized).' });
          return;
        }
        const body = await readJsonBody(req);
        const role = typeof body.role === 'string' ? body.role.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const persist = body.persist === true;
        if (!role) throw new Error('Model role is required.');
        if (!model) throw new Error('Model value is required.');

        const result = liveModelHandler(role, model);
        if (!result.ok) {
          respondJson(res, 400, { ok: false, message: result.error });
          return;
        }
        let message = result.summary;
        let snapshot = await collectDashboardSnapshot(configInspectOpts(), deps);
        if (persist && role === 'chat') {
          const runtimeInput = normalizeRuntimeName(model, KNOWN_RUNTIMES);
          if (runtimeInput) {
            const persisted = await persistChatRuntimeSelection(runtimeInput, configInspectOpts(), deps);
            previewEnvOverrides['PRIMARY_RUNTIME'] = persisted.primaryRuntime;
            message = `${message} ${persisted.message}`;
            snapshot = persisted.snapshot;
          } else {
            const persisted = await applyModelChange({ role, model }, configInspectOpts(), deps, KNOWN_RUNTIMES);
            message = `${message} ${persisted.message}`;
            snapshot = persisted.snapshot;
          }
          pendingRestart = true;
        }
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              { ok: true as const, message, snapshot },
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ),
        );
        return;
      }

      if (pathname === '/api/model') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        const modelResponse = await buildModelResponse(body, configInspectOpts(), deps, KNOWN_RUNTIMES);
        pendingRestart = true;
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              modelResponse,
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ),
        );
        return;
      }

      if (pathname === '/api/preset') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        const presetResponse = await buildPresetResponse(body, configInspectOpts(), deps);
        const preset = typeof body.preset === 'string' ? body.preset.trim().toLowerCase() : '';
        if (preset) {
          previewEnvOverrides['PRIMARY_RUNTIME'] = presetToPrimaryRuntime(preset);
        }
        pendingRestart = true;
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              presetResponse,
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ),
        );
        return;
      }

      if (pathname === '/api/secret') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        const value = typeof body.value === 'string' ? body.value : '';
        if (!key) throw new Error('Secret key is required.');
        if (!ALLOWED_SECRET_KEYS.has(key)) throw new Error(`Unknown secret key: ${key}`);
        if (!value) throw new Error('Secret value is required.');

        const ctx = await deps.loadDoctorContext(configInspectOpts());
        await deps.updateEnvKey(ctx.configPaths.env, key, value);
        previewEnvOverrides[key] = value;
        pendingRestart = true;
        const snapshot = await collectDashboardSnapshot(configInspectOpts(), deps);
        respondJson(
          res,
          200,
          withLiveSnapshot(
            withStartupMcpSnapshot(
              { ok: true as const, message: `Updated ${key}. Restart the service to apply.`, snapshot },
              opts.startupMcpStatus,
              opts.startupMcpWarnings,
            ),
            opts.liveSnapshotProvider,
            pendingRestart,
          ) satisfies DashboardSecretApiResponse,
        );
        return;
      }

      if (pathname === '/api/auth-check') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        if (!liveAuthCheckHandler) {
          respondJson(res, 501, { ok: false, message: 'Auth checks are not available (bot not fully initialized).' });
          return;
        }
        const body = await readJsonBody(req);
        const target = typeof body.target === 'string' ? body.target.trim() : '';
        if (!target) throw new Error('Auth check target is required.');
        const report = await liveAuthCheckHandler(target);
        const failed = report.results.filter((r) => r.status === 'fail');
        const skipped = report.results.filter((r) => r.status === 'skip');
        let status: 'ok' | 'warn' | 'error';
        let message: string;
        if (report.allOk && skipped.length === report.results.length) {
          status = 'warn';
          message = 'No API keys configured for this target.';
        } else if (report.allOk) {
          status = 'ok';
          message = 'All configured keys are valid.';
        } else {
          status = 'error';
          message = failed.map((r) => `${r.provider}: ${r.message ?? 'failed'}`).join('; ');
        }
        respondJson(res, 200, { ok: true, status, message, results: report.results } satisfies DashboardAuthCheckApiResponse);
        return;
      }

      if (method === 'GET' && pathname === '/api/settings') {
        respondJson(res, 200, buildSettingsGetResponse(configInspectOpts().env));
        return;
      }

      if (pathname === '/api/settings') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        if (!hasSafeDashboardOrigin(req, trustedHosts)) {
          respondJson(res, 403, { ok: false, message: CROSS_ORIGIN_MUTATION_ERROR });
          return;
        }
        const body = await readJsonBody(req);
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        const value = typeof body.value === 'string' ? body.value.trim() : '';

        const response = await buildSettingsPostResponse(configInspectOpts(), deps, key, value);
        previewEnvOverrides[key] = value;
        pendingRestart = true;

        respondJson(res, 200, response);
        return;
      }

      if (method === 'GET' && pathname === '/api/traces') {
        respondJson(res, 200, buildTracesResponse(parsedUrl.searchParams.get('limit')));
        return;
      }

      if (method === 'GET' && pathname === '/api/metrics') {
        respondJson(res, 200, buildMetricsResponse());
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

  const MAX_PORT_ATTEMPTS = 10;

  function listenOnPort(srv: http.Server, listenHost: string, listenPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        srv.off('error', onError);
        srv.off('listening', onListening);
      };

      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(listenPort, listenHost);
    });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const currentPort = port + attempt;
    try {
      await listenOnPort(server, host, currentPort);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (!hasErrorCode(err, 'EADDRINUSE')) {
        throw mapListenError(err, host, currentPort);
      }
      log?.warn(
        { host, port: currentPort, attempt: attempt + 1, maxAttempts: MAX_PORT_ATTEMPTS },
        `dashboard:port ${currentPort} in use, trying ${currentPort + 1}`,
      );
    }
  }

  if (lastError) {
    throw mapListenError(lastError, host, port + MAX_PORT_ATTEMPTS - 1);
  }

  const address = server.address() as { address: string; port: number } | null;
  const boundHost = address?.address ?? host;
  const boundPort = address?.port ?? port;
  const url = formatDashboardUrl(boundHost, boundPort);

  log?.info({ host: boundHost, port: boundPort, cwd: inspectOpts.cwd, url }, 'dashboard:server listening');

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
