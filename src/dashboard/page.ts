export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discoclaw Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --bg-elevated: rgba(15, 18, 18, 0.96);
      --bg-soft: rgba(12, 17, 17, 0.9);
      --card: rgba(16, 22, 22, 0.92);
      --card-border: rgba(90, 233, 255, 0.18);
      --text: #ecfffe;
      --muted: #86a1a3;
      --cyan: #5ae9ff;
      --green: #7dffb0;
      --amber: #ffc978;
      --red: #ff8a8a;
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      --radius: 18px;
      --mono: "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    * { box-sizing: border-box; }

    html, body { min-height: 100%; }

    body {
      margin: 0;
      font-family: var(--mono);
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(90, 233, 255, 0.12), transparent 30%),
        radial-gradient(circle at top right, rgba(125, 255, 176, 0.08), transparent 26%),
        linear-gradient(180deg, #050505 0%, #0a0a0a 52%, #080d0d 100%);
      padding: 24px;
    }

    button, input, pre, code, table {
      font: inherit;
    }

    .shell {
      width: min(1320px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }

    .hero,
    .card {
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(18, 26, 26, 0.95), rgba(10, 13, 13, 0.94));
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .hero {
      padding: 28px;
      display: grid;
      gap: 14px;
    }

    .hero-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .eyebrow {
      color: var(--cyan);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    h1, h2, h3, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(30px, 5vw, 50px);
      line-height: 1;
    }

    h2 {
      color: var(--cyan);
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .hero-copy {
      color: var(--muted);
      max-width: 70ch;
      line-height: 1.6;
    }

    .hero-status {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .pill {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      color: var(--muted);
      font-size: 13px;
    }

    .layout {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 20px;
    }

    .card {
      padding: 20px;
      display: grid;
      gap: 16px;
      min-width: 0;
    }

    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .card-copy {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }

    .metric {
      padding: 14px;
      border-radius: 14px;
      background: var(--bg-soft);
      border: 1px solid rgba(255, 255, 255, 0.05);
      min-width: 0;
    }

    .metric-label {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }

    .metric-value {
      word-break: break-word;
      line-height: 1.45;
    }

    .actions,
    .form-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    button,
    input {
      border-radius: 12px;
      border: 1px solid rgba(90, 233, 255, 0.22);
      color: var(--text);
      background: rgba(6, 9, 9, 0.96);
      padding: 10px 13px;
      min-height: 42px;
    }

    button {
      cursor: pointer;
      background: linear-gradient(135deg, rgba(90, 233, 255, 0.18), rgba(125, 255, 176, 0.12));
      transition: border-color 120ms ease, transform 120ms ease;
    }

    button:hover {
      border-color: rgba(125, 255, 176, 0.4);
      transform: translateY(-1px);
    }

    button.secondary {
      background: rgba(255, 255, 255, 0.03);
    }

    input {
      flex: 1 1 180px;
      min-width: 0;
    }

    .status {
      min-height: 1.4em;
      color: var(--muted);
      line-height: 1.5;
      word-break: break-word;
    }

    .status.ok { color: var(--green); }
    .status.error { color: var(--red); }
    .status.warn { color: var(--amber); }

    pre {
      margin: 0;
      min-height: 280px;
      max-height: 420px;
      overflow: auto;
      border-radius: 14px;
      padding: 14px;
      background: rgba(4, 7, 7, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.06);
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th, td {
      padding: 12px 10px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 500;
    }

    .table-wrap {
      overflow: auto;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(5, 8, 8, 0.78);
    }

    .path-list,
    .finding-list {
      display: grid;
      gap: 10px;
    }

    .path-item,
    .finding {
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--bg-soft);
      border: 1px solid rgba(255, 255, 255, 0.05);
      min-width: 0;
    }

    .path-label,
    .finding-meta {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 8px;
    }

    .path-value {
      word-break: break-word;
      line-height: 1.45;
    }

    .finding-severity {
      color: var(--amber);
    }

    .finding-recommendation {
      color: var(--muted);
      margin-top: 8px;
      line-height: 1.45;
    }

    .runtime-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }

    .empty {
      color: var(--muted);
      padding: 8px 0;
    }

    @media (max-width: 980px) {
      .span-4,
      .span-5,
      .span-6,
      .span-7,
      .span-8 {
        grid-column: span 12;
      }
    }

    @media (max-width: 640px) {
      body {
        padding: 16px;
      }

      .hero,
      .card {
        padding: 18px;
      }

      th, td {
        padding: 10px 8px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-bar">
        <div>
          <div class="eyebrow">Discoclaw Local Dashboard</div>
          <h1>Operator surface over HTTP</h1>
        </div>
        <button id="refresh-btn" type="button">Refresh snapshot</button>
      </div>
      <p class="hero-copy">Loopback-only control plane for the local Discoclaw service. This page reuses the dashboard snapshot, doctor, model, and service actions already available in the CLI.</p>
      <div class="hero-status">
        <div id="hero-service-pill" class="pill">Service: loading</div>
        <div id="hero-runtime-pill" class="pill">Runtime overrides: loading</div>
      </div>
      <div id="hero-status" class="status"></div>
    </section>

    <section class="layout">
      <section class="card span-5">
        <div class="card-header">
          <div>
            <h2>Overview</h2>
            <p class="card-copy">Current install, repo, and operator snapshot.</p>
          </div>
        </div>
        <div id="overview-metrics" class="metrics"></div>
      </section>

      <section class="card span-7">
        <div class="card-header">
          <div>
            <h2>Service Control</h2>
            <p class="card-copy">Inspect the local service, tail logs, or request a restart.</p>
          </div>
          <div class="actions">
            <button id="status-btn" type="button">Status</button>
            <button id="logs-btn" type="button">Logs</button>
            <button id="restart-btn" type="button">Restart</button>
          </div>
        </div>
        <div id="service-status" class="status"></div>
        <pre id="service-output">(no output)</pre>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Model Assignments</h2>
            <p class="card-copy">Effective model resolution for each dashboard role.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Effective Model</th>
                <th>Source</th>
                <th>Override</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="models-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Change Model</h2>
            <p class="card-copy">Persist a model override or reset a role back to its default.</p>
          </div>
        </div>
        <form id="model-form">
          <div class="form-row">
            <input id="role-input" name="role" placeholder="role: chat, fast, voice" required />
            <input id="model-input" name="model" placeholder='model or "default"' required />
            <button id="model-submit-btn" type="submit">Change model</button>
          </div>
        </form>
        <div id="model-status" class="status"></div>
      </section>

      <section class="card span-7">
        <div class="card-header">
          <div>
            <h2>Config Doctor</h2>
            <p class="card-copy">Review doctor findings, then apply automated fixes when appropriate.</p>
          </div>
          <div class="actions">
            <button id="doctor-btn" type="button">Doctor</button>
            <button id="doctor-fix-btn" type="button">Fix</button>
          </div>
        </div>
        <div id="doctor-summary" class="status"></div>
        <div id="doctor-findings" class="finding-list"></div>
      </section>

      <section class="card span-5">
        <div class="card-header">
          <div>
            <h2>Config Paths</h2>
            <p class="card-copy">Resolved file locations and runtime override state.</p>
          </div>
        </div>
        <div id="runtime-overrides" class="runtime-grid"></div>
        <div id="config-paths" class="path-list"></div>
      </section>
    </section>
  </main>

  <script>
    const overviewMetrics = document.getElementById('overview-metrics');
    const modelsBody = document.getElementById('models-body');
    const configPaths = document.getElementById('config-paths');
    const runtimeOverrides = document.getElementById('runtime-overrides');
    const serviceOutput = document.getElementById('service-output');
    const heroStatus = document.getElementById('hero-status');
    const heroServicePill = document.getElementById('hero-service-pill');
    const heroRuntimePill = document.getElementById('hero-runtime-pill');
    const serviceStatus = document.getElementById('service-status');
    const doctorSummary = document.getElementById('doctor-summary');
    const doctorFindings = document.getElementById('doctor-findings');
    const modelStatus = document.getElementById('model-status');
    const roleInput = document.getElementById('role-input');
    const modelInput = document.getElementById('model-input');

    let lastSnapshot = null;

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (error) {
          throw new Error('Non-JSON response from ' + url + ': ' + text);
        }
      }
      if (!response.ok) {
        throw new Error(body.message || ('Request failed: ' + response.status));
      }
      return body;
    }

    function setStatus(node, message, tone) {
      node.textContent = message || '';
      const suffix = tone ? ' ' + tone : '';
      node.className = 'status' + suffix;
    }

    function clearNode(node) {
      node.replaceChildren();
    }

    function appendMetric(parent, label, value) {
      const wrapper = document.createElement('div');
      wrapper.className = 'metric';

      const labelNode = document.createElement('div');
      labelNode.className = 'metric-label';
      labelNode.textContent = label;

      const valueNode = document.createElement('div');
      valueNode.className = 'metric-value';
      valueNode.textContent = value;

      wrapper.append(labelNode, valueNode);
      parent.append(wrapper);
    }

    function appendPath(parent, label, value) {
      const wrapper = document.createElement('div');
      wrapper.className = 'path-item';

      const labelNode = document.createElement('div');
      labelNode.className = 'path-label';
      labelNode.textContent = label;

      const valueNode = document.createElement('div');
      valueNode.className = 'path-value';
      valueNode.textContent = value;

      wrapper.append(labelNode, valueNode);
      parent.append(wrapper);
    }

    function appendRuntimeOverride(parent, label, value) {
      appendMetric(parent, label, value);
    }

    function setOutput(message) {
      serviceOutput.textContent = message || '(no output)';
    }

    function populateModelForm(role, model) {
      roleInput.value = role || '';
      modelInput.value = model || '';
      modelInput.focus();
      modelInput.select();
    }

    function renderSnapshot(snapshot) {
      lastSnapshot = snapshot;

      clearNode(overviewMetrics);
      appendMetric(overviewMetrics, 'cwd', snapshot.cwd);
      appendMetric(overviewMetrics, 'version', snapshot.version);
      appendMetric(overviewMetrics, 'git', snapshot.gitHash || '(not available)');
      appendMetric(overviewMetrics, 'install mode', snapshot.installMode);
      appendMetric(overviewMetrics, 'service name', snapshot.serviceName);
      appendMetric(overviewMetrics, 'service state', snapshot.serviceSummary);
      appendMetric(overviewMetrics, 'doctor summary', snapshot.doctorSummary);

      clearNode(modelsBody);
      snapshot.modelRows.forEach((row) => {
        const tr = document.createElement('tr');

        const roleCell = document.createElement('td');
        roleCell.textContent = row.role;

        const effectiveCell = document.createElement('td');
        effectiveCell.textContent = row.effectiveModel;

        const sourceCell = document.createElement('td');
        sourceCell.textContent = row.source;

        const overrideCell = document.createElement('td');
        overrideCell.textContent = row.overrideValue || '(default)';

        const actionCell = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Change';
        button.addEventListener('click', () => populateModelForm(row.role, row.overrideValue || row.effectiveModel));
        actionCell.append(button);

        tr.append(roleCell, effectiveCell, sourceCell, overrideCell, actionCell);
        modelsBody.append(tr);
      });

      clearNode(configPaths);
      Object.entries(snapshot.configPaths).forEach(([label, value]) => {
        appendPath(configPaths, label, String(value));
      });

      clearNode(runtimeOverrides);
      appendRuntimeOverride(runtimeOverrides, 'fast runtime', snapshot.runtimeOverrides.fastRuntime || 'default');
      appendRuntimeOverride(runtimeOverrides, 'voice runtime', snapshot.runtimeOverrides.voiceRuntime || 'default');

      heroServicePill.textContent = 'Service: ' + snapshot.serviceSummary;
      heroRuntimePill.textContent = 'Runtime overrides: fast=' + (snapshot.runtimeOverrides.fastRuntime || 'default')
        + ' voice=' + (snapshot.runtimeOverrides.voiceRuntime || 'default');
      setStatus(serviceStatus, snapshot.serviceSummary, 'ok');
    }

    function renderDoctor(report, summary) {
      clearNode(doctorFindings);
      if (!report.findings || report.findings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No doctor findings.';
        doctorFindings.append(empty);
      } else {
        report.findings.forEach((finding) => {
          const wrapper = document.createElement('div');
          wrapper.className = 'finding';

          const meta = document.createElement('div');
          meta.className = 'finding-meta';
          meta.textContent = finding.id + ' ';

          const severity = document.createElement('span');
          severity.className = 'finding-severity';
          severity.textContent = '[' + finding.severity + ']';
          meta.append(severity);

          const message = document.createElement('div');
          message.textContent = finding.message;

          const recommendation = document.createElement('div');
          recommendation.className = 'finding-recommendation';
          recommendation.textContent = finding.recommendation || '';

          wrapper.append(meta, message);
          if (finding.recommendation) wrapper.append(recommendation);
          doctorFindings.append(wrapper);
        });
      }

      const tone = report.findings && report.findings.some((finding) => finding.severity === 'error')
        ? 'error'
        : report.findings && report.findings.some((finding) => finding.severity === 'warn')
          ? 'warn'
          : 'ok';
      setStatus(doctorSummary, summary, tone);
    }

    async function refreshSnapshot(showMessage) {
      const response = await fetchJson('/api/snapshot');
      renderSnapshot(response.snapshot);
      if (showMessage) setStatus(heroStatus, 'Snapshot refreshed.', 'ok');
      return response.snapshot;
    }

    async function refreshDoctor(showMessage) {
      const response = await fetchJson('/api/doctor');
      renderDoctor(response.report, response.summary);
      if (showMessage) setStatus(heroStatus, 'Doctor summary refreshed.', 'ok');
      return response.report;
    }

    document.getElementById('refresh-btn').addEventListener('click', async () => {
      try {
        await Promise.all([refreshSnapshot(false), refreshDoctor(false)]);
        setStatus(heroStatus, 'Dashboard refreshed.', 'ok');
      } catch (error) {
        setStatus(heroStatus, String(error), 'error');
      }
    });

    document.getElementById('status-btn').addEventListener('click', async () => {
      try {
        const response = await fetchJson('/api/status');
        setOutput(response.result.stdout || response.result.stderr || '(no output)');
        setStatus(serviceStatus, response.summary, 'ok');
      } catch (error) {
        setStatus(serviceStatus, String(error), 'error');
      }
    });

    document.getElementById('logs-btn').addEventListener('click', async () => {
      try {
        const response = await fetchJson('/api/logs');
        setOutput(response.result.stdout || response.result.stderr || '(no output)');
        setStatus(serviceStatus, response.summary, 'ok');
      } catch (error) {
        setStatus(serviceStatus, String(error), 'error');
      }
    });

    document.getElementById('restart-btn').addEventListener('click', async () => {
      if (!window.confirm('Restart the local Discoclaw service?')) return;
      try {
        const response = await fetchJson('/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        });
        setOutput(response.result.stdout || response.result.stderr || '(no output)');
        renderSnapshot(response.snapshot);
        setStatus(serviceStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(serviceStatus, String(error), 'error');
      }
    });

    document.getElementById('doctor-btn').addEventListener('click', async () => {
      try {
        await refreshDoctor(false);
        setStatus(heroStatus, 'Doctor completed.', 'ok');
      } catch (error) {
        setStatus(doctorSummary, String(error), 'error');
      }
    });

    document.getElementById('doctor-fix-btn').addEventListener('click', async () => {
      if (!window.confirm('Apply automated config doctor fixes?')) return;
      try {
        const response = await fetchJson('/api/doctor/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        renderSnapshot(response.snapshot);
        renderDoctor(response.report, response.summary);
        setStatus(
          doctorSummary,
          'Applied=' + response.result.applied.length + ' Skipped=' + response.result.skipped.length + ' Errors=' + response.result.errors.length,
          response.result.errors.length > 0 ? 'error' : 'ok',
        );
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(doctorSummary, String(error), 'error');
      }
    });

    document.getElementById('model-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: roleInput.value,
            model: modelInput.value,
          }),
        });
        renderSnapshot(response.snapshot);
        setStatus(modelStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(modelStatus, String(error), 'error');
      }
    });

    Promise.all([refreshSnapshot(false), refreshDoctor(false)]).then(() => {
      setStatus(heroStatus, 'Dashboard ready.', 'ok');
      if (lastSnapshot) {
        populateModelForm(lastSnapshot.modelRows[0] && lastSnapshot.modelRows[0].role, '');
      }
    }).catch((error) => {
      setStatus(heroStatus, String(error), 'error');
      setStatus(serviceStatus, String(error), 'error');
      setStatus(doctorSummary, String(error), 'error');
    });
  </script>
</body>
</html>`;
}
