import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LoggerLike } from '../logging/logger-like.js';
import { getLocalVersion, isNpmManaged } from '../npm-managed.js';
import { getGitHash } from '../version.js';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import { collectDashboardSnapshot, updateModelConfig } from '../cli/dashboard.js';
import { DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT } from './options.js';
import type { InspectOptions } from '../health/config-doctor.js';
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

type KnownRuntimesType = typeof KNOWN_RUNTIMES;

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

function buildDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discoclaw Dashboard</title>
  <style>
    :root {
      --bg: #071018;
      --bg-alt: #0b1822;
      --panel: rgba(12, 24, 35, 0.92);
      --panel-border: rgba(98, 191, 255, 0.18);
      --text: #e7f6ff;
      --muted: #8ca9bb;
      --accent: #66e2ff;
      --accent-2: #a4ff7c;
      --warn: #ffb86b;
      --danger: #ff7e7e;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
      --radius: 18px;
      --mono: "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(102, 226, 255, 0.18), transparent 30%),
        radial-gradient(circle at top right, rgba(164, 255, 124, 0.12), transparent 25%),
        linear-gradient(180deg, #050b11, #09131d 45%, #071018);
      color: var(--text);
      font-family: var(--mono);
      padding: 24px;
    }
    .shell {
      max-width: 1280px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }
    .hero {
      padding: 28px;
      display: grid;
      gap: 10px;
    }
    .eyebrow {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 12px;
    }
    h1, h2 {
      margin: 0;
      font-weight: 600;
    }
    h1 { font-size: clamp(28px, 4vw, 44px); }
    h2 { font-size: 16px; color: var(--accent); }
    p, label, input, button, select, textarea, pre, code { font: inherit; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
    }
    .panel { padding: 20px; }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 10px;
    }
    .metric {
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; }
    .metric .value { margin-top: 8px; word-break: break-word; }
    .actions, form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    input, button {
      border-radius: 10px;
      border: 1px solid rgba(102, 226, 255, 0.18);
      background: rgba(9, 18, 27, 0.95);
      color: var(--text);
      padding: 10px 12px;
    }
    input {
      min-width: 0;
      flex: 1 1 160px;
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, rgba(102, 226, 255, 0.18), rgba(164, 255, 124, 0.14));
    }
    button:hover { border-color: rgba(164, 255, 124, 0.4); }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: #d9edf8;
      max-height: 340px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    th { color: var(--muted); font-weight: 500; }
    .status { color: var(--muted); min-height: 1.4em; }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--accent-2); }
    .finding { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .finding:last-child { border-bottom: 0; }
    .finding .severity { color: var(--warn); }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Discoclaw Local Dashboard</div>
      <h1>Operator surface over HTTP.</h1>
      <div class="muted">Loopback only. No CORS. Same doctor, model, and service controls as the terminal dashboard.</div>
      <div id="hero-status" class="status"></div>
    </section>

    <section class="grid">
      <section class="panel">
        <h2>Snapshot</h2>
        <div id="snapshot-meta" class="meta"></div>
        <table>
          <thead>
            <tr><th>Role</th><th>Effective</th><th>Source</th></tr>
          </thead>
          <tbody id="models-body"></tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Service</h2>
        <div class="actions">
          <button id="refresh-btn" type="button">Refresh</button>
          <button id="status-btn" type="button">Status</button>
          <button id="logs-btn" type="button">Logs</button>
          <button id="restart-btn" type="button">Restart</button>
        </div>
        <div id="service-status" class="status"></div>
        <pre id="service-output">(no output)</pre>
      </section>

      <section class="panel">
        <h2>Config Doctor</h2>
        <div class="actions">
          <button id="doctor-btn" type="button">Run Doctor</button>
          <button id="doctor-fix-btn" type="button">Apply Fixes</button>
        </div>
        <div id="doctor-status" class="status"></div>
        <div id="doctor-findings" class="muted">Loading…</div>
      </section>

      <section class="panel">
        <h2>Model Assignment</h2>
        <form id="model-form">
          <input id="role-input" name="role" placeholder="role: chat, fast, voice…" required />
          <input id="model-input" name="model" placeholder='model or "default"' required />
          <button type="submit">Save</button>
        </form>
        <div id="model-status" class="status"></div>
      </section>
    </section>
  </main>

  <script>
    const snapshotMeta = document.getElementById('snapshot-meta');
    const modelsBody = document.getElementById('models-body');
    const serviceOutput = document.getElementById('service-output');
    const heroStatus = document.getElementById('hero-status');
    const serviceStatus = document.getElementById('service-status');
    const doctorStatus = document.getElementById('doctor-status');
    const doctorFindings = document.getElementById('doctor-findings');
    const modelStatus = document.getElementById('model-status');

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw new Error('Non-JSON response from ' + url + ': ' + text);
        }
      }
      if (!response.ok) {
        throw new Error(body.message || ('Request failed: ' + response.status));
      }
      return body;
    }

    function setStatus(node, message, ok = false) {
      node.textContent = message || '';
      node.className = 'status' + (message ? (ok ? ' ok' : ' error') : '');
    }

    function renderSnapshot(snapshot) {
      const items = [
        ['cwd', snapshot.cwd],
        ['version', snapshot.version],
        ['git', snapshot.gitHash || '(not available)'],
        ['install', snapshot.installMode],
        ['service', snapshot.serviceName],
        ['status', snapshot.serviceSummary],
        ['doctor', snapshot.doctorSummary],
      ];
      snapshotMeta.innerHTML = items.map(([label, value]) =>
        '<div class="metric"><div class="label">' + label + '</div><div class="value">' + String(value) + '</div></div>'
      ).join('');
      modelsBody.innerHTML = snapshot.modelRows.map((row) =>
        '<tr><td>' + row.role + '</td><td>' + row.effectiveModel + '</td><td>' + row.source + '</td></tr>'
      ).join('');
      heroStatus.textContent = 'Runtime overrides: fast=' + (snapshot.runtimeOverrides.fastRuntime || 'default')
        + ' voice=' + (snapshot.runtimeOverrides.voiceRuntime || 'default');
    }

    function renderDoctor(report) {
      if (!report.findings || report.findings.length === 0) {
        doctorFindings.innerHTML = '<div class="muted">No findings.</div>';
        return;
      }
      doctorFindings.innerHTML = report.findings.map((finding) =>
        '<div class="finding">'
          + '<div><span class="severity">[' + finding.severity + ']</span> ' + finding.id + '</div>'
          + '<div>' + finding.message + '</div>'
          + '<div class="muted">' + finding.recommendation + '</div>'
        + '</div>'
      ).join('');
    }

    async function refreshSnapshot() {
      const snapshot = await fetchJson('/api/snapshot');
      renderSnapshot(snapshot);
      return snapshot;
    }

    async function refreshDoctor() {
      const report = await fetchJson('/api/doctor');
      renderDoctor(report);
      setStatus(doctorStatus, report.findings.length + ' finding(s) loaded.', true);
      return report;
    }

    document.getElementById('refresh-btn').addEventListener('click', async () => {
      try {
        const snapshot = await refreshSnapshot();
        setStatus(serviceStatus, 'Snapshot refreshed for ' + snapshot.serviceName + '.', true);
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('status-btn').addEventListener('click', async () => {
      try {
        const result = await fetchJson('/api/status');
        serviceOutput.textContent = result.stdout || result.stderr || '(no output)';
        setStatus(serviceStatus, 'Status fetched.', true);
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('logs-btn').addEventListener('click', async () => {
      try {
        const result = await fetchJson('/api/logs');
        serviceOutput.textContent = result.stdout || result.stderr || '(no output)';
        setStatus(serviceStatus, 'Logs fetched.', true);
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('restart-btn').addEventListener('click', async () => {
      if (!window.confirm('Restart the local discoclaw service?')) return;
      try {
        const result = await fetchJson('/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        });
        serviceOutput.textContent = result.result.stdout || result.result.stderr || '(no output)';
        setStatus(serviceStatus, result.message, true);
        await refreshSnapshot();
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('doctor-btn').addEventListener('click', async () => {
      try {
        await refreshDoctor();
      } catch (err) {
        setStatus(doctorStatus, String(err));
      }
    });

    document.getElementById('doctor-fix-btn').addEventListener('click', async () => {
      try {
        const result = await fetchJson('/api/doctor/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await Promise.all([refreshDoctor(), refreshSnapshot()]);
        setStatus(
          doctorStatus,
          'Applied=' + result.result.applied.length + ' Skipped=' + result.result.skipped.length + ' Errors=' + result.result.errors.length,
          true,
        );
      } catch (err) {
        setStatus(doctorStatus, String(err));
      }
    });

    document.getElementById('model-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const role = document.getElementById('role-input').value;
        const model = document.getElementById('model-input').value;
        const result = await fetchJson('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, model }),
        });
        renderSnapshot(result.snapshot);
        setStatus(modelStatus, result.message, true);
      } catch (err) {
        setStatus(modelStatus, String(err));
      }
    });

    Promise.all([refreshSnapshot(), refreshDoctor()]).catch((err) => {
      heroStatus.textContent = String(err);
      heroStatus.className = 'status error';
    });
  </script>
</body>
</html>`;
}

export async function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServer> {
  const inspectOpts = buildInspectOptions(opts);
  const deps: DashboardDeps = { ...createDefaultDeps(), ...opts.deps };
  const host = opts.host ?? DASHBOARD_HOST;
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const log = opts.log;
  const html = buildDashboardHtml();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}`).pathname;

    try {
      if (method === 'GET' && pathname === '/') {
        respondHtml(res, 200, html);
        return;
      }

      if (method === 'GET' && pathname === '/api/snapshot') {
        respondJson(res, 200, await collectDashboardSnapshot(inspectOpts, deps));
        return;
      }

      if (method === 'GET' && pathname === '/api/status') {
        const serviceName = await loadServiceName(inspectOpts, deps);
        respondJson(res, 200, await getServiceStatus(serviceName, deps as ServiceControlDeps));
        return;
      }

      if (method === 'GET' && pathname === '/api/logs') {
        const serviceName = await loadServiceName(inspectOpts, deps);
        respondJson(res, 200, await getServiceLogs(serviceName, deps as ServiceControlDeps));
        return;
      }

      if (pathname === '/api/restart') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          respondJson(res, 400, { ok: false, message: 'Restart requires {"confirm": true}.' });
          return;
        }
        const serviceName = await loadServiceName(inspectOpts, deps);
        const result = await restartService(serviceName, deps as ServiceControlDeps);
        respondJson(res, 200, { ok: true, message: `Restart/start requested for ${serviceName}.`, result });
        return;
      }

      if (method === 'GET' && pathname === '/api/doctor') {
        respondJson(res, 200, await deps.inspect(inspectOpts));
        return;
      }

      if (pathname === '/api/doctor/fix') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        const report = await deps.inspect(inspectOpts);
        const result = await deps.applyFixes(report, inspectOpts);
        const nextReport = await deps.inspect(inspectOpts);
        respondJson(res, 200, { ok: true, result, report: nextReport });
        return;
      }

      if (pathname === '/api/model') {
        if (method !== 'POST') {
          respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
          return;
        }
        const body = await readJsonBody(req);
        const result = await applyModelChange(body, inspectOpts, deps, KNOWN_RUNTIMES);
        respondJson(res, 200, { ok: true, ...result });
        return;
      }

      respondJson(res, 404, { ok: false, message: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (
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
      ) ? 400 : 500;

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
