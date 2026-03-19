import type { DashboardSnapshot } from '../cli/dashboard.js';

export type CanvasBuiltinAppName = 'dashboard';

export type CanvasBuiltinAppResponse = {
  name: CanvasBuiltinAppName;
  title: string;
  content: string;
  refreshSeconds?: number;
};

export type CanvasBuiltinApps = {
  hasApp(name: string): name is CanvasBuiltinAppName;
  getAppTitle(name: string): string | null;
  renderApp(name: string): Promise<CanvasBuiltinAppResponse | null>;
  getAppData(name: string): Promise<unknown | null>;
};

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderMetric(label: string, value: string): string {
  return `<article class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></article>`;
}

function renderDashboardStatus(snapshot: DashboardSnapshot): string {
  const pills = [
    `Service: ${snapshot.serviceSummary}`,
    `Doctor: ${snapshot.doctorSummary}`,
    `Runtime: ${snapshot.primaryRuntime}`,
    `MCP warnings: ${String(snapshot.mcpWarnings)}`,
  ];
  return pills.map((pill) => `<div class="pill">${escapeHtml(pill)}</div>`).join('');
}

function renderDashboardModels(snapshot: DashboardSnapshot): string {
  return snapshot.modelRows.map((row) => (
    `<div class="list-row"><span>${escapeHtml(row.role)}</span><span>${escapeHtml(row.effectiveModel)}</span><span>${escapeHtml(row.source)}</span></div>`
  )).join('');
}

function renderDashboardPaths(snapshot: DashboardSnapshot): string {
  return Object.entries(snapshot.configPaths)
    .map(([label, value]) => `<div class="path-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(String(value || '(unset)'))}</code></div>`)
    .join('');
}

function renderMcpSummary(snapshot: DashboardSnapshot): string {
  const status = snapshot.mcpStatus;
  if (status.status === 'found') {
    return `Found ${status.servers.length} server(s)`;
  }
  if (status.status === 'invalid') {
    return `Invalid: ${status.reason}`;
  }
  if (status.status === 'missing') return 'No MCP config detected';
  return 'unknown';
}

export function renderDashboardCanvasApp(snapshot: DashboardSnapshot): string {
  const renderedAt = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
  const metrics = [
    renderMetric('Version', snapshot.version),
    renderMetric('Git hash', snapshot.gitHash ?? '(not available)'),
    renderMetric('Install mode', snapshot.installMode),
    renderMetric('Service', snapshot.serviceName),
    renderMetric('CWD', snapshot.cwd),
    renderMetric('MCP', renderMcpSummary(snapshot)),
  ].join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Discoclaw Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081119;
        --panel: rgba(9, 18, 28, 0.92);
        --panel-strong: rgba(12, 22, 34, 0.98);
        --border: rgba(125, 211, 252, 0.16);
        --text: #f3fbff;
        --muted: #a6bfca;
        --accent: #7dd3fc;
        --accent-2: #86efac;
        --warn: #fde68a;
        --radius: 18px;
        --shadow: 0 22px 60px rgba(3, 10, 18, 0.45);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(125, 211, 252, 0.16), transparent 28%),
          linear-gradient(180deg, #071019 0%, #081119 48%, #050b12 100%);
      }
      .shell {
        width: min(1100px, 100%);
        margin: 0 auto;
        padding: 20px;
        display: grid;
        gap: 18px;
      }
      .hero,
      .card {
        background: linear-gradient(180deg, rgba(9, 18, 28, 0.96), rgba(8, 17, 25, 0.92));
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 20px;
        display: grid;
        gap: 14px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 11px;
        color: var(--accent);
      }
      h1, h2, p {
        margin: 0;
      }
      h1 {
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1;
      }
      h2 {
        font-size: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .copy,
      .meta {
        color: var(--muted);
        line-height: 1.55;
      }
      .pill-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .pill {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        color: var(--muted);
        font-size: 13px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 18px;
      }
      .card {
        padding: 18px;
        display: grid;
        gap: 14px;
        min-width: 0;
      }
      .span-12 { grid-column: span 12; }
      .span-7 { grid-column: span 7; }
      .span-5 { grid-column: span 5; }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
        gap: 12px;
      }
      .metric {
        padding: 14px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .metric-label {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 8px;
      }
      .metric-value {
        line-height: 1.45;
        word-break: break-word;
      }
      .list,
      .paths {
        display: grid;
        gap: 10px;
      }
      .list-head,
      .list-row,
      .path-row {
        display: grid;
        gap: 10px;
        align-items: baseline;
      }
      .list-head,
      .list-row {
        grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.8fr) auto;
      }
      .list-head {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
      }
      .list-row {
        padding: 12px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .path-row {
        grid-template-columns: minmax(120px, 160px) minmax(0, 1fr);
        padding: 12px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
        color: var(--accent-2);
        word-break: break-all;
      }
      .meta strong {
        color: var(--warn);
      }
      @media (max-width: 820px) {
        .span-7,
        .span-5 {
          grid-column: span 12;
        }
      }
      @media (max-width: 560px) {
        .shell {
          padding: 14px;
          gap: 14px;
        }
        .hero,
        .card {
          padding: 16px;
        }
        .list-head,
        .list-row,
        .path-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">Discoclaw Activity App</div>
        <h1>Dashboard</h1>
        <p class="copy">Read-only runtime status for the current discoclaw install. This view is refreshed by the Activity shell on an interval, so it stays safe inside Discord without talking to the operator-only dashboard server.</p>
        <div class="pill-row">${renderDashboardStatus(snapshot)}</div>
        <p class="meta">Rendered at <strong>${escapeHtml(renderedAt)}</strong>.</p>
      </section>
      <section class="grid">
        <section class="card span-12">
          <h2>Overview</h2>
          <div class="metrics">${metrics}</div>
        </section>
        <section class="card span-7">
          <h2>Model Assignments</h2>
          <div class="list">
            <div class="list-head"><span>Role</span><span>Model</span><span>Source</span></div>
            ${renderDashboardModels(snapshot)}
          </div>
        </section>
        <section class="card span-5">
          <h2>Config Paths</h2>
          <div class="paths">${renderDashboardPaths(snapshot)}</div>
        </section>
      </section>
    </div>
  </body>
</html>`;
}

export function createCanvasBuiltinApps(input: {
  getDashboardSnapshot: () => Promise<DashboardSnapshot>;
  dashboardRefreshSeconds?: number;
}): CanvasBuiltinApps {
  const refreshSeconds = input.dashboardRefreshSeconds ?? 45;

  return {
    hasApp(name: string): name is CanvasBuiltinAppName {
      return name === 'dashboard';
    },
    getAppTitle(name: string): string | null {
      return name === 'dashboard' ? 'Dashboard' : null;
    },
    async renderApp(name: string): Promise<CanvasBuiltinAppResponse | null> {
      if (name !== 'dashboard') return null;
      const snapshot = await input.getDashboardSnapshot();
      return {
        name: 'dashboard',
        title: 'Dashboard',
        refreshSeconds,
        content: renderDashboardCanvasApp(snapshot),
      };
    },
    async getAppData(name: string): Promise<unknown | null> {
      if (name !== 'dashboard') return null;
      return input.getDashboardSnapshot();
    },
  };
}
