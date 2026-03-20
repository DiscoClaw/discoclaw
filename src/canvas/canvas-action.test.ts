import { afterEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from './artifact-store.js';
import { createCanvasBuiltinApps } from './apps.js';
import { createCanvasContext, executeCanvasAction, handleCanvasButtonInteraction, CANVAS_LAUNCH_COMPONENT_PREFIX } from './canvas-action.js';
import { CanvasFileExport } from './file-export.js';
import { LaunchStore } from './launch-store.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeCanvasContext() {
  const dir = await makeTempDir('discoclaw-canvas-action-');
  const artifactStore = new ArtifactStore({
    rootDir: path.join(dir, 'artifacts'),
    maxArtifacts: 10,
  });
  const launchStore = new LaunchStore({
    pendingTtlMs: 120_000,
    boundSessionTtlMs: 600_000,
  });
  const fileExport = new CanvasFileExport({
    rootDir: path.join(dir, 'exports'),
    maxBytes: 1024 * 1024,
  });
  const canvasCtx = createCanvasContext({
    enabled: true,
    discordClientId: 'client-id',
    writeBridgeEnabled: true,
    artifactStore,
    launchStore,
    fileExport,
    builtinApps: createCanvasBuiltinApps({
      getDashboardSnapshot: async () => ({
        cwd: '/workspace',
        version: '1.0.0',
        installMode: 'source',
        gitHash: 'abc1234',
        serviceName: 'discoclaw',
        serviceSummary: 'active',
        serviceEnabled: true,
        doctorSummary: '0 findings (errors=0, warnings=0, info=0)',
        roles: ['chat'],
        modelOptions: { chat: ['default', 'capable'] },
        modelRows: [{ role: 'chat', effectiveModel: 'capable', source: 'default' }],
        configPaths: {
          cwd: '/workspace',
          env: '/workspace/.env',
          dataDir: '/workspace/data',
          models: '/workspace/models.json',
          runtimeOverrides: '/workspace/runtime-overrides.json',
        },
        runtimeOverrides: {},
        mcpStatus: { status: 'missing' },
        mcpWarnings: 0,
        primaryRuntime: 'claude',
      }),
    }),
    getLocalReadiness: () => ({
      ready: true,
      missingChecks: [],
      externalChecks: [],
    }),
  });
  canvasCtx.server = {
    server: {} as any,
    close: async () => {},
    isListening: () => true,
    getLocalReadiness: canvasCtx.getLocalReadiness,
  };
  return canvasCtx;
}

describe('canvas-action', () => {
  it('surfaces the injected canvas runtime contract from the checked-in prompt template', async () => {
    vi.resetModules();
    const { canvasActionsPromptSection } = await import('./canvas-action.js');

    const prompt = canvasActionsPromptSection({ writeBridgeEnabled: true });
    expect(prompt).toContain('window.canvasRuntime');
    expect(prompt).toContain('installed `preact/hooks` surface');
    expect(prompt).toContain('`useLayoutEffect`');
    expect(prompt).toContain('const { html, render, useState } = window.canvasRuntime');
    expect(prompt).toContain('self-close void HTML elements');
    expect(prompt).toContain('Bare `<input>` tags can corrupt the rendered DOM');
    expect(prompt).toContain('feel at home in Discord without mimicking Discord');
    expect(prompt).toContain('instead of cloning Discord\'s palette by default');
  });

  it('documents the injected canvas runtime in fallback prompt text and preserves save-bridge substitution', async () => {
    vi.resetModules();
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(() => {
      throw new Error('template unavailable');
    });

    const { canvasActionsPromptSection } = await import('./canvas-action.js');

    const withSaveBridge = canvasActionsPromptSection({ writeBridgeEnabled: true });
    expect(withSaveBridge).toContain('window.canvasRuntime');
    expect(withSaveBridge).toContain('installed `preact/hooks` surface');
    expect(withSaveBridge).toContain('`useErrorBoundary`');
    expect(withSaveBridge).toContain('const { html, render, useState } = window.canvasRuntime');
    expect(withSaveBridge).toContain('self-close void HTML elements');
    expect(withSaveBridge).toContain('feel at home in Discord without mimicking Discord');
    expect(withSaveBridge).toContain('canvas.saveFile');
    expect(withSaveBridge).not.toContain('{{CANVAS_SAVE_BRIDGE_GUIDANCE}}');

    const withoutSaveBridge = canvasActionsPromptSection({ writeBridgeEnabled: false });
    expect(withoutSaveBridge).toContain('window.canvasRuntime');
    expect(withoutSaveBridge).toContain('installed `preact/hooks` surface');
    expect(withoutSaveBridge).toContain('`useId`');
    expect(withoutSaveBridge).toContain('Bare `<input>` tags can corrupt the rendered DOM');
    expect(withoutSaveBridge).toContain('instead of cloning Discord\'s palette by default');
    expect(withoutSaveBridge).not.toContain('canvas.saveFile');
    expect(withoutSaveBridge).not.toContain('{{CANVAS_SAVE_BRIDGE_GUIDANCE}}');
  });

  it('stores the artifact and posts a launch button when canvas is ready', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Tax Calculator',
        content: '<!doctype html><html><body><h1>Tax</h1></body></html>',
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "Tax Calculator"' });
    expect(send).toHaveBeenCalledOnce();
    const payload = (send as any).mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload.content).toContain('Tax Calculator');
    expect(payload.components[0].components[0].data.custom_id).toContain(CANVAS_LAUNCH_COMPONENT_PREFIX);
    expect(payload.components[0].components[0].data.custom_id).toContain(`${canvasCtx.launchStore.instanceTag()}:`);
  });

  it('rejects runtime artifacts with bare void tags before storing them', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Broken Runtime Canvas',
        content: "<!doctype html><html><body><div id='app'></div><script>const { html, render } = window.canvasRuntime; function App(){ return html`<main><input type='text'></main>`; } render(html`<${App} />`, document.getElementById('app'));</script></body></html>",
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected runtime artifact lint to reject bare void tags');
    }
    expect(result.error).toContain('bare void HTML elements');
    expect(result.error).toContain('<input>');
    expect(send).not.toHaveBeenCalled();
  });

  it('allows static HTML artifacts to use regular void-element syntax', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Static Form',
        content: "<!doctype html><html><body><label>Name <input type='text'></label></body></html>",
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "Static Form"' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows runtime artifacts with normal head tags and static markup outside html templates', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Runtime Form',
        content: "<!doctype html><html><head><meta charset='utf-8'><link rel='icon' href='data:,'></head><body><label>Name <input type='text'></label><div id='app'></div><script>const { html, render } = window.canvasRuntime; function App(){ return html`<main><button>OK</button></main>`; } render(html`<${App} />`, document.getElementById('app'));</script></body></html>",
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "Runtime Form"' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('ignores html-looking text inside script strings when linting runtime artifacts', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Runtime Code Sample',
        content: "<!doctype html><html><body><div id='app'></div><script>const example = '<input type=\"text\">'; const { html, render } = window.canvasRuntime; function App(){ return html`<main><pre>${example}</pre></main>`; } render(html`<${App} />`, document.getElementById('app'));</script></body></html>",
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "Runtime Code Sample"' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('posts a built-in app launch button when app mode is requested', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: 'Dashboard',
        app: 'dashboard',
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "Dashboard"' });
    expect(send).toHaveBeenCalledOnce();
    const payload = (send as any).mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload.content).toContain('live canvas app');
  });

  it('escapes markdown metacharacters in the Discord launch message title', async () => {
    const canvasCtx = await makeCanvasContext();
    const send = vi.fn(async () => ({}));
    const result = await executeCanvasAction(
      {
        type: 'launchCanvas',
        title: '  **Chart** [v2]\nReport  ',
        content: '<!doctype html><html><body><h1>Tax</h1></body></html>',
      },
      {
        guild: {
          channels: {
            cache: {
              get: () => ({ isTextBased: () => true, send }),
            },
          },
        } as any,
        client: {} as any,
        channelId: 'channel-1',
        messageId: 'message-1',
      },
      canvasCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Posted canvas launch button for "**Chart** [v2] Report"' });
    const payload = (send as any).mock.calls[0]?.[0];
    expect(payload.content).toContain('**\\*\\*Chart\\*\\* \\[v2\\] Report**');
  });

  it('creates a pending launch and issues LAUNCH_ACTIVITY for authorized button clicks', async () => {
    const canvasCtx = await makeCanvasContext();
    const artifact = await canvasCtx.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.instanceTag()}:${canvasCtx.launchStore.createArtifactLaunchRef(artifact.id)}`;
    const reply = vi.fn(async () => ({}));
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const handled = await handleCanvasButtonInteraction({
      interaction: {
        isButton: () => true,
        customId,
        user: { id: 'user-1' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        id: 'interaction-1',
        token: 'interaction-token',
        reply,
      } as any,
      canvasCtx,
      allowUserIds: new Set(['user-1']),
    });

    expect(handled).toBe(true);
    expect(canvasCtx.launchStore.hasPending({ userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' })).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('registers built-in app launches from dashboard buttons', async () => {
    const canvasCtx = await makeCanvasContext();
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.instanceTag()}:${canvasCtx.launchStore.createAppLaunchRef('dashboard')}`;
    const reply = vi.fn(async () => ({}));
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const handled = await handleCanvasButtonInteraction({
      interaction: {
        isButton: () => true,
        customId,
        user: { id: 'user-1' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        id: 'interaction-1',
        token: 'interaction-token',
        reply,
      } as any,
      canvasCtx,
      allowUserIds: new Set(['user-1']),
    });

    expect(handled).toBe(true);
    const resolution = canvasCtx.launchStore.resolveCurrent(
      { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' },
    );
    expect(resolution?.target).toEqual({ type: 'app', appName: 'dashboard' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('surfaces a stale-session message for launch buttons created by a different live instance', async () => {
    const canvasCtx = await makeCanvasContext();
    const foreignLaunchStore = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
      launchRefSecret: 'foreign-instance-secret',
    });
    const artifact = await canvasCtx.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${foreignLaunchStore.instanceTag()}:${foreignLaunchStore.createArtifactLaunchRef(artifact.id)}`;
    const reply = vi.fn(async () => ({}));
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const handled = await handleCanvasButtonInteraction({
      interaction: {
        isButton: () => true,
        customId,
        user: { id: 'user-1' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        id: 'interaction-1',
        token: 'interaction-token',
        reply,
      } as any,
      canvasCtx,
      allowUserIds: new Set(['user-1']),
      log: { debug: vi.fn() } as any,
    });

    expect(handled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply as any).mock.calls[0]?.[0];
    expect(payload.content).toContain('earlier bot session');
    expect(canvasCtx.launchStore.hasPending({ userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' })).toBe(false);
  });

  it('surfaces Discord channel-type launch failures instead of the generic setup hint', async () => {
    const canvasCtx = await makeCanvasContext();
    const artifact = await canvasCtx.artifactStore.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.instanceTag()}:${canvasCtx.launchStore.createArtifactLaunchRef(artifact.id)}`;
    const reply = vi.fn(async () => ({}));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Cannot execute action on this channel type', code: 50024 }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handled = await handleCanvasButtonInteraction({
      interaction: {
        isButton: () => true,
        customId,
        user: { id: 'user-1' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        id: 'interaction-1',
        token: 'interaction-token',
        reply,
      } as any,
      canvasCtx,
      allowUserIds: new Set(['user-1']),
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply as any).mock.calls[0]?.[0];
    expect(payload.content).toContain('50024');
    expect(payload.content).toContain('channel type');
    expect(payload.content).toContain('button itself is valid');
  });
});
