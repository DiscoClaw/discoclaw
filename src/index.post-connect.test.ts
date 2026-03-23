import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectBootReportLaunchMode,
  formatBootReportWorkspaceLabel,
  publishBootReport,
} from './index.post-connect.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('detectBootReportLaunchMode', () => {
  it('detects systemd on linux when invocation metadata is present', () => {
    expect(detectBootReportLaunchMode({ INVOCATION_ID: 'abc123' }, 'linux')).toBe('systemd');
  });

  it('detects launchd on darwin when launch metadata is present', () => {
    expect(detectBootReportLaunchMode({ LAUNCH_JOB_NAME: 'com.discoclaw.discoclaw' }, 'darwin')).toBe('launchd');
  });

  it('falls back to manual when no daemon metadata is present', () => {
    expect(detectBootReportLaunchMode({}, 'linux')).toBe('manual');
    expect(detectBootReportLaunchMode({}, 'darwin')).toBe('manual');
  });
});

describe('formatBootReportWorkspaceLabel', () => {
  it('uses parent and basename for nested workspaces', () => {
    expect(formatBootReportWorkspaceLabel('/home/davidmarsh/Dropbox/discoclaw-data/workspace'))
      .toBe('discoclaw-data/workspace');
  });

  it('falls back to basename when no useful parent exists', () => {
    expect(formatBootReportWorkspaceLabel('/workspace')).toBe('workspace');
  });
});

describe('publishBootReport', () => {
  it('threads derived instance identity into the boot report payload', () => {
    const bootReport = vi.fn().mockResolvedValue(undefined);

    publishBootReport({
      botStatus: { bootReport } as any,
      startupCtx: { type: 'first-boot' },
      serviceName: 'discoclaw-beta',
      workspaceCwd: '/Users/david/Dropbox/discoclaw-data/workspace',
      tasksEnabled: true,
      forumResolved: true,
      cronsEnabled: false,
      memoryEpisodicOn: true,
      memorySemanticOn: true,
      memoryWorkingOn: true,
      memoryColdOn: false,
      actionCategoriesEnabled: ['tasks'],
      configWarnings: 0,
      permProbe: { status: 'valid', permissions: { tier: 'full' } } as any,
      credentialReport: 'discord-token: ok',
      credentialCheckReport: {
        results: [{ name: 'discord-token', status: 'ok' }],
        criticalFailures: [],
        allOk: true,
      },
      runtimeModel: 'capable',
      bootDurationMs: 1234,
      log: { warn: vi.fn() } as any,
    });

    expect(bootReport).toHaveBeenCalledWith(expect.objectContaining({
      serviceName: 'discoclaw-beta',
      launchMode: detectBootReportLaunchMode(),
      workspaceLabel: 'discoclaw-data/workspace',
      processId: process.pid,
    }));
  });
});
