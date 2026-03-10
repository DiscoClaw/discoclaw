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

    button, input, select, pre, code, table {
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
    input,
    select {
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

    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      transform: none;
      border-color: rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
    }

    button.secondary {
      background: rgba(255, 255, 255, 0.03);
    }

    input,
    select {
      flex: 1 1 180px;
      min-width: 0;
    }

    .field-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    .field {
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .field-label {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .field[hidden] {
      display: none;
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

    .finding-section {
      display: grid;
      gap: 10px;
    }

    .finding-section-title {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
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
      margin-bottom: 8px;
    }

    .path-value {
      word-break: break-word;
      line-height: 1.45;
    }

    .role-name {
      font-weight: 500;
      margin-bottom: 4px;
    }

    .role-copy,
    .field-note {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    .finding-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .finding-id {
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      word-break: break-word;
    }

    .finding-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .finding-badge {
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
    }

    .finding-badge.warn {
      color: var(--amber);
      border-color: rgba(255, 201, 120, 0.22);
    }

    .finding-badge.error {
      color: var(--red);
      border-color: rgba(255, 138, 138, 0.26);
    }

    .finding-badge.info {
      color: var(--cyan);
      border-color: rgba(90, 233, 255, 0.24);
    }

    .finding-badge.fixable {
      color: var(--green);
      border-color: rgba(125, 255, 176, 0.24);
    }

    .finding-body {
      line-height: 1.5;
    }

    .finding-recommendation {
      color: var(--muted);
      margin-top: 8px;
      line-height: 1.45;
    }

    .doctor-helper {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
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
          <div class="eyebrow">Discoclaw Control Panel</div>
        </div>
        <button id="refresh-btn" type="button">Refresh</button>
      </div>
      <p class="hero-copy">Check service health, review current settings, and make common changes from one local dashboard. This dashboard stays local by default.</p>
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
            <p class="card-copy">Version, service state, install mode, and config check summary.</p>
          </div>
        </div>
        <div id="overview-metrics" class="metrics"></div>
      </section>

      <section class="card span-7">
        <div class="card-header">
          <div>
            <h2>Service Controls</h2>
            <p class="card-copy">View status, inspect recent logs, or restart the service.</p>
          </div>
          <div class="actions">
            <button id="status-btn" type="button">View Status</button>
            <button id="logs-btn" type="button">View Logs</button>
            <button id="restart-btn" type="button">Restart</button>
          </div>
        </div>
        <div id="service-status" class="status"></div>
        <pre id="service-output">(no output)</pre>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Current Model Settings</h2>
            <p class="card-copy">What each role is using right now.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Using Now</th>
                <th>Comes From</th>
                <th>Saved Setting</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="models-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Change a Saved Setting</h2>
            <p class="card-copy">Choose a role, then pick from the valid saved options for that role. Changes apply on the next service restart.</p>
          </div>
        </div>
        <form id="model-form">
          <div class="field-grid">
            <label class="field" for="role-select">
              <span class="field-label">Role</span>
              <select id="role-select" name="role" required></select>
            </label>
            <label class="field" for="model-select">
              <span class="field-label">Saved Model</span>
              <select id="model-select" name="model" required></select>
            </label>
          </div>
          <div id="model-form-help" class="field-note">Choose a role to see its saved options.</div>
          <div class="actions">
            <button id="model-submit-btn" type="submit">Save Setting</button>
          </div>
        </form>
        <div id="model-status" class="status"></div>
      </section>

      <section class="card span-7">
        <div class="card-header">
          <div>
            <h2>Config Check</h2>
            <p class="card-copy">Scan for config problems and cleanup suggestions. Safe fixes can be applied automatically; review-only items stay listed below.</p>
          </div>
          <div class="actions">
            <button id="doctor-btn" type="button">Run Check</button>
            <button id="doctor-fix-btn" type="button" disabled>Apply Safe Fixes</button>
          </div>
        </div>
        <div id="doctor-summary" class="status"></div>
        <div id="doctor-helper" class="doctor-helper"></div>
        <div id="doctor-findings" class="finding-list"></div>
      </section>

      <section class="card span-5">
        <div class="card-header">
          <div>
            <h2>Advanced Details</h2>
            <p class="card-copy">File locations and runtime adapter overrides.</p>
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
    const doctorHelper = document.getElementById('doctor-helper');
    const doctorFindings = document.getElementById('doctor-findings');
    const doctorFixButton = document.getElementById('doctor-fix-btn');
    const modelStatus = document.getElementById('model-status');
    const modelFormHelp = document.getElementById('model-form-help');
    const roleSelect = document.getElementById('role-select');
    const modelSelect = document.getElementById('model-select');
    const ROLE_LABELS = {
      chat: 'Chat',
      'plan-run': 'Plan Run',
      fast: 'Quick Tasks',
      summary: 'Summaries',
      cron: 'Automation Planning',
      'cron-exec': 'Automation Runs',
      voice: 'Voice Replies',
      'forge-drafter': 'Forge Drafting',
      'forge-auditor': 'Forge Review',
    };
    const ROLE_HELP = {
      chat: 'Main Discord replies.',
      'plan-run': 'Plan execution phases.',
      fast: 'Quick helper work like tagging and lightweight jobs.',
      summary: 'Conversation summaries and memory rollups.',
      cron: 'Turning automation thread text into schedules.',
      'cron-exec': 'Scheduled automation runs.',
      voice: 'Voice conversations and spoken replies.',
      'forge-drafter': 'Forge drafting passes.',
      'forge-auditor': 'Forge review passes.',
    };

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

    function appendSelectOption(select, value, label) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }

    function getSnapshotRoles(snapshot) {
      if (Array.isArray(snapshot.roles) && snapshot.roles.length > 0) {
        return snapshot.roles;
      }
      return Array.isArray(snapshot.modelRows)
        ? snapshot.modelRows.map((row) => row.role)
        : [];
    }

    function getModelOptionsForRole(role) {
      if (!lastSnapshot || !lastSnapshot.modelOptions) return [];
      const options = lastSnapshot.modelOptions[role];
      return Array.isArray(options) ? options : [];
    }

    function getSelectedModelValue() {
      return modelSelect.value;
    }

    function formatRoleLabel(role) {
      return ROLE_LABELS[role] || role;
    }

    function getRoleHelp(role) {
      return ROLE_HELP[role] || 'Saved model setting for this role.';
    }

    function formatModelOptionLabel(role, model) {
      if (model === 'default') return 'Use startup default';
      if (model === 'fast' || model === 'capable' || model === 'deep') {
        return model + ' tier';
      }
      return model;
    }

    function formatSourceLabel(source) {
      return source === 'override' ? 'saved setting' : 'startup default';
    }

    function updateModelFormHelp(role) {
      if (!modelFormHelp) return;
      modelFormHelp.textContent = getRoleHelp(role) + ' Only valid saved values are listed here.';
    }

    function syncRoleOptions(selectedRole) {
      if (!lastSnapshot) return '';

      const roles = getSnapshotRoles(lastSnapshot);
      clearNode(roleSelect);
      roles.forEach((role) => appendSelectOption(roleSelect, role, formatRoleLabel(role)));

      const nextRole = roles.includes(selectedRole) ? selectedRole : (roles[0] || '');
      roleSelect.value = nextRole;
      updateModelFormHelp(nextRole);
      return nextRole;
    }

    function syncModelOptions(role, selectedModel) {
      const options = getModelOptionsForRole(role);
      clearNode(modelSelect);
      options.forEach((model) => appendSelectOption(modelSelect, model, formatModelOptionLabel(role, model)));

      if (selectedModel && options.includes(selectedModel)) {
        modelSelect.value = selectedModel;
      } else if (options.length > 0) {
        modelSelect.value = options[0];
      }
    }

    function populateModelForm(role, model, focusInput) {
      const nextRole = syncRoleOptions(role || roleSelect.value);
      syncModelOptions(nextRole, model || '');
      if (!focusInput) return;
      modelSelect.focus();
    }

    function formatServicePill(summary) {
      const normalized = String(summary || '').toLowerCase();
      if (normalized.includes('active (running)')) return 'running';
      if (normalized.includes('activating')) return 'starting';
      if (normalized.includes('failed')) return 'failed';
      if (normalized.includes('inactive') || normalized.includes('dead')) return 'stopped';
      return String(summary || 'unknown');
    }

    function formatRuntimePill(overrides) {
      const parts = [];
      if (overrides.fastRuntime) parts.push('fast=' + overrides.fastRuntime);
      if (overrides.voiceRuntime) parts.push('voice=' + overrides.voiceRuntime);
      return parts.length > 0 ? parts.join(' | ') : 'defaults';
    }

    function renderSnapshot(snapshot) {
      const selectedRole = roleSelect.value || snapshot.modelRows[0] && snapshot.modelRows[0].role;
      const selectedModel = getSelectedModelValue();
      lastSnapshot = snapshot;

      clearNode(overviewMetrics);
      appendMetric(overviewMetrics, 'version', snapshot.version);
      appendMetric(overviewMetrics, 'build', snapshot.gitHash || '(not available)');
      appendMetric(overviewMetrics, 'install mode', snapshot.installMode);
      appendMetric(overviewMetrics, 'service', snapshot.serviceName);
      appendMetric(overviewMetrics, 'service state', snapshot.serviceSummary);
      appendMetric(overviewMetrics, 'config check', snapshot.doctorSummary);

      clearNode(modelsBody);
      snapshot.modelRows.forEach((row) => {
        const tr = document.createElement('tr');

        const roleCell = document.createElement('td');
        roleCell.title = row.role;
        const roleName = document.createElement('div');
        roleName.className = 'role-name';
        roleName.textContent = formatRoleLabel(row.role);
        const roleCopy = document.createElement('div');
        roleCopy.className = 'role-copy';
        roleCopy.textContent = getRoleHelp(row.role);
        roleCell.append(roleName, roleCopy);

        const effectiveCell = document.createElement('td');
        effectiveCell.textContent = row.effectiveModel;

        const sourceCell = document.createElement('td');
        sourceCell.textContent = formatSourceLabel(row.source);

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

      populateModelForm(selectedRole, selectedModel, false);
      heroServicePill.textContent = 'Service: ' + formatServicePill(snapshot.serviceSummary);
      heroRuntimePill.textContent = 'Runtime overrides: ' + formatRuntimePill(snapshot.runtimeOverrides);
      setStatus(serviceStatus, snapshot.serviceSummary, 'ok');
    }

    function renderDoctor(report, summary) {
      const findings = Array.isArray(report.findings) ? report.findings : [];
      const autoFixableCount = findings.filter((finding) => finding.autoFixable).length;
      const attentionFindings = findings.filter((finding) => finding.severity !== 'info');
      const cleanupFindings = findings.filter((finding) => finding.severity === 'info');

      doctorFixButton.disabled = autoFixableCount === 0;
      doctorFixButton.dataset.autoFixableCount = String(autoFixableCount);

      if (findings.length === 0) {
        doctorHelper.textContent = 'Nothing needs attention. Config looks clean.';
      } else if (autoFixableCount > 0) {
        doctorHelper.textContent = autoFixableCount + ' safe auto-fix'
          + (autoFixableCount === 1 ? ' is' : 'es are')
          + ' available. Review-only items will stay listed below.';
      } else if (attentionFindings.length === 0) {
        doctorHelper.textContent = 'These are cleanup suggestions only. Nothing here can be changed automatically.';
      } else {
        doctorHelper.textContent = 'Review the items below. None of them can be changed automatically.';
      }

      clearNode(doctorFindings);
      if (findings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No doctor findings.';
        doctorFindings.append(empty);
      } else {
        const renderSection = (title, sectionFindings) => {
          if (!sectionFindings.length) return;

          const section = document.createElement('div');
          section.className = 'finding-section';

          const heading = document.createElement('div');
          heading.className = 'finding-section-title';
          heading.textContent = title;
          section.append(heading);

          sectionFindings.forEach((finding) => {
          const wrapper = document.createElement('div');
          wrapper.className = 'finding';

          const header = document.createElement('div');
          header.className = 'finding-header';

          const meta = document.createElement('div');
          meta.className = 'finding-meta';

          const id = document.createElement('div');
          id.className = 'finding-id';
          id.textContent = finding.id;
          meta.append(id);

          const badges = document.createElement('div');
          badges.className = 'finding-badges';

          const severity = document.createElement('span');
          severity.className = 'finding-badge ' + finding.severity;
          severity.textContent = finding.severity === 'info'
            ? 'cleanup'
            : finding.severity === 'warn'
              ? 'review'
              : 'problem';
          badges.append(severity);

          const action = document.createElement('span');
          action.className = 'finding-badge ' + (finding.autoFixable ? 'fixable' : 'manual');
          action.textContent = finding.autoFixable
            ? 'safe auto-fix'
            : finding.severity === 'info'
              ? 'manual cleanup'
              : 'manual review';
          badges.append(action);

          header.append(meta, badges);

          const message = document.createElement('div');
          message.className = 'finding-body';
          message.textContent = finding.message;

          const recommendation = document.createElement('div');
          recommendation.className = 'finding-recommendation';
          recommendation.textContent = finding.recommendation || '';

          wrapper.append(header, message);
          if (finding.recommendation) wrapper.append(recommendation);
          section.append(wrapper);
          });

          doctorFindings.append(section);
        };

        renderSection('Needs attention', attentionFindings);
        renderSection('Cleanup suggestions', cleanupFindings);
      }

      const tone = findings.some((finding) => finding.severity === 'error')
        ? 'error'
        : findings.some((finding) => finding.severity === 'warn')
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
        setStatus(serviceStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
        setOutput(response.message);
      } catch (error) {
        const message = 'Restart requested. If the dashboard is embedded in the service, a connection drop is expected. Reload in a few seconds.';
        setStatus(serviceStatus, message, 'ok');
        setStatus(heroStatus, message, 'ok');
        setOutput(message);
      }
    });

    document.getElementById('doctor-btn').addEventListener('click', async () => {
      try {
        await refreshDoctor(false);
        setStatus(heroStatus, 'Doctor scan completed.', 'ok');
      } catch (error) {
        setStatus(doctorSummary, String(error), 'error');
      }
    });

    doctorFixButton.addEventListener('click', async () => {
      const autoFixableCount = Number(doctorFixButton.dataset.autoFixableCount || '0');
      if (autoFixableCount <= 0) return;
      if (!window.confirm('Apply ' + autoFixableCount + ' safe config fix' + (autoFixableCount === 1 ? '' : 'es') + '?')) return;
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
          'Applied safe fixes=' + response.result.applied.length + ' Remaining review-only=' + response.report.findings.length + ' Errors=' + response.result.errors.length,
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
            role: roleSelect.value,
            model: modelSelect.value,
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
        populateModelForm(lastSnapshot.modelRows[0] && lastSnapshot.modelRows[0].role, '', false);
      }
    }).catch((error) => {
      setStatus(heroStatus, String(error), 'error');
      setStatus(serviceStatus, String(error), 'error');
      setStatus(doctorSummary, String(error), 'error');
    });

    roleSelect.addEventListener('change', () => {
      syncModelOptions(roleSelect.value, '');
    });
  </script>
</body>
</html>`;
}
