import { describe, expect, it, vi } from 'vitest';
import type { DoctorContext, DoctorReport, FixResult } from '../health/config-doctor.js';
import type { ModelConfig } from '../model-config.js';
import type { RuntimeOverrides } from '../runtime-overrides.js';
import {
  buildModelRows,
  collectDashboardSnapshot,
  renderDashboard,
  runDashboard,
  updateModelConfig,
} from './dashboard.js';

function makeDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    cwd: '/repo',
    installMode: 'source',
    env: {
      DISCOCLAW_SERVICE_NAME: 'discoclaw-beta',
      PRIMARY_RUNTIME: 'claude',
      DISCOCLAW_VOICE_ENABLED: '1',
    },
    explicitEnvKeys: new Set<string>(),
    configPaths: {
      cwd: '/repo',
      env: '/repo/.env',
      dataDir: '/repo/data',
      models: '/repo/data/models.json',
      runtimeOverrides: '/repo/data/runtime-overrides.json',
    },
    defaultDataDir: '/repo/data',
    models: {
      chat: 'opus',
      voice: 'gpt-4o-mini-transcribe',
    },
    runtimeOverrides: {
      fastRuntime: 'openrouter',
      voiceRuntime: 'anthropic',
    },
    runtimeOverridesFile: {
      exists: true,
      unknownKeys: [],
      raw: {},
      values: {
        fastRuntime: 'openrouter',
        voiceRuntime: 'anthropic',
      },
    },
    envDefaults: {
      chat: 'capable',
      fast: 'fast',
      summary: 'fast',
      cron: 'fast',
      'cron-exec': 'capable',
      voice: 'capable',
      'forge-drafter': 'capable',
      'forge-auditor': 'deep',
    },
    ...overrides,
  };
}

function makeDoctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    installMode: 'source',
    findings: [],
    configPaths: {
      cwd: '/repo',
      env: '/repo/.env',
      dataDir: '/repo/data',
      models: '/repo/data/models.json',
      runtimeOverrides: '/repo/data/runtime-overrides.json',
    },
    ...overrides,
  };
}

function makeFixResult(overrides: Partial<FixResult> = {}): FixResult {
  return {
    applied: [],
    skipped: [],
    errors: [],
    ...overrides,
  };
}

function makeIo(answers: string[]) {
  const frames: string[] = [];
  return {
    frames,
    io: {
      clear: vi.fn(),
      write: vi.fn((text: string) => {
        frames.push(text);
      }),
      prompt: vi.fn(async () => answers.shift() ?? 'q'),
      close: vi.fn(),
    },
  };
}

describe('buildModelRows', () => {
  it('prefers explicit overrides and falls back to env defaults', () => {
    const rows = buildModelRows(makeDoctorContext());
    expect(rows.find((row) => row.role === 'chat')).toEqual({
      role: 'chat',
      effectiveModel: 'opus',
      source: 'override',
      overrideValue: 'opus',
    });
    expect(rows.find((row) => row.role === 'fast')).toEqual({
      role: 'fast',
      effectiveModel: 'fast',
      source: 'default',
      overrideValue: undefined,
    });
  });
});

describe('updateModelConfig', () => {
  it('sets or clears a stored override', () => {
    const updated = updateModelConfig({ chat: 'sonnet' }, 'chat', 'opus');
    expect(updated).toEqual({ chat: 'opus' });

    const cleared = updateModelConfig(updated, 'chat', null);
    expect(cleared).toEqual({});
  });
});

describe('collectDashboardSnapshot', () => {
  it('collects doctor, model, and service summary state', async () => {
    const ctx = makeDoctorContext();
    const report = makeDoctorReport({
      findings: [
        {
          id: 'missing-secret:OPENAI_API_KEY',
          severity: 'error',
          message: 'OPENAI_API_KEY is missing.',
          recommendation: 'Set OPENAI_API_KEY.',
          autoFixable: false,
        },
      ],
    });

    const snapshot = await collectDashboardSnapshot(
      { cwd: '/repo', env: {} },
      {
        inspect: vi.fn(async () => report),
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext: vi.fn(async () => ctx),
        saveModelConfig: vi.fn(async () => undefined),
        saveOverrides: vi.fn(async () => undefined),
        runCommand: vi.fn(async () => ({
          stdout: '   Active: active (running) since today\n',
          stderr: '',
          exitCode: 0,
        })),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    );

    expect(snapshot.serviceName).toBe('discoclaw-beta');
    expect(snapshot.serviceSummary).toBe('active (running) since today');
    expect(snapshot.doctorSummary).toBe('1 findings (errors=1, warnings=0, info=0)');

    const rendered = renderDashboard(snapshot, 'Ready.');
    expect(rendered).toContain('Discoclaw Dashboard');
    expect(rendered).toContain('service: discoclaw-beta (active (running) since today)');
    expect(rendered).toContain('voice-runtime');
    expect(rendered).toContain('[7] Change model/runtime assignment');
  });
});

describe('runDashboard', () => {
  it('persists a model override through the interactive menu', async () => {
    const firstCtx = makeDoctorContext({ models: {} });
    const secondCtx = makeDoctorContext({ models: { chat: 'opus' } });
    const report = makeDoctorReport();
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const loadDoctorContextMock = vi.fn()
      .mockResolvedValueOnce(firstCtx)
      .mockResolvedValueOnce(firstCtx)
      .mockResolvedValueOnce(secondCtx);
    const inspectMock = vi.fn(async () => report);
    const { io, frames } = makeIo(['7', 'chat', 'opus', 'q']);

    await runDashboard({
      cwd: '/repo',
      env: {},
      io,
      loadEnv: false,
      deps: {
        inspect: inspectMock,
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext: loadDoctorContextMock,
        saveModelConfig: saveModelConfigMock,
        saveOverrides: saveOverridesMock,
        runCommand: vi.fn(async () => ({
          stdout: 'Active: active (running)\n',
          stderr: '',
          exitCode: 0,
        })),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).toHaveBeenCalledWith('/repo/data/models.json', { chat: 'opus' });
    expect(frames.some((frame) => frame.includes('Discoclaw Dashboard'))).toBe(true);
    expect(frames.some((frame) => frame.includes('Saved chat override: opus.'))).toBe(true);
  });

  it('runs doctor fixes from the menu', async () => {
    const ctx = makeDoctorContext();
    const report = makeDoctorReport({
      findings: [
        {
          id: 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
          severity: 'warn',
          message: 'Legacy env var is present.',
          recommendation: 'Rename it.',
          autoFixable: true,
        },
      ],
    });
    const applyFixesMock = vi.fn(async () => makeFixResult({
      applied: ['deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL'],
    }));
    const { io, frames } = makeIo(['6', 'q']);

    await runDashboard({
      cwd: '/repo',
      env: {},
      io,
      loadEnv: false,
      deps: {
        inspect: vi.fn(async () => report),
        applyFixes: applyFixesMock,
        loadDoctorContext: vi.fn(async () => ctx),
        saveModelConfig: vi.fn(async () => undefined),
        saveOverrides: vi.fn(async () => undefined),
        runCommand: vi.fn(async () => ({
          stdout: 'Active: active (running)\n',
          stderr: '',
          exitCode: 0,
        })),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(applyFixesMock).toHaveBeenCalledWith(report, { cwd: '/repo', env: {} });
    expect(frames.some((frame) => frame.includes('Applied IDs: deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL'))).toBe(true);
  });

  it('rejects persisted chat runtime names because they do not survive restart correctly', async () => {
    const ctx = makeDoctorContext({ models: {} });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'chat', 'openrouter', 'q']);

    await runDashboard({
      cwd: '/repo',
      env: {},
      io,
      loadEnv: false,
      deps: {
        inspect: vi.fn(async () => makeDoctorReport()),
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext: vi.fn(async () => ctx),
        saveModelConfig: saveModelConfigMock,
        saveOverrides: saveOverridesMock,
        runCommand: vi.fn(async () => ({
          stdout: 'Active: active (running)\n',
          stderr: '',
          exitCode: 0,
        })),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('Chat runtime swaps are live-only'))).toBe(true);
  });

  it('persists voice runtime overrides into runtime-overrides.json', async () => {
    const ctx = makeDoctorContext({ models: {}, runtimeOverrides: {} });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'voice', 'openrouter', 'q']);

    await runDashboard({
      cwd: '/repo',
      env: {},
      io,
      loadEnv: false,
      deps: {
        inspect: vi.fn(async () => makeDoctorReport()),
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext: vi.fn(async () => ctx),
        saveModelConfig: saveModelConfigMock,
        saveOverrides: saveOverridesMock,
        runCommand: vi.fn(async () => ({
          stdout: 'Active: active (running)\n',
          stderr: '',
          exitCode: 0,
        })),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).toHaveBeenCalledWith('/repo/data/runtime-overrides.json', {
      voiceRuntime: 'openrouter',
    });
    expect(frames.some((frame) => frame.includes('Saved voice runtime override: openrouter.'))).toBe(true);
  });
});
