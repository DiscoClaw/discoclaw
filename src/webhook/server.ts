/**
 * Local HTTP surfaces.
 *
 * - `/webhook/:source` keeps the existing HMAC-verified webhook ingress.
 * - `/` + `/api/*` expose the operator dashboard when started in dashboard mode.
 * - `/dashboard` + `/dashboard/api/*` can expose the same dashboard alongside webhooks.
 *
 * The dashboard path reuses the existing dashboard data layer from `src/cli/dashboard.ts`
 * so the web UI and the CLI stay aligned on doctor/model/service behavior.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DashboardDeps, DashboardSnapshot } from '../cli/dashboard.js';
import { collectDashboardSnapshot, updateModelConfig } from '../cli/dashboard.js';
import { executeCronJob, type CronExecutorContext } from '../cron/executor.js';
import type { CronJob } from '../cron/types.js';
import type { InspectOptions } from '../health/config-doctor.js';
import { applyFixes, inspect, KNOWN_RUNTIMES, loadDoctorContext } from '../health/config-doctor.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { DEFAULTS as MODEL_DEFAULTS, type ModelConfig, type ModelRole, saveModelConfig } from '../model-config.js';
import { getLocalVersion, isNpmManaged } from '../npm-managed.js';
import { isModelTier } from '../runtime/model-tiers.js';
import { saveOverrides, type RuntimeOverrides } from '../runtime-overrides.js';
import { sanitizeExternalContent } from '../sanitize-external.js';
import type { ServiceControlDeps } from '../service-control.js';
import {
  getServiceLogs,
  getServiceStatus,
  normalizeServiceName,
  restartService,
} from '../service-control.js';
import { getGitHash } from '../version.js';

// ---------------------------------------------------------------------------
// Shared constants + config types
// ---------------------------------------------------------------------------

const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const DASHBOARD_MAX_BODY_BYTES = 64 * 1024;

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

type KnownRuntimesType = typeof KNOWN_RUNTIMES;
type JsonRecord = Record<string, unknown>;

export type WebhookSourceConfig = {
  /** HMAC-SHA256 secret used to verify the X-Hub-Signature-256 header. */
  secret: string;
  /** Target Discord channel name or ID. */
  channel: string;
  /**
   * Prompt instruction sent to the runtime. If omitted, a default is built
   * from the source name and the raw request body. When provided, the
   * following placeholders are substituted before the prompt is dispatched:
   * - `{{body}}` — replaced with the raw request body text
   * - `{{source}}` — replaced with the webhook source name
   */
  prompt?: string;
};

export type WebhookConfig = Record<string, WebhookSourceConfig>;

export type WebhookServerOptions = {
  /** Optional absolute path to the webhook JSON config file. */
  configPath?: string;
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1' (loopback only). */
  host?: string;
  /** Mount the operator dashboard on this server. Default: true. */
  dashboardEnabled?: boolean;
  /** Guild ID used when constructing synthetic webhook CronJobs. */
  guildId?: string;
  /** Executor context passed directly to executeCronJob for webhooks. */
  executorCtx?: CronExecutorContext;
  /** Working directory for dashboard doctor/model/service operations. */
  cwd?: string;
  /** Environment used for dashboard doctor/model/service operations. */
  env?: NodeJS.ProcessEnv;
  /** Dependency overrides for dashboard data/service helpers. */
  deps?: Partial<DashboardDeps>;
  log?: LoggerLike;
};

export type DashboardWebServerOptions = Omit<WebhookServerOptions, 'configPath' | 'guildId' | 'executorCtx'>;

export type WebhookServer = {
  /** The underlying Node.js HTTP server. */
  server: http.Server;
  /** Gracefully close the server. */
  close(): Promise<void>;
};

type ModelChangeInput = {
  role?: unknown;
  model?: unknown;
};

type DashboardMount = {
  enabled: boolean;
  rootPath: string;
  apiPrefix: string;
};

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

function verifySignature(body: Buffer, secret: string, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const supplied = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export async function loadWebhookConfig(configPath: string): Promise<WebhookConfig> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook config must be a JSON object');
  }
  return parsed as WebhookConfig;
}

let webhookJobCounter = 0;

function buildWebhookJob(source: string, src: WebhookSourceConfig, bodyText: string, guildId: string): CronJob {
  webhookJobCounter += 1;
  const id = `webhook-${source}-${webhookJobCounter}`;
  const sanitizedBody = sanitizeExternalContent(bodyText, `webhook:${source}`);
  const prompt = src.prompt !== undefined
    ? src.prompt.replaceAll('{{body}}', sanitizedBody).replaceAll('{{source}}', source)
    : `A webhook event was received from source "${source}".\n\nPayload:\n${sanitizedBody}`;
  return {
    id,
    cronId: '',
    threadId: '',
    guildId,
    name: `webhook:${source}`,
    def: {
      triggerType: 'webhook',
      timezone: 'UTC',
      channel: src.channel,
      prompt,
    },
    cron: null,
    running: false,
  };
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

function createDefaultDashboardDeps(): DashboardDeps {
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

function buildInspectOptions(opts: WebhookServerOptions): Required<Pick<InspectOptions, 'cwd' | 'env'>> {
  return {
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    env: opts.env ?? process.env,
  };
}

function buildDashboardMount(configPath: string | undefined, enabled: boolean): DashboardMount {
  if (!enabled) {
    return {
      enabled: false,
      rootPath: '/',
      apiPrefix: '/api',
    };
  }

  if (configPath) {
    return {
      enabled: true,
      rootPath: '/dashboard',
      apiPrefix: '/dashboard/api',
    };
  }

  return {
    enabled: true,
    rootPath: '/',
    apiPrefix: '/api',
  };
}

function isDashboardRoot(pathname: string, mount: DashboardMount): boolean {
  if (!mount.enabled) return false;
  if (mount.rootPath === '/') return pathname === '/';
  return pathname === mount.rootPath || pathname === `${mount.rootPath}/`;
}

function respondWebhook(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: status < 400, message: body }));
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function respondHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonRecord> {
  const body = await readBody(req, DASHBOARD_MAX_BODY_BYTES);
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

function buildDashboardHtml(mount: DashboardMount): string {
  const apiPrefix = JSON.stringify(mount.apiPrefix);

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
    p, label, input, button, pre { font: inherit; }
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
    const apiBase = ${apiPrefix};
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
      const snapshot = await fetchJson(apiBase + '/snapshot');
      renderSnapshot(snapshot);
      return snapshot;
    }

    async function refreshDoctor() {
      const report = await fetchJson(apiBase + '/doctor');
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
        const result = await fetchJson(apiBase + '/status');
        serviceOutput.textContent = result.stdout || result.stderr || '(no output)';
        setStatus(serviceStatus, 'Status fetched.', true);
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('logs-btn').addEventListener('click', async () => {
      try {
        const result = await fetchJson(apiBase + '/logs');
        serviceOutput.textContent = result.stdout || result.stderr || '(no output)';
        setStatus(serviceStatus, 'Logs fetched.', true);
      } catch (err) {
        setStatus(serviceStatus, String(err));
      }
    });

    document.getElementById('restart-btn').addEventListener('click', async () => {
      if (!window.confirm('Restart the local discoclaw service?')) return;
      try {
        const result = await fetchJson(apiBase + '/restart', {
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
        const result = await fetchJson(apiBase + '/doctor/fix', {
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
        const result = await fetchJson(apiBase + '/model', {
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

async function handleDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  mount: DashboardMount,
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
  log: LoggerLike | undefined,
  html: string,
): Promise<boolean> {
  if (!mount.enabled) return false;

  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && isDashboardRoot(pathname, mount)) {
      respondHtml(res, 200, html);
      return true;
    }

    if (!pathname.startsWith(mount.apiPrefix)) return false;

    if (method === 'GET' && pathname === `${mount.apiPrefix}/snapshot`) {
      respondJson(res, 200, await collectDashboardSnapshot(inspectOpts, deps));
      return true;
    }

    if (method === 'GET' && pathname === `${mount.apiPrefix}/status`) {
      const serviceName = await loadServiceName(inspectOpts, deps);
      respondJson(res, 200, await getServiceStatus(serviceName, deps as ServiceControlDeps));
      return true;
    }

    if (method === 'GET' && pathname === `${mount.apiPrefix}/logs`) {
      const serviceName = await loadServiceName(inspectOpts, deps);
      respondJson(res, 200, await getServiceLogs(serviceName, deps as ServiceControlDeps));
      return true;
    }

    if (pathname === `${mount.apiPrefix}/restart`) {
      if (method !== 'POST') {
        respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
        return true;
      }
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        respondJson(res, 400, { ok: false, message: 'Restart requires {"confirm": true}.' });
        return true;
      }
      const serviceName = await loadServiceName(inspectOpts, deps);
      const result = await restartService(serviceName, deps as ServiceControlDeps);
      respondJson(res, 200, { ok: true, message: `Restart/start requested for ${serviceName}.`, result });
      return true;
    }

    if (method === 'GET' && pathname === `${mount.apiPrefix}/doctor`) {
      respondJson(res, 200, await deps.inspect(inspectOpts));
      return true;
    }

    if (pathname === `${mount.apiPrefix}/doctor/fix`) {
      if (method !== 'POST') {
        respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
        return true;
      }
      const report = await deps.inspect(inspectOpts);
      const result = await deps.applyFixes(report, inspectOpts);
      const nextReport = await deps.inspect(inspectOpts);
      respondJson(res, 200, { ok: true, result, report: nextReport });
      return true;
    }

    if (pathname === `${mount.apiPrefix}/model`) {
      if (method !== 'POST') {
        respondJson(res, 405, { ok: false, message: 'Method Not Allowed' });
        return true;
      }
      const body = await readJsonBody(req);
      const result = await applyModelChange(body, inspectOpts, deps, KNOWN_RUNTIMES);
      respondJson(res, 200, { ok: true, ...result });
      return true;
    }

    respondJson(res, 404, { ok: false, message: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = isDashboardBadRequest(message) ? 400 : 500;
    if (status === 500) {
      log?.error({ err, method, pathname }, 'dashboard:http request failed');
    } else {
      log?.warn({ err, method, pathname }, 'dashboard:http bad request');
    }
    respondJson(res, status, { ok: false, message });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startDashboardWebServer(opts: DashboardWebServerOptions = {}): Promise<WebhookServer> {
  return startWebhookServer(opts);
}

export async function startWebhookServer(opts: WebhookServerOptions = {}): Promise<WebhookServer> {
  const {
    configPath,
    port = 8080,
    host = '127.0.0.1',
    dashboardEnabled = true,
    guildId,
    executorCtx,
    log,
  } = opts;

  if (configPath && (!guildId || !executorCtx)) {
    throw new Error('Webhook server requires guildId and executorCtx when configPath is set.');
  }

  const inspectOpts = buildInspectOptions(opts);
  const deps: DashboardDeps = { ...createDefaultDashboardDeps(), ...opts.deps };
  const dashboardMount = buildDashboardMount(configPath, dashboardEnabled);
  const dashboardHtml = buildDashboardHtml(dashboardMount);

  let config: WebhookConfig = {};
  if (configPath) {
    config = await loadWebhookConfig(configPath);
    log?.info({ configPath, sources: Object.keys(config) }, 'webhook:config loaded');
  }

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.replace(/[?#].*$/, '') || '/';

    if (await handleDashboardRequest(req, res, pathname, dashboardMount, inspectOpts, deps, log, dashboardHtml)) {
      return;
    }

    const match = pathname.match(/^\/webhook\/([^/?#]+)$/);
    if (!match) {
      respondWebhook(res, 404, 'Not found');
      return;
    }

    if ((req.method ?? 'GET') !== 'POST') {
      respondWebhook(res, 405, 'Method Not Allowed');
      return;
    }

    let source: string;
    try {
      source = decodeURIComponent(match[1]);
    } catch {
      respondWebhook(res, 400, 'Bad request');
      return;
    }

    const src = config[source];
    if (!src) {
      log?.warn({ source }, 'webhook:unknown source');
      respondWebhook(res, 404, 'Not found');
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Request body too large') {
        log?.warn({ source }, 'webhook:body too large');
        respondWebhook(res, 413, 'Payload Too Large');
        return;
      }
      log?.warn({ source, err }, 'webhook:body read error');
      respondWebhook(res, 400, 'Bad request');
      return;
    }

    const sigHeader = String(req.headers['x-hub-signature-256'] ?? '');
    if (!verifySignature(body, src.secret, sigHeader)) {
      log?.warn({ source }, 'webhook:signature verification failed');
      respondWebhook(res, 401, 'Unauthorized');
      return;
    }

    respondWebhook(res, 202, 'Accepted');

    const bodyText = body.toString('utf8');
    const job = buildWebhookJob(source, src, bodyText, guildId!);

    log?.info({ source, jobId: job.id, channel: src.channel }, 'webhook:dispatching');

    void executeCronJob(job, executorCtx!).catch((err) => {
      log?.error({ source, jobId: job.id, err }, 'webhook:executor error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log?.info(
    {
      host,
      port: (server.address() as { port: number } | null)?.port ?? port,
      dashboardPath: dashboardMount.enabled ? dashboardMount.rootPath : null,
      webhookSources: Object.keys(config),
    },
    'webhook:server listening',
  );

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
