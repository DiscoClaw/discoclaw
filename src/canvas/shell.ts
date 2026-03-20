function escapeForHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeInlineScriptJson(input: unknown): string {
  return JSON.stringify(input).replaceAll('<', '\\u003c');
}

export function renderCanvasShellHtml(opts: {
  nonce: string;
  discordClientId: string;
  writeBridgeEnabled: boolean;
  defaultLandingMessage: string;
  authMode?: 'oauth' | 'preauth';
}): string {
  const config = escapeInlineScriptJson({
    clientId: opts.discordClientId,
    writeBridgeEnabled: opts.writeBridgeEnabled,
    defaultLandingMessage: opts.defaultLandingMessage,
    authMode: opts.authMode ?? 'oauth',
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Discoclaw Canvas</title>
    <style nonce="${opts.nonce}">
      :root {
        --bg: #111827;
        --panel: rgba(17, 24, 39, 0.92);
        --panel-border: rgba(148, 163, 184, 0.22);
        --text: #f8fafc;
        --muted: #cbd5e1;
        --accent: #38bdf8;
        --danger: #fca5a5;
        --safe-top: env(safe-area-inset-top, 0px);
        --safe-right: env(safe-area-inset-right, 0px);
        --safe-bottom: env(safe-area-inset-bottom, 0px);
        --safe-left: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 35%),
          linear-gradient(180deg, #0f172a 0%, #111827 48%, #0b1220 100%);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        min-height: 100vh;
        padding:
          calc(12px + var(--safe-top))
          calc(12px + var(--safe-right))
          calc(12px + var(--safe-bottom))
          calc(12px + var(--safe-left));
      }
      .shell {
        min-height: calc(100vh - var(--safe-top) - var(--safe-bottom) - 24px);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 18px;
        backdrop-filter: blur(20px);
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.35);
      }
      .header {
        padding: 14px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .status {
        font-size: 13px;
        color: var(--muted);
      }
      .status.error { color: var(--danger); }
      .viewport {
        flex: 1;
        min-height: 320px;
        overflow: hidden;
      }
      .viewport-frame {
        width: 100%;
        min-height: calc(100vh - 140px);
        border: 0;
        background: white;
        border-radius: 18px;
      }
      .landing {
        min-height: calc(100vh - 140px);
        display: grid;
        place-items: center;
        padding: 20px;
      }
      .landing-inner {
        max-width: 560px;
        text-align: center;
      }
      .landing h1 {
        margin: 0 0 8px;
        font-size: clamp(28px, 6vw, 44px);
      }
      .landing p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
        white-space: pre-wrap;
      }
      .toast {
        position: fixed;
        right: 16px;
        bottom: calc(16px + var(--safe-bottom));
        max-width: min(420px, calc(100vw - 32px));
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(148, 163, 184, 0.24);
        box-shadow: 0 20px 40px rgba(15, 23, 42, 0.4);
        color: var(--text);
        font-size: 13px;
        line-height: 1.4;
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .toast.visible {
        opacity: 1;
        transform: translateY(0);
      }
      @media (max-width: 420px) {
        .header { padding: 12px 14px; }
        .viewport-frame { min-height: calc(100vh - 132px); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card header">
        <div class="title" id="artifactTitle">Canvas</div>
        <div class="status" id="shellStatus">Starting…</div>
      </div>
      <div class="card viewport" id="viewport">
        <div class="landing" id="landing">
          <div class="landing-inner">
            <h1>Canvas</h1>
            <p id="landingMessage">${escapeForHtml(opts.defaultLandingMessage)}</p>
          </div>
        </div>
      </div>
    </div>
    <div class="toast" id="toast" aria-live="polite"></div>
    <script type="module" nonce="${opts.nonce}">
      import { DiscordSDK } from '/vendor/embedded-app-sdk/bundle.js';

      const config = ${config};
      const statusEl = document.getElementById('shellStatus');
      const titleEl = document.getElementById('artifactTitle');
      const viewportEl = document.getElementById('viewport');
      const landingEl = document.getElementById('landing');
      const landingMessageEl = document.getElementById('landingMessage');
      const toastEl = document.getElementById('toast');
      const sessionStorageKey = 'discoclaw.canvas.boundSession';
      const SESSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

      let authToken = '';
      let boundSessionToken = sessionStorage.getItem(sessionStorageKey) || '';
      let activityChannelId = '';
      let activityGuildId = '';
      let discordSdk = null;
      let artifactFrame = null;
      let toastTimer = 0;
      let appRefreshTimer = 0;
      let sessionRefreshTimer = 0;
      let sessionRefreshPromise = null;
      let activeTargetKey = '';

      function setStatus(text, kind = 'info') {
        statusEl.textContent = text;
        statusEl.className = kind === 'error' ? 'status error' : 'status';
      }

      function showLanding(message) {
        clearAppRefreshTimer();
        clearSessionRefreshTimer();
        activeTargetKey = '';
        artifactFrame = null;
        landingMessageEl.textContent = message;
        if (!landingEl.parentElement) {
          viewportEl.innerHTML = '';
          viewportEl.appendChild(landingEl);
        }
      }

      function showToast(message, kind = 'info') {
        toastEl.textContent = message;
        toastEl.style.borderColor = kind === 'error' ? 'rgba(252, 165, 165, 0.45)' : 'rgba(148, 163, 184, 0.24)';
        toastEl.classList.add('visible');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          toastEl.classList.remove('visible');
        }, 3200);
      }

      function clearAppRefreshTimer() {
        if (!appRefreshTimer) return;
        window.clearInterval(appRefreshTimer);
        appRefreshTimer = 0;
      }

      function clearSessionRefreshTimer() {
        if (!sessionRefreshTimer) return;
        window.clearInterval(sessionRefreshTimer);
        sessionRefreshTimer = 0;
      }

      function setBoundSessionToken(token) {
        boundSessionToken = String(token || '');
        if (boundSessionToken) {
          sessionStorage.setItem(sessionStorageKey, boundSessionToken);
        } else {
          sessionStorage.removeItem(sessionStorageKey);
        }
      }

      function buildActivityContextParams() {
        const params = new URLSearchParams();
        if (activityChannelId) params.set('channelId', activityChannelId);
        if (activityGuildId) params.set('guildId', activityGuildId);
        return params;
      }

      function createMockSdk() {
        const params = new URLSearchParams(window.location.search);
        return {
          ready: async () => {},
          channelId: params.get('channelId') || 'mock-channel',
          guildId: params.get('guildId') || 'mock-guild',
          commands: {
            authorize: async () => ({ code: 'mock:' + (params.get('userId') || 'mock-user') }),
            authenticate: async () => ({ user: { id: params.get('userId') || 'mock-user' } }),
          },
        };
      }

      function shouldUseMockSdk() {
        const params = new URLSearchParams(window.location.search);
        return params.get('mock') === '1';
      }

      async function postJson(url, body, extraHeaders = {}) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch {}
        if (!response.ok) {
          const detail = payload && typeof payload === 'object' && payload && 'error' in payload ? payload.error : response.statusText;
          const err = new Error(String(detail || 'Request failed'));
          err.status = response.status;
          throw err;
        }
        return payload;
      }

      async function getJson(url, extraHeaders = {}) {
        const response = await fetch(url, {
          headers: {
            ...extraHeaders,
          },
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch {}
        if (!response.ok) {
          const error = payload && typeof payload === 'object' && payload && 'error' in payload ? payload.error : response.statusText;
          const err = new Error(String(error || 'Request failed'));
          err.status = response.status;
          throw err;
        }
        return payload;
      }

      function renderDocument(html, title) {
        titleEl.textContent = title || 'Canvas';
        const frame = document.createElement('iframe');
        frame.className = 'viewport-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = html;
        viewportEl.innerHTML = '';
        viewportEl.appendChild(frame);
        artifactFrame = frame;
      }

      function renderDocumentFromUrl(url, title) {
        titleEl.textContent = title || 'Canvas';
        const frame = document.createElement('iframe');
        frame.className = 'viewport-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.src = url;
        viewportEl.innerHTML = '';
        viewportEl.appendChild(frame);
        artifactFrame = frame;
      }

      async function refreshSessionCredentials() {
        if (sessionRefreshPromise) return sessionRefreshPromise;
        sessionRefreshPromise = (async () => {
          if (!authToken || !boundSessionToken || !activityChannelId) return false;
          const refreshed = await getJson('/api/session/refresh?' + buildActivityContextParams().toString(), {
            Authorization: 'Bearer ' + authToken,
            'X-Canvas-Bound-Session': boundSessionToken,
          });
          if (typeof refreshed.authToken === 'string' && refreshed.authToken) {
            authToken = refreshed.authToken;
          }
          const nextBoundSessionToken = String(refreshed.boundSessionToken || '');
          if (!nextBoundSessionToken) {
            throw new Error('Canvas session refresh returned no launch token');
          }
          setBoundSessionToken(nextBoundSessionToken);
          return true;
        })();

        try {
          return await sessionRefreshPromise;
        } finally {
          sessionRefreshPromise = null;
        }
      }

      function scheduleSessionRefresh() {
        if (!authToken || !boundSessionToken || !activityChannelId) return;
        if (sessionRefreshTimer) return;
        sessionRefreshTimer = window.setInterval(async () => {
          try {
            await refreshSessionCredentials();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('Canvas session refresh failed: ' + message, 'error');
          }
        }, SESSION_REFRESH_INTERVAL_MS);
      }

      async function withSessionRefreshRetry(run) {
        try {
          return await run();
        } catch (error) {
          if (!error || typeof error !== 'object' || error.status !== 401) throw error;
          const refreshed = await refreshSessionCredentials().catch(() => false);
          if (!refreshed) throw error;
          return run();
        }
      }

      async function loadArtifactTarget(target) {
        clearAppRefreshTimer();
        activeTargetKey = 'artifact:' + target.id;
        setStatus('Loading artifact…');
        scheduleSessionRefresh();
        const renderParams = new URLSearchParams({
          auth: authToken,
          session: boundSessionToken,
        });
        const renderUrl = '/api/artifacts/' + encodeURIComponent(target.id) + '/render?' + renderParams.toString();
        renderDocumentFromUrl(renderUrl, String(target.title || 'Canvas'));
        setStatus('Ready');
      }

      async function loadAppTarget(target, background = false) {
        scheduleSessionRefresh();
        const app = await withSessionRefreshRetry(() => getJson('/api/apps/' + encodeURIComponent(target.name), {
          Authorization: 'Bearer ' + authToken,
          'X-Canvas-Bound-Session': boundSessionToken,
        }));
        activeTargetKey = 'app:' + target.name;
        renderDocument(String(app.content || ''), String(app.title || target.title || 'Canvas'));
        const refreshSeconds = Number(app.refreshSeconds) || 0;
        clearAppRefreshTimer();
        if (refreshSeconds > 0) {
          appRefreshTimer = window.setInterval(async () => {
            if (activeTargetKey !== 'app:' + target.name) return;
            try {
              await loadAppTarget(target, true);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              showToast('Dashboard refresh failed: ' + message, 'error');
              setStatus('Refresh failed', 'error');
            }
          }, refreshSeconds * 1000);
        }
        if (!background) setStatus(refreshSeconds > 0 ? 'Live' : 'Ready');
      }

      function sendArtifactReply(message) {
        if (!artifactFrame || !artifactFrame.contentWindow) return;
        artifactFrame.contentWindow.postMessage(message, '*');
      }

      window.addEventListener('message', async (event) => {
        if (!artifactFrame || event.source !== artifactFrame.contentWindow) return;
        if (event.origin !== 'null') return;

        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'canvas.saveFile') return;

        if (!config.writeBridgeEnabled) {
          const message = 'Canvas file export is disabled on this install.';
          showToast(message, 'error');
          sendArtifactReply({ type: 'canvas.saveFile.result', requestId: data.requestId, ok: false, error: message });
          return;
        }

        if (!authToken || !boundSessionToken) {
          const message = 'Canvas session unavailable for file export.';
          showToast(message, 'error');
          sendArtifactReply({ type: 'canvas.saveFile.result', requestId: data.requestId, ok: false, error: message });
          return;
        }

        if (
          typeof data.suggestedName !== 'string'
          || typeof data.mimeType !== 'string'
          || (data.encoding !== 'utf8' && data.encoding !== 'base64')
          || typeof data.content !== 'string'
        ) {
          const message = 'Canvas file export request was invalid.';
          showToast(message, 'error');
          sendArtifactReply({ type: 'canvas.saveFile.result', requestId: data.requestId, ok: false, error: message });
          return;
        }

        try {
          const result = await withSessionRefreshRetry(() => postJson('/api/files/save', {
            suggestedName: data.suggestedName,
            mimeType: data.mimeType,
            encoding: data.encoding,
            content: data.content,
          }, {
            Authorization: 'Bearer ' + authToken,
            'X-Canvas-Bound-Session': boundSessionToken,
          }));
          showToast('Saved ' + result.fileName);
          sendArtifactReply({
            type: 'canvas.saveFile.result',
            requestId: data.requestId,
            ok: true,
            fileName: result.fileName,
            relativePath: result.relativePath,
            bytes: result.bytes,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showToast(message, 'error');
          sendArtifactReply({ type: 'canvas.saveFile.result', requestId: data.requestId, ok: false, error: message });
        }
      });

      async function boot() {
        try {
          if (!config.clientId && !shouldUseMockSdk()) {
            showLanding('Discord Activity client ID is unavailable on this install.');
            setStatus('Configuration incomplete', 'error');
            return;
          }

          setStatus('Connecting…');
          discordSdk = shouldUseMockSdk() ? createMockSdk() : new DiscordSDK(config.clientId);
          await discordSdk.ready();

          activityChannelId = discordSdk.channelId || '';
          activityGuildId = discordSdk.guildId || '';

          if (config.authMode === 'preauth') {
            setStatus('Authenticating…');
            const tokenResponse = await postJson('/api/token', {
              channelId: activityChannelId,
              guildId: activityGuildId,
            });
            authToken = tokenResponse.authToken || '';
          } else {
            setStatus('Authorizing…');
            const { code } = await discordSdk.commands.authorize({
              client_id: config.clientId,
              response_type: 'code',
              state: 'discoclaw-canvas',
              prompt: 'none',
              scope: ['identify', 'guilds', 'applications.commands'],
            });

            const tokenResponse = await postJson('/api/token', { code });
            authToken = tokenResponse.authToken || '';

            if (!shouldUseMockSdk()) {
              await discordSdk.commands.authenticate({ access_token: tokenResponse.access_token });
            }
          }
          const params = buildActivityContextParams();

          setStatus('Resolving launch…');
          const launch = await getJson('/api/launches/current?' + params.toString(), {
            Authorization: 'Bearer ' + authToken,
            ...(boundSessionToken ? { 'X-Canvas-Bound-Session': boundSessionToken } : {}),
          }).catch((error) => {
            if (error && typeof error === 'object' && error.status === 404) return null;
            throw error;
          });

          if (!launch || !launch.target || launch.target.type !== 'artifact') {
            if (launch && launch.target && launch.target.type === 'app') {
              setBoundSessionToken(String(launch.boundSessionToken || ''));
              setStatus('Loading app…');
              await loadAppTarget(launch.target);
              return;
            }
            setBoundSessionToken('');
            showLanding(config.defaultLandingMessage);
            setStatus('Waiting for launch');
            return;
          }

          setBoundSessionToken(String(launch.boundSessionToken || ''));
          await loadArtifactTarget(launch.target);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showLanding(message);
          setStatus('Canvas failed', 'error');
        }
      }

      boot();
    </script>
    <script nonce="${opts.nonce}">
      // Non-module fallback: catches silent ES module import failures.
      // If boot() never runs (module blocked by proxy, MIME type, or CSP),
      // the status will still read "Starting..." after a timeout.
      (function() {
        var timeout = setTimeout(function() {
          var el = document.getElementById('shellStatus');
          if (el && el.textContent === 'Starting\u2026') {
            el.textContent = 'Module load failed';
            el.className = 'status error';
            var landing = document.getElementById('landingMessage');
            if (landing) {
              landing.textContent = 'The shell script failed to load. This usually means the Discord Activity proxy blocked the ES module import. Try popping out the Activity window.';
            }
          }
        }, 5000);
        window.addEventListener('error', function(e) {
          clearTimeout(timeout);
          var el = document.getElementById('shellStatus');
          if (el) {
            el.textContent = 'Script error';
            el.className = 'status error';
          }
          var landing = document.getElementById('landingMessage');
          if (landing) {
            landing.textContent = 'Script error: ' + (e.message || 'unknown');
          }
        });
      })();
    </script>
  </body>
</html>`;
}
