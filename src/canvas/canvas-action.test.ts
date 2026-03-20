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
    expect(withSaveBridge).toContain('canvas.saveFile');
    expect(withSaveBridge).not.toContain('{{CANVAS_SAVE_BRIDGE_GUIDANCE}}');

    const withoutSaveBridge = canvasActionsPromptSection({ writeBridgeEnabled: false });
    expect(withoutSaveBridge).toContain('window.canvasRuntime');
    expect(withoutSaveBridge).toContain('installed `preact/hooks` surface');
    expect(withoutSaveBridge).toContain('`useId`');
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
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.createArtifactLaunchRef(artifact.id)}`;
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
    const customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.createAppLaunchRef('dashboard')}`;
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
});
