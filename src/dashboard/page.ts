export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1114;
      --card: #1a1d21;
      --surface: #141619;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.14);
      --text: #e8eaed;
      --text-secondary: #9aa0a6;
      --green: #81c995;
      --amber: #fdd663;
      --red: #f28b82;
      --blue: #8ab4f8;
      --accent: #8ab4f8;
      --radius: 8px;
      --radius-sm: 6px;
      --mono: "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; }

    body {
      margin: 0;
      font-family: var(--sans);
      font-size: 14px;
      color: var(--text);
      background: var(--bg);
      padding: 16px;
    }

    button, input, select {
      font-family: var(--sans);
      font-size: 13px;
    }

    pre, code {
      font-family: var(--mono);
      font-size: 12px;
    }

    table {
      font-family: var(--mono);
      font-size: 13px;
    }

    summary {
      font-family: var(--sans);
      font-size: 13px;
    }

    h1, h2, h3, p { margin: 0; }

    .shell {
      width: min(1280px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 12px;
    }

    .hero,
    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
    }

    .hero {
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .hero-left {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .hero-title {
      font-family: var(--sans);
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
    }

    .hero-pills,
    .pill-row,
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .pill {
      padding: 3px 10px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-family: var(--mono);
      font-size: 12px;
    }

    .layout {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 12px;
    }

    .card {
      padding: 14px;
      display: grid;
      gap: 10px;
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
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    h2 {
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    h3 {
      font-family: var(--sans);
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .card-copy,
    .field-note,
    .helper {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.45;
    }

    .field-grid,
    .metrics,
    .checklist,
    .advanced-grid {
      display: grid;
      gap: 8px;
    }

    .field-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .metrics {
      grid-template-columns: 1fr;
      gap: 2px;
    }

    .metric {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 3px 0;
      min-width: 0;
    }

    .path-item {
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
      min-width: 0;
    }

    .checklist-item {
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
      min-width: 0;
      display: grid;
      gap: 6px;
    }

    .finding,
    .panel {
      padding: 12px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
      min-width: 0;
    }

    .metric-label,
    .field-label,
    .path-label,
    .finding-meta {
      color: var(--text-secondary);
      font-family: var(--sans);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .checklist-label {
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 500;
    }

    .metric-label {
      min-width: 100px;
      flex-shrink: 0;
    }

    .metric-value {
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }

    .path-value {
      margin-top: 2px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }

    .current-line {
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }

    .checklist {
      align-content: start;
    }

    .checklist-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .checklist-body {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.4;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-dot.ok { background: var(--green); }
    .status-dot.warn { background: var(--amber); }
    .status-dot.error { background: var(--red); }
    .status-dot.manual { background: var(--blue); }

    .current-lines {
      display: flex;
      gap: 4px 16px;
      flex-wrap: wrap;
    }

    .field {
      display: grid;
      gap: 4px;
      align-content: start;
    }

    button,
    input,
    select {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-strong);
      color: var(--text);
      background: var(--surface);
      padding: 7px 12px;
      min-height: 34px;
    }

    button {
      cursor: pointer;
      font-weight: 500;
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
      transition: opacity 100ms ease;
    }

    button:hover {
      opacity: 0.85;
    }

    button.secondary {
      background: transparent;
      color: var(--text-secondary);
      border-color: var(--border-strong);
    }

    button.secondary:hover {
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.24);
    }

    button.btn-danger {
      background: var(--red);
      color: var(--bg);
      border-color: var(--red);
    }

    button.btn-danger:hover {
      opacity: 0.85;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.3;
      background: var(--surface);
      color: var(--text-secondary);
      border-color: var(--border);
    }

    input,
    select {
      width: 100%;
      min-width: 0;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--accent);
    }

    .status {
      min-height: 1.2em;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }

    .status.ok { color: var(--green); }
    .status.warn { color: var(--amber); }
    .status.error { color: var(--red); }

    details {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
    }

    summary {
      cursor: pointer;
      padding: 8px 12px;
      color: var(--text-secondary);
    }

    details[open] summary {
      border-bottom: 1px solid var(--border);
    }

    .details-body {
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    pre {
      margin: 0;
      min-height: 140px;
      max-height: 300px;
      overflow: auto;
      border-radius: var(--radius-sm);
      padding: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    th {
      color: var(--text-secondary);
      font-family: var(--sans);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 500;
    }

    td {
      font-family: var(--mono);
      font-size: 13px;
    }

    .table-wrap {
      overflow: auto;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
    }

    .finding-list {
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .finding-section-title {
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .finding-group {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
    }

    .finding-group summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .finding-group-label {
      color: var(--text);
      font-size: 13px;
    }

    .finding-group-meta {
      color: var(--text-secondary);
      font-size: 12px;
    }

    .finding-group-body {
      padding: 0 12px 12px;
      display: grid;
      gap: 8px;
    }

    .finding-id {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-secondary);
      word-break: break-word;
    }

    .finding-message {
      font-size: 13px;
      line-height: 1.4;
      margin-top: 4px;
    }

    .finding-recommendation {
      color: var(--text-secondary);
      margin-top: 4px;
      font-size: 13px;
      line-height: 1.4;
    }

    .finding--compact {
      padding: 10px;
      border-radius: var(--radius-sm);
    }

    .finding--compact .finding-message,
    .finding--compact .finding-recommendation {
      margin-top: 3px;
      font-size: 13px;
      line-height: 1.4;
    }

    .advanced-grid {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }

    .settings-categories {
      display: grid;
      gap: 14px;
    }

    .settings-category-title {
      color: var(--text-secondary);
      font-family: var(--sans);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 2px;
    }

    .settings-rows {
      display: grid;
      gap: 0;
    }

    .setting-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }

    .setting-row:last-child {
      border-bottom: none;
    }

    .setting-label {
      flex: 1;
      font-family: var(--sans);
      font-size: 13px;
      color: var(--text);
      min-width: 0;
    }

    .setting-key {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-secondary);
      display: block;
    }

    .setting-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      accent-color: var(--accent);
      min-height: auto;
      padding: 0;
    }

    .setting-row input[type="number"] {
      width: 90px;
      flex-shrink: 0;
      text-align: right;
      padding: 4px 8px;
      min-height: 28px;
    }

    .empty {
      color: var(--text-secondary);
      padding: 4px 0;
    }

    .checklist-row {
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    }

    .chat-forms {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }

    .chat-forms form {
      display: grid;
      gap: 10px;
      align-content: start;
    }

    form .actions {
      margin-top: 2px;
    }

    .field-note {
      margin-top: -2px;
    }

    @media (max-width: 980px) {
      .span-4,
      .span-5,
      .span-6,
      .span-7,
      .span-8 {
        grid-column: span 12;
      }
      .chat-forms {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      body { padding: 12px; }
      .card { padding: 12px; }
      th, td { padding: 6px 8px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-left">
        <h1 class="hero-title">Discoclaw</h1>
        <div class="hero-pills">
          <div id="hero-service-pill" class="pill">Service: loading</div>
          <div id="hero-runtime-pill" class="pill">Chat: loading</div>
          <div id="hero-url-pill" class="pill">Dashboard: loading</div>
        </div>
      </div>
      <div class="actions">
        <div id="hero-status" class="status"></div>
        <button id="refresh-btn" class="secondary" type="button">Refresh</button>
      </div>
    </section>

    <section class="layout">
      <section class="card span-12">
        <div class="card-header">
          <div>
            <h2>Readiness</h2>
          </div>
        </div>
        <div id="checklist" class="checklist checklist-row"></div>
      </section>

      <section class="card span-12">
        <div class="card-header">
          <div>
            <h2>Chat Controls</h2>
          </div>
        </div>

        <div class="current-lines">
          <div id="chat-current-runtime" class="current-line">Runtime: loading</div>
          <div id="chat-current-model" class="current-line">Model: loading</div>
          <div id="chat-current-thinking" class="current-line">Thinking: loading</div>
        </div>

        <div class="chat-forms">
          <form id="chat-runtime-form">
            <div class="field-grid">
              <label class="field" for="chat-runtime-select">
                <span class="field-label">Chat Runtime</span>
                <select id="chat-runtime-select" name="runtime" required></select>
              </label>
            </div>
            <div class="actions">
              <button id="chat-runtime-submit-btn" type="submit">Apply Runtime</button>
              <button id="chat-auth-btn" class="secondary" type="button">Check Auth</button>
            </div>
          </form>

          <form id="chat-model-form">
            <div class="field-grid">
              <label class="field" for="chat-model-select">
                <span class="field-label">Chat Model / Profile</span>
                <select id="chat-model-select" name="model" required></select>
              </label>
            </div>
            <div class="field-note">Tier options double as the practical thinking profile on runtimes that support explicit effort.</div>
            <div class="actions">
              <button id="chat-model-submit-btn" type="submit">Apply Model</button>
            </div>
          </form>
        </div>

        <div id="chat-status" class="status"></div>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Service</h2>
          </div>
          <div class="actions">
            <button id="status-btn" class="secondary" type="button">Status</button>
            <button id="logs-btn" class="secondary" type="button">Logs</button>
            <button id="restart-btn" class="btn-danger" type="button">Restart</button>
          </div>
        </div>

        <div id="service-metrics" class="metrics"></div>
        <div id="service-status" class="status"></div>

        <details>
          <summary>Latest Raw Output</summary>
          <div class="details-body">
            <pre id="service-output">(no output)</pre>
          </div>
        </details>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Config Doctor</h2>
          </div>
          <div class="actions">
            <button id="doctor-btn" type="button">Scan</button>
            <button id="doctor-fix-btn" type="button" disabled>Apply Safe Fixes</button>
          </div>
        </div>
        <div id="doctor-summary" class="status"></div>
        <div id="doctor-helper" class="helper"></div>
        <div id="doctor-findings" class="finding-list"></div>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Image Generation</h2>
          </div>
        </div>

        <div class="current-lines">
          <div id="imagegen-current-provider" class="current-line">Provider: loading</div>
          <div id="imagegen-current-model" class="current-line">Model: loading</div>
        </div>

        <form id="imagegen-form">
          <div class="field-grid">
            <label class="field" for="imagegen-model-select">
              <span class="field-label">Imagegen Model</span>
              <select id="imagegen-model-select" name="model" required></select>
            </label>
          </div>
          <div class="actions">
            <button id="imagegen-submit-btn" type="submit">Save Default</button>
            <button id="imagegen-auth-btn" class="secondary" type="button">Check Auth</button>
            <button id="secret-toggle-btn" class="secondary" type="button">Add / Update Key</button>
          </div>
        </form>

        <details id="secret-panel">
          <summary>Credential Update</summary>
          <div class="details-body">
            <form id="secret-form">
              <div class="field-grid">
                <label class="field" for="secret-key-select">
                  <span class="field-label">Secret Key</span>
                  <select id="secret-key-select" name="key" required>
                    <option value="OPENAI_API_KEY">OPENAI_API_KEY</option>
                    <option value="OPENROUTER_API_KEY">OPENROUTER_API_KEY</option>
                    <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
                    <option value="IMAGEGEN_GEMINI_API_KEY">IMAGEGEN_GEMINI_API_KEY</option>
                  </select>
                </label>
                <label class="field" for="secret-value-input">
                  <span class="field-label">Secret Value</span>
                  <input id="secret-value-input" name="value" type="password" autocomplete="off" required />
                </label>
              </div>
              <div class="field-note">Values are written locally to .env and never echoed back. A restart is still required before the running bot uses a changed env var.</div>
              <div class="actions">
                <button id="secret-submit-btn" type="submit">Save Secret</button>
              </div>
            </form>
          </div>
        </details>

        <div id="imagegen-status" class="status"></div>
      </section>

      <section class="card span-6">
        <div class="card-header">
          <div>
            <h2>Install Snapshot</h2>
          </div>
        </div>
        <div id="overview-metrics" class="metrics"></div>
        <div id="mcp-summary" class="status"></div>
        <div id="mcp-servers" class="metrics"></div>
      </section>

      <section class="card span-12">
        <div class="card-header">
          <div>
            <h2>Settings</h2>
          </div>
        </div>
        <details>
          <summary>Open Settings</summary>
          <div class="details-body">
            <div id="settings-container" class="settings-categories"></div>
            <div id="settings-status" class="status"></div>
          </div>
        </details>
      </section>

      <section class="card span-12">
        <div class="card-header">
          <div>
            <h2>Observability</h2>
          </div>
          <div class="actions">
            <button id="traces-btn" class="secondary" type="button">Refresh Traces</button>
          </div>
        </div>
        <div id="traces-summary" class="metrics"></div>
        <details>
          <summary>Recent Traces</summary>
          <div class="details-body">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Flow</th>
                    <th>Outcome</th>
                    <th>Duration</th>
                    <th>Started</th>
                    <th>Events</th>
                  </tr>
                </thead>
                <tbody id="traces-body"></tbody>
              </table>
            </div>
          </div>
        </details>
        <details>
          <summary>Recent Errors</summary>
          <div class="details-body">
            <div id="traces-errors" class="checklist"></div>
          </div>
        </details>
        <div id="traces-status" class="status"></div>
      </section>

      <section class="card span-12">
        <div class="card-header">
          <div>
            <h2>Advanced</h2>
          </div>
        </div>
        <details>
          <summary>Open Advanced Controls</summary>
          <div class="details-body">
            <div class="advanced-grid">
              <section class="panel">
                <h3>Secondary Roles</h3>
                <p class="field-note">Voice, forge, cron, and other non-primary model assignments.</p>
                <form id="model-form">
                  <div class="field-grid">
                    <label class="field" for="role-select">
                      <span class="field-label">Role</span>
                      <select id="role-select" name="role" required></select>
                    </label>
                    <label class="field" for="model-select">
                      <span class="field-label">Saved Option</span>
                      <select id="model-select" name="model" required></select>
                    </label>
                  </div>
                  <div id="model-form-help" class="field-note">Choose a role to load its valid saved options.</div>
                  <div class="actions">
                    <button id="model-submit-btn" type="submit">Save Secondary Role</button>
                  </div>
                </form>
                <div id="model-status" class="status"></div>
              </section>

              <section class="panel">
                <h3>Runtime Preset</h3>
                <p class="field-note">Heavy-handed reset for when you want to swap the baseline runtime and clear the saved model stack.</p>
                <div class="field-grid">
                  <label class="field" for="preset-select">
                    <span class="field-label">Runtime Preset</span>
                    <select id="preset-select">
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>
                </div>
                <div class="actions">
                  <button id="preset-apply-btn" type="button">Apply Preset</button>
                </div>
                <div id="preset-status" class="status"></div>
              </section>

              <section class="panel">
                <h3>Current Models</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Using</th>
                        <th>Saved</th>
                      </tr>
                    </thead>
                    <tbody id="models-body"></tbody>
                  </table>
                </div>
              </section>

              <section class="panel">
                <h3>Config Paths</h3>
                <div id="config-paths" class="checklist"></div>
              </section>
            </div>
          </div>
        </details>
      </section>
    </section>
  </main>

  <script>
    const overviewMetrics = document.getElementById('overview-metrics');
    const checklist = document.getElementById('checklist');
    const modelsBody = document.getElementById('models-body');
    const configPaths = document.getElementById('config-paths');
    const serviceMetrics = document.getElementById('service-metrics');
    const serviceOutput = document.getElementById('service-output');
    const heroStatus = document.getElementById('hero-status');
    const heroServicePill = document.getElementById('hero-service-pill');
    const heroRuntimePill = document.getElementById('hero-runtime-pill');
    const heroUrlPill = document.getElementById('hero-url-pill');
    const serviceStatus = document.getElementById('service-status');
    const doctorSummary = document.getElementById('doctor-summary');
    const doctorHelper = document.getElementById('doctor-helper');
    const doctorFindings = document.getElementById('doctor-findings');
    const doctorFixButton = document.getElementById('doctor-fix-btn');
    const modelStatus = document.getElementById('model-status');
    const modelFormHelp = document.getElementById('model-form-help');
    const roleSelect = document.getElementById('role-select');
    const modelSelect = document.getElementById('model-select');
    const presetSelect = document.getElementById('preset-select');
    const presetStatus = document.getElementById('preset-status');
    const mcpSummary = document.getElementById('mcp-summary');
    const mcpServers = document.getElementById('mcp-servers');
    const chatRuntimeSelect = document.getElementById('chat-runtime-select');
    const chatModelSelect = document.getElementById('chat-model-select');
    const chatStatus = document.getElementById('chat-status');
    const chatCurrentRuntime = document.getElementById('chat-current-runtime');
    const chatCurrentModel = document.getElementById('chat-current-model');
    const chatCurrentThinking = document.getElementById('chat-current-thinking');
    const imagegenModelSelect = document.getElementById('imagegen-model-select');
    const imagegenStatus = document.getElementById('imagegen-status');
    const imagegenCurrentProvider = document.getElementById('imagegen-current-provider');
    const imagegenCurrentModel = document.getElementById('imagegen-current-model');
    const secretPanel = document.getElementById('secret-panel');
    const secretKeySelect = document.getElementById('secret-key-select');
    const secretValueInput = document.getElementById('secret-value-input');
    const settingsContainer = document.getElementById('settings-container');
    const settingsStatus = document.getElementById('settings-status');
    const tracesSummary = document.getElementById('traces-summary');
    const tracesBody = document.getElementById('traces-body');
    const tracesErrors = document.getElementById('traces-errors');
    const tracesStatus = document.getElementById('traces-status');
    const ROLE_LABELS = {
      chat: 'Chat',
      'plan-run': 'Plan Run',
      fast: 'Quick Tasks',
      summary: 'Summaries',
      cron: 'Automation Planning',
      'cron-exec': 'Automation Runs',
      voice: 'Voice Replies',
      imagegen: 'Image Generation',
      'forge-drafter': 'Forge Drafting',
      'forge-auditor': 'Forge Review'
    };
    const ROLE_HELP = {
      chat: 'Main Discord replies.',
      'plan-run': 'Plan execution phases.',
      fast: 'Quick helper work like tagging and lightweight jobs.',
      summary: 'Conversation summaries and memory rollups.',
      cron: 'Automation planning and classification.',
      'cron-exec': 'Scheduled automation runs.',
      voice: 'Voice conversations and spoken replies.',
      imagegen: 'Default model for image generation.',
      'forge-drafter': 'Forge drafting passes.',
      'forge-auditor': 'Forge review passes.'
    };

    let lastSnapshot = null;

    function updateDashboardLocation() {
      const dashboardUrl = window.location.href;
      document.title = 'Dashboard \u00b7 ' + dashboardUrl;
      if (heroUrlPill) heroUrlPill.textContent = 'Dashboard: ' + dashboardUrl;
    }

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
      node.className = 'status' + (tone ? ' ' + tone : '');
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

    function appendSelectOption(select, value, label) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
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

    function getSnapshotRoles(snapshot) {
      if (Array.isArray(snapshot.roles) && snapshot.roles.length > 0) {
        return snapshot.roles;
      }
      return Array.isArray(snapshot.modelRows)
        ? snapshot.modelRows.map(function (row) { return row.role; })
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

    function updateModelFormHelp(role) {
      if (!modelFormHelp) return;
      modelFormHelp.textContent = role
        ? getRoleHelp(role) + ' Choose one of the valid saved options below.'
        : 'Choose a role to load its valid saved options.';
    }

    function syncSecondaryRoleOptions(selectedRole) {
      if (!lastSnapshot) return '';
      const roles = getSnapshotRoles(lastSnapshot).filter(function (role) {
        return role !== 'chat' && role !== 'imagegen';
      });
      clearNode(roleSelect);
      roles.forEach(function (role) {
        appendSelectOption(roleSelect, role, formatRoleLabel(role));
      });

      const nextRole = roles.indexOf(selectedRole) >= 0 ? selectedRole : (roles[0] || '');
      roleSelect.value = nextRole;
      updateModelFormHelp(nextRole);
      return nextRole;
    }

    function syncSecondaryModelOptions(role, selectedModel) {
      const options = getModelOptionsForRole(role);
      clearNode(modelSelect);
      options.forEach(function (model) {
        appendSelectOption(modelSelect, model, formatModelOptionLabel(role, model));
      });

      if (selectedModel && options.indexOf(selectedModel) >= 0) {
        modelSelect.value = selectedModel;
      } else if (options.length > 0) {
        modelSelect.value = options[0];
      }
    }

    function populateSecondaryRoleForm(role, model) {
      const nextRole = syncSecondaryRoleOptions(role || roleSelect.value);
      syncSecondaryModelOptions(nextRole, model || '');
    }

    function formatServicePill(summary) {
      const normalized = String(summary || '').toLowerCase();
      if (normalized.indexOf('active (running)') >= 0) return 'running';
      if (normalized.indexOf('activating') >= 0) return 'starting';
      if (normalized.indexOf('failed') >= 0) return 'failed';
      if (normalized.indexOf('inactive') >= 0 || normalized.indexOf('dead') >= 0) return 'stopped';
      return String(summary || 'unknown');
    }

    function setOutput(message) {
      serviceOutput.textContent = message || '(no output)';
    }

    function renderChecklist(items) {
      clearNode(checklist);
      if (!Array.isArray(items) || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No checklist items.';
        checklist.append(empty);
        return;
      }

      items.forEach(function (item) {
        const wrapper = document.createElement('div');
        wrapper.className = 'checklist-item';

        const top = document.createElement('div');
        top.className = 'checklist-top';

        const dot = document.createElement('div');
        dot.className = 'status-dot ' + item.status;

        const label = document.createElement('div');
        label.className = 'checklist-label';
        label.textContent = item.label;

        top.append(dot, label);

        const body = document.createElement('div');
        body.className = 'checklist-body';
        body.textContent = item.description;

        wrapper.append(top, body);
        checklist.append(wrapper);
      });
    }

    function renderMcpStatus(snapshot) {
      clearNode(mcpServers);

      if (!snapshot.mcpStatus) {
        setStatus(mcpSummary, 'MCP status unavailable.', '');
        return;
      }

      switch (snapshot.mcpStatus.status) {
        case 'found': {
          const servers = Array.isArray(snapshot.mcpStatus.servers) ? snapshot.mcpStatus.servers : [];
          setStatus(
            mcpSummary,
            servers.length + ' server' + (servers.length === 1 ? '' : 's') + ' configured. ' + (snapshot.mcpWarnings || 0) + ' warning' + ((snapshot.mcpWarnings || 0) === 1 ? '' : 's') + '.',
            (snapshot.mcpWarnings || 0) > 0 ? 'warn' : 'ok'
          );
          if (servers.length === 0) return;
          servers.forEach(function (server) {
            appendMetric(mcpServers, server.name, server.type === 'url' ? 'URL server' : 'stdio server');
          });
          return;
        }
        case 'missing':
          setStatus(mcpSummary, 'MCP not configured.', '');
          return;
        case 'invalid':
          setStatus(mcpSummary, 'Invalid MCP config: ' + snapshot.mcpStatus.reason, 'warn');
          return;
      }
    }

    function renderOverview(snapshot) {
      clearNode(overviewMetrics);
      appendMetric(overviewMetrics, 'version', snapshot.version);
      appendMetric(overviewMetrics, 'build', snapshot.gitHash || '(not available)');
      appendMetric(overviewMetrics, 'install mode', snapshot.installMode);
      appendMetric(overviewMetrics, 'service', snapshot.serviceName);
      appendMetric(overviewMetrics, 'doctor', snapshot.doctorSummary);
      appendMetric(overviewMetrics, 'dashboard runtime', snapshot.live.chatRuntime || snapshot.primaryRuntime);
    }

    function renderServiceMetrics(snapshot) {
      clearNode(serviceMetrics);
      appendMetric(serviceMetrics, 'unit', snapshot.serviceName || 'discoclaw');
      appendMetric(serviceMetrics, 'status', snapshot.serviceSummary);
      appendMetric(serviceMetrics, 'start on boot', snapshot.serviceEnabled === true ? 'enabled' : snapshot.serviceEnabled === false ? 'disabled' : 'unknown');
      appendMetric(serviceMetrics, 'pending restart', snapshot.live.pendingRestart ? 'yes' : 'no');
    }

    function renderModelsTable(snapshot) {
      clearNode(modelsBody);
      snapshot.modelRows.forEach(function (row) {
        const tr = document.createElement('tr');

        const roleCell = document.createElement('td');
        roleCell.textContent = formatRoleLabel(row.role);

        const effectiveCell = document.createElement('td');
        effectiveCell.textContent = row.effectiveModel;

        const overrideCell = document.createElement('td');
        overrideCell.textContent = row.overrideValue || 'Startup default';

        tr.append(roleCell, effectiveCell, overrideCell);
        modelsBody.append(tr);
      });
    }

    function renderConfigPaths(snapshot) {
      clearNode(configPaths);
      Object.entries(snapshot.configPaths).forEach(function (entry) {
        appendPath(configPaths, entry[0], String(entry[1]));
      });
    }

    function renderChatControls(snapshot) {
      const live = snapshot.live;
      clearNode(chatRuntimeSelect);
      (live.availableRuntimes || []).forEach(function (runtime) {
        appendSelectOption(chatRuntimeSelect, runtime, runtime);
      });
      if (chatRuntimeSelect.options.length === 0) {
        appendSelectOption(chatRuntimeSelect, snapshot.primaryRuntime, snapshot.primaryRuntime);
      }
      chatRuntimeSelect.value = live.chatRuntime || snapshot.primaryRuntime;

      clearNode(chatModelSelect);
      (snapshot.modelOptions.chat || []).forEach(function (model) {
        appendSelectOption(chatModelSelect, model, formatModelOptionLabel('chat', model));
      });
      if ((snapshot.modelOptions.chat || []).indexOf(live.chatModel) >= 0) {
        chatModelSelect.value = live.chatModel;
      } else if (chatModelSelect.options.length > 0) {
        chatModelSelect.value = chatModelSelect.options[0].value;
      }

      chatCurrentRuntime.textContent = 'Runtime: ' + (live.chatRuntime || snapshot.primaryRuntime);
      chatCurrentModel.textContent = 'Model: ' + (live.chatModel || '(unset)');
      chatCurrentThinking.textContent = 'Thinking: ' + (live.chatThinking || 'follows model/runtime');
    }

    function recommendSecretKey(snapshot) {
      if (snapshot.live.imagegenProvider === 'gemini') return 'IMAGEGEN_GEMINI_API_KEY';
      if (snapshot.live.chatRuntime === 'openrouter') return 'OPENROUTER_API_KEY';
      if (snapshot.live.chatRuntime === 'anthropic') return 'ANTHROPIC_API_KEY';
      return 'OPENAI_API_KEY';
    }

    function renderImagegen(snapshot) {
      const live = snapshot.live;
      clearNode(imagegenModelSelect);
      (live.imagegenOptions || []).forEach(function (model) {
        appendSelectOption(imagegenModelSelect, model, formatModelOptionLabel('imagegen', model));
      });
      if ((live.imagegenOptions || []).indexOf(live.imagegenModel) >= 0) {
        imagegenModelSelect.value = live.imagegenModel;
      } else if (imagegenModelSelect.options.length > 0) {
        imagegenModelSelect.value = imagegenModelSelect.options[0].value;
      }

      imagegenCurrentProvider.textContent = 'Provider: ' + (live.imagegenProvider || 'not configured');
      imagegenCurrentModel.textContent = 'Model: ' + (live.imagegenModel || 'not configured');
      secretKeySelect.value = recommendSecretKey(snapshot);
    }

    function renderTraces(data) {
      var summary = data.summary || {};
      var recentTraces = data.recentTraces || [];
      var byFlow = summary.byFlow || {};
      clearNode(tracesSummary);
      appendMetric(tracesSummary, 'total traces', String(summary.total || 0));
      appendMetric(tracesSummary, 'in progress', String(summary.inProgress || 0));
      var flows = ['message', 'reaction', 'cron', 'defer'];
      flows.forEach(function (flow) {
        var fs = byFlow[flow];
        if (!fs || fs.total === 0) return;
        var avg = fs.avgDurationMs > 0 ? ' avg ' + fs.avgDurationMs + 'ms' : '';
        appendMetric(tracesSummary, flow, fs.succeeded + ' ok / ' + fs.failed + ' err / ' + fs.inProgress + ' running' + avg);
      });

      clearNode(tracesBody);
      recentTraces.forEach(function (trace) {
        var tr = document.createElement('tr');
        var flowCell = document.createElement('td');
        flowCell.textContent = trace.flow;
        var outcomeCell = document.createElement('td');
        outcomeCell.textContent = trace.outcome;
        if (trace.outcome === 'success') outcomeCell.style.color = 'var(--green)';
        else if (trace.outcome === 'in_progress') outcomeCell.style.color = 'var(--amber)';
        else if (trace.outcome !== 'success') outcomeCell.style.color = 'var(--red)';
        var durationCell = document.createElement('td');
        durationCell.textContent = trace.outcome === 'in_progress' ? '\u2014' : trace.durationMs + 'ms';
        var startedCell = document.createElement('td');
        startedCell.textContent = new Date(trace.startedAt).toLocaleTimeString();
        var eventsCell = document.createElement('td');
        eventsCell.textContent = String((trace.events || []).length);
        tr.append(flowCell, outcomeCell, durationCell, startedCell, eventsCell);
        tracesBody.append(tr);
      });

      clearNode(tracesErrors);
      var recentErrors = summary.recentErrors || [];
      if (recentErrors.length === 0) {
        var noErrors = document.createElement('div');
        noErrors.className = 'card-copy';
        noErrors.textContent = 'No recent errors.';
        tracesErrors.append(noErrors);
      } else {
        recentErrors.forEach(function (err) {
          var item = document.createElement('div');
          item.className = 'checklist-item';
          var top = document.createElement('div');
          top.className = 'checklist-top';
          var dot = document.createElement('div');
          dot.className = 'status-dot error';
          var label = document.createElement('div');
          label.className = 'checklist-label';
          label.textContent = err.flow + ': ' + err.message;
          top.append(dot, label);
          var body = document.createElement('div');
          body.className = 'checklist-body';
          body.textContent = new Date(err.at).toLocaleString();
          item.append(top, body);
          tracesErrors.append(item);
        });
      }
    }

    async function refreshTraces() {
      var response = await fetchJson('/api/traces');
      renderTraces(response);
    }

    function renderSnapshot(snapshot) {
      if (!snapshot.live) snapshot.live = {};
      const selectedRole = roleSelect.value;
      const selectedModel = getSelectedModelValue();
      lastSnapshot = snapshot;

      renderChecklist(snapshot.readinessChecklist || []);
      renderOverview(snapshot);
      renderServiceMetrics(snapshot);
      renderMcpStatus(snapshot);
      renderModelsTable(snapshot);
      renderConfigPaths(snapshot);
      renderChatControls(snapshot);
      renderImagegen(snapshot);

      populateSecondaryRoleForm(selectedRole, selectedModel);
      presetSelect.value = snapshot.primaryRuntime || 'claude';
      heroServicePill.textContent = 'Service: ' + formatServicePill(snapshot.serviceSummary);
      heroRuntimePill.textContent = 'Chat: ' + (snapshot.live.chatRuntime || snapshot.primaryRuntime) + ' / ' + (snapshot.live.chatModel || '(unset)');
      updateDashboardLocation();
    }

    function createFindingNode(finding, compact) {
      const wrapper = document.createElement('div');
      wrapper.className = compact ? 'finding finding--compact' : 'finding';

      const id = document.createElement('div');
      id.className = 'finding-id';
      id.textContent = finding.id + ' [' + finding.severity + (finding.autoFixable ? ', auto-fix' : '') + ']';

      const message = document.createElement('div');
      message.className = 'finding-message';
      message.textContent = finding.message;

      wrapper.append(id, message);
      if (finding.recommendation) {
        const recommendation = document.createElement('div');
        recommendation.className = 'finding-recommendation';
        recommendation.textContent = finding.recommendation;
        wrapper.append(recommendation);
      }

      return wrapper;
    }

    function renderDoctor(report, summary) {
      const findings = Array.isArray(report.findings) ? report.findings : [];
      const criticalFindings = findings.filter(function (finding) { return finding.severity === 'error'; });
      const advisoryFindings = findings.filter(function (finding) { return finding.severity !== 'error'; });
      const autoFixableCount = findings.filter(function (finding) { return finding.autoFixable; }).length;
      const advisorySummary = advisoryFindings.length > 0
        ? ' ' + advisoryFindings.length + ' advisory item' + (advisoryFindings.length === 1 ? '' : 's') + ' collapsed below.'
        : '';
      doctorFixButton.disabled = autoFixableCount === 0;
      doctorFixButton.dataset.autoFixableCount = String(autoFixableCount);

      if (findings.length === 0) {
        doctorHelper.textContent = 'Nothing needs attention. Config looks clean.';
      } else if (criticalFindings.length > 0) {
        doctorHelper.textContent =
          criticalFindings.length + ' critical issue' + (criticalFindings.length === 1 ? '' : 's') +
          ' visible.' +
          advisorySummary +
          (autoFixableCount > 0
            ? ' ' + autoFixableCount + ' safe auto-fix' + (autoFixableCount === 1 ? '' : 'es') + ' available.'
            : '');
      } else if (autoFixableCount > 0) {
        doctorHelper.textContent =
          advisoryFindings.length + ' advisory item' + (advisoryFindings.length === 1 ? '' : 's') +
          ' collapsed below. ' +
          autoFixableCount + ' safe auto-fix' + (autoFixableCount === 1 ? '' : 'es') + ' available.';
      } else {
        doctorHelper.textContent = advisoryFindings.length + ' advisory item' + (advisoryFindings.length === 1 ? '' : 's') + ' collapsed below.';
      }

      clearNode(doctorFindings);
      if (findings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No doctor findings.';
        doctorFindings.append(empty);
      } else {
        if (criticalFindings.length > 0) {
          const criticalTitle = document.createElement('div');
          criticalTitle.className = 'finding-section-title';
          criticalTitle.textContent = 'Critical Findings';
          doctorFindings.append(criticalTitle);

          criticalFindings.forEach(function (finding) {
            doctorFindings.append(createFindingNode(finding, false));
          });
        }

        if (advisoryFindings.length > 0) {
          const advisoryGroup = document.createElement('details');
          advisoryGroup.className = 'finding-group';

          const advisorySummary = document.createElement('summary');
          const advisoryLabel = document.createElement('span');
          advisoryLabel.className = 'finding-group-label';
          advisoryLabel.textContent = 'Warnings & Advisories (' + advisoryFindings.length + ')';

          const advisoryMeta = document.createElement('span');
          advisoryMeta.className = 'finding-group-meta';
          advisoryMeta.textContent = 'Non-critical findings collapsed by default.';

          advisorySummary.append(advisoryLabel, advisoryMeta);
          advisoryGroup.append(advisorySummary);

          const advisoryBody = document.createElement('div');
          advisoryBody.className = 'finding-group-body';
          advisoryFindings.forEach(function (finding) {
            advisoryBody.append(createFindingNode(finding, true));
          });
          advisoryGroup.append(advisoryBody);

          doctorFindings.append(advisoryGroup);
        }
      }

      const tone = findings.some(function (finding) { return finding.severity === 'error'; })
        ? 'error'
        : findings.some(function (finding) { return finding.severity === 'warn'; })
          ? 'warn'
          : 'ok';
      setStatus(doctorSummary, summary, tone);
    }

    function renderSettings(data) {
      clearNode(settingsContainer);
      if (!data || !data.categories) {
        settingsContainer.textContent = 'No settings data.';
        return;
      }
      var categories = data.categories;
      Object.keys(categories).forEach(function (catName) {
        var catTitle = document.createElement('div');
        catTitle.className = 'settings-category-title';
        catTitle.textContent = catName;
        settingsContainer.append(catTitle);

        var rows = document.createElement('div');
        rows.className = 'settings-rows';

        categories[catName].forEach(function (setting) {
          var row = document.createElement('div');
          row.className = 'setting-row';

          var label = document.createElement('div');
          label.className = 'setting-label';
          label.textContent = setting.label;
          var keySpan = document.createElement('span');
          keySpan.className = 'setting-key';
          keySpan.textContent = setting.key;
          label.append(keySpan);

          row.append(label);

          if (setting.type === 'boolean') {
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.settingKey = setting.key;
            var raw = setting.value;
            if (raw === undefined || raw === null || raw === '') {
              cb.checked = !!setting.default;
            } else {
              cb.checked = raw === 'true' || raw === '1';
            }
            row.append(cb);
          } else {
            var num = document.createElement('input');
            num.type = 'number';
            num.min = '0';
            num.dataset.settingKey = setting.key;
            var rawVal = setting.value;
            if (rawVal === undefined || rawVal === null || rawVal === '') {
              num.value = String(setting.default);
            } else {
              num.value = rawVal;
            }
            row.append(num);
          }

          rows.append(row);
        });

        settingsContainer.append(rows);
      });
    }

    async function postSetting(key, value) {
      try {
        var response = await fetchJson('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key, value: value })
        });
        renderSettings(response);
        setStatus(settingsStatus, response.message, 'ok');
      } catch (error) {
        setStatus(settingsStatus, String(error), 'error');
      }
    }

    settingsContainer.addEventListener('change', function (event) {
      var target = event.target;
      if (target.tagName !== 'INPUT') return;
      var key = target.dataset.settingKey;
      if (!key) return;
      if (target.type === 'checkbox') {
        postSetting(key, target.checked ? 'true' : 'false');
      }
    });

    settingsContainer.addEventListener('blur', function (event) {
      var target = event.target;
      if (target.tagName !== 'INPUT' || target.type !== 'number') return;
      var key = target.dataset.settingKey;
      if (!key) return;
      postSetting(key, target.value);
    }, true);

    async function loadSettings() {
      try {
        var response = await fetchJson('/api/settings');
        renderSettings(response);
      } catch (error) {
        setStatus(settingsStatus, String(error), 'error');
      }
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

    async function runAuthCheck(target, node) {
      const response = await fetchJson('/api/auth-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target })
      });
      setStatus(node, response.message, response.status === 'error' ? 'error' : response.status === 'warn' ? 'warn' : 'ok');
      return response;
    }

    document.getElementById('refresh-btn').addEventListener('click', async function () {
      try {
        await Promise.all([refreshSnapshot(false), refreshDoctor(false), refreshTraces()]);
        setStatus(heroStatus, 'Dashboard refreshed.', 'ok');
      } catch (error) {
        setStatus(heroStatus, String(error), 'error');
      }
    });

    document.getElementById('traces-btn').addEventListener('click', async function () {
      try {
        await refreshTraces();
        setStatus(tracesStatus, 'Traces refreshed.', 'ok');
      } catch (error) {
        setStatus(tracesStatus, String(error), 'error');
      }
    });

    document.getElementById('status-btn').addEventListener('click', async function () {
      try {
        const response = await fetchJson('/api/status');
        setOutput(response.result.stdout || response.result.stderr || '(no output)');
        setStatus(serviceStatus, response.summary, 'ok');
      } catch (error) {
        setStatus(serviceStatus, String(error), 'error');
      }
    });

    document.getElementById('logs-btn').addEventListener('click', async function () {
      try {
        const response = await fetchJson('/api/logs');
        setOutput(response.result.stdout || response.result.stderr || '(no output)');
        setStatus(serviceStatus, response.summary, 'ok');
      } catch (error) {
        setStatus(serviceStatus, String(error), 'error');
      }
    });

    document.getElementById('restart-btn').addEventListener('click', async function () {
      if (!window.confirm('Restart the local Discoclaw service?')) return;
      try {
        const response = await fetchJson('/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        });
        setStatus(serviceStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
        setOutput(response.message);
      } catch (error) {
        const message = 'Restart requested. If the dashboard disconnects, reload in a few seconds.';
        setStatus(serviceStatus, message, 'ok');
        setStatus(heroStatus, message, 'ok');
        setOutput(message);
      }
    });

    document.getElementById('doctor-btn').addEventListener('click', async function () {
      try {
        await refreshDoctor(false);
        setStatus(heroStatus, 'Doctor scan completed.', 'ok');
      } catch (error) {
        setStatus(doctorSummary, String(error), 'error');
      }
    });

    doctorFixButton.addEventListener('click', async function () {
      const autoFixableCount = Number(doctorFixButton.dataset.autoFixableCount || '0');
      if (autoFixableCount <= 0) return;
      if (!window.confirm('Apply ' + autoFixableCount + ' safe config fix' + (autoFixableCount === 1 ? '' : 'es') + '?')) return;
      try {
        const response = await fetchJson('/api/doctor/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        renderSnapshot(response.snapshot);
        renderDoctor(response.report, response.summary);
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(doctorSummary, String(error), 'error');
      }
    });

    document.getElementById('chat-runtime-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/live-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'chat', model: chatRuntimeSelect.value })
        });
        renderSnapshot(response.snapshot);
        setStatus(chatStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(chatStatus, String(error), 'error');
      }
    });

    document.getElementById('chat-model-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/live-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'chat', model: chatModelSelect.value })
        });
        renderSnapshot(response.snapshot);
        setStatus(chatStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(chatStatus, String(error), 'error');
      }
    });

    document.getElementById('chat-auth-btn').addEventListener('click', async function () {
      try {
        await runAuthCheck('chat', chatStatus);
      } catch (error) {
        setStatus(chatStatus, String(error), 'error');
      }
    });

    document.getElementById('imagegen-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/live-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'imagegen', model: imagegenModelSelect.value })
        });
        renderSnapshot(response.snapshot);
        setStatus(imagegenStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(imagegenStatus, String(error), 'error');
      }
    });

    document.getElementById('imagegen-auth-btn').addEventListener('click', async function () {
      try {
        await runAuthCheck('imagegen', imagegenStatus);
      } catch (error) {
        setStatus(imagegenStatus, String(error), 'error');
      }
    });

    document.getElementById('secret-toggle-btn').addEventListener('click', function () {
      secretPanel.open = !secretPanel.open;
      if (secretPanel.open) {
        secretValueInput.focus();
      }
    });

    document.getElementById('secret-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/secret', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: secretKeySelect.value, value: secretValueInput.value })
        });
        secretValueInput.value = '';
        renderSnapshot(response.snapshot);
        setStatus(imagegenStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(imagegenStatus, String(error), 'error');
      }
    });

    document.getElementById('model-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        const response = await fetchJson('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: roleSelect.value, model: modelSelect.value })
        });
        renderSnapshot(response.snapshot);
        setStatus(modelStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(modelStatus, String(error), 'error');
      }
    });

    document.getElementById('preset-apply-btn').addEventListener('click', async function () {
      const preset = presetSelect.value;
      if (!window.confirm(
        'Switch runtime preset to ' + preset + '?\\n\\n'
        + 'This will set PRIMARY_RUNTIME in .env and clear saved defaults back to baseline.\\n'
        + 'You will need to restart the service for changes to take effect.'
      )) return;
      try {
        const response = await fetchJson('/api/preset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset: preset })
        });
        renderSnapshot(response.snapshot);
        setStatus(presetStatus, response.message, 'ok');
        setStatus(heroStatus, response.message, 'ok');
      } catch (error) {
        setStatus(presetStatus, String(error), 'error');
      }
    });

    roleSelect.addEventListener('change', function () {
      syncSecondaryModelOptions(roleSelect.value, '');
    });

    Promise.all([refreshSnapshot(false), refreshDoctor(false), loadSettings(), refreshTraces()]).then(function () {
      setStatus(heroStatus, 'Dashboard ready.', 'ok');
      if (lastSnapshot) {
        populateSecondaryRoleForm('', '');
      }
    }).catch(function (error) {
      setStatus(heroStatus, String(error), 'error');
      setStatus(serviceStatus, String(error), 'error');
      setStatus(doctorSummary, String(error), 'error');
      setStatus(chatStatus, String(error), 'error');
      setStatus(imagegenStatus, String(error), 'error');
    });

    updateDashboardLocation();
  </script>
</body>
</html>`;
}
