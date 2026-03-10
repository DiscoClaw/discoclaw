import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspect,
  loadDoctorContext,
  type DoctorContext,
  type DoctorReport,
  type FixResult,
} from '../health/config-doctor.js';
import type { ModelConfig } from '../model-config.js';
import type { RuntimeOverrides } from '../runtime-overrides.js';
import {
  buildModelRows,
  collectDashboardSnapshot,
  renderDashboard,
  runDashboard,
  updateModelConfig,
} from './dashboard.js';

const tempDirs: string[] = [];
const originalDashboardEnv = {
  DISCOCLAW_DATA_DIR: process.env.DISCOCLAW_DATA_DIR,
  DISCOCLAW_SERVICE_NAME: process.env.DISCOCLAW_SERVICE_NAME,
};

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
    modelsFile: {
      exists: true,
      values: {
        chat: 'opus',
        voice: 'gpt-4o-mini-transcribe',
      },
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

async function makeTempInstall(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function writeEnv(cwd: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(cwd, '.env'), lines.join('\n') + '\n', 'utf-8');
}

afterEach(async () => {
  if (originalDashboardEnv.DISCOCLAW_DATA_DIR === undefined) {
    delete process.env.DISCOCLAW_DATA_DIR;
  } else {
    process.env.DISCOCLAW_DATA_DIR = originalDashboardEnv.DISCOCLAW_DATA_DIR;
  }
  if (originalDashboardEnv.DISCOCLAW_SERVICE_NAME === undefined) {
    delete process.env.DISCOCLAW_SERVICE_NAME;
  } else {
    process.env.DISCOCLAW_SERVICE_NAME = originalDashboardEnv.DISCOCLAW_SERVICE_NAME;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

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

  it('treats stored values that match env defaults as baseline instead of overrides', () => {
    const rows = buildModelRows(makeDoctorContext({
      models: { chat: 'capable' },
      envDefaults: {
        ...makeDoctorContext().envDefaults,
        chat: 'capable',
      },
    }));

    expect(rows.find((row) => row.role === 'chat')).toEqual({
      role: 'chat',
      effectiveModel: 'capable',
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
    const ctx = makeDoctorContext({
      envDefaults: {
        ...makeDoctorContext().envDefaults,
        chat: 'env-chat-model',
      },
    });
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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    );

    expect(snapshot.serviceName).toBe('discoclaw-beta');
    expect(snapshot.serviceSummary).toBe('active (running) since today');
    expect(snapshot.doctorSummary).toBe('1 findings (errors=1, warnings=0, info=0)');
    expect(snapshot.version).toBe('1.2.3');
    expect(snapshot.gitHash).toBe('abc1234');
    expect(snapshot.roles).toEqual([
      'chat',
      'plan-run',
      'fast',
      'summary',
      'cron',
      'cron-exec',
      'voice',
      'forge-drafter',
      'forge-auditor',
    ]);
    expect(snapshot.modelOptions.fast).toEqual(['default', 'fast', 'capable', 'deep']);
    expect(snapshot.modelOptions.voice).toEqual(['default', 'fast', 'capable', 'deep']);
    expect(snapshot.modelOptions.chat).toContain('default');
    expect(snapshot.modelOptions.chat).toContain('env-chat-model');
    expect(snapshot.modelOptions.chat).toContain('opus');
    expect(snapshot.modelOptions.chat).toContain('claude-opus-4-6');
    expect(snapshot.modelOptions.chat).toContain('gpt-5.4');
    expect(snapshot.modelOptions['plan-run']).toContain('default');
    expect(snapshot.modelOptions['plan-run']).toContain('capable');
    expect(snapshot.modelOptions['plan-run']).toContain('gemini-2.5-pro');
    expect(
      snapshot.roles.every((role) => snapshot.modelOptions[role]?.includes('default')),
    ).toBe(true);

    const rendered = renderDashboard(snapshot, 'Ready.');
    expect(rendered).toContain('Discoclaw Dashboard');
    expect(rendered).toContain('version: 1.2.3');
    expect(rendered).toContain('git hash: abc1234');
    expect(rendered).toContain('service: discoclaw-beta (active (running) since today)');
    expect(rendered).toContain('voice-runtime');
    expect(rendered).toContain('[7] Change model assignment');
  });

  it('surfaces corrupt models.json as a dashboard doctor error while falling back to env defaults', async () => {
    const cwd = await makeTempInstall('dashboard-corrupt-models');
    await writeEnv(cwd, ['PRIMARY_RUNTIME=claude']);
    await fs.mkdir(path.join(cwd, 'data'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'data', 'models.json'), '{not-json\n', 'utf-8');

    const snapshot = await collectDashboardSnapshot(
      { cwd, env: {} },
      {
        inspect,
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext,
        saveModelConfig: vi.fn(async () => undefined),
        saveOverrides: vi.fn(async () => undefined),
        runCommand: vi.fn(async () => ({
          stdout: '   Active: active (running) since today\n',
          stderr: '',
          exitCode: 0,
        })),
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    );

    expect(snapshot.doctorSummary).toBe('1 findings (errors=1, warnings=0, info=0)');
    expect(snapshot.modelRows.find((row) => row.role === 'chat')).toEqual({
      role: 'chat',
      effectiveModel: 'capable',
      source: 'default',
      overrideValue: undefined,
    });
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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).toHaveBeenCalledWith('/repo/data/models.json', { chat: 'opus' });
    expect(frames.some((frame) => frame.includes('Discoclaw Dashboard'))).toBe(true);
    expect(frames.some((frame) => frame.includes('Saved chat override: opus. Changes take effect on next service restart.'))).toBe(true);
  });

  it('resets chat to the env-derived default and warns that restart is required', async () => {
    const ctx = makeDoctorContext({
      models: { chat: 'opus' },
      runtimeOverrides: {},
      envDefaults: {
        ...makeDoctorContext().envDefaults,
        chat: 'capable',
      },
    });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'chat', 'default', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).toHaveBeenCalledWith('/repo/data/models.json', { chat: 'capable' });
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('Reset chat to default: capable. Changes take effect on next service restart.'))).toBe(true);
  });

  it('resets fast to the env-derived default and clears fastRuntime', async () => {
    const ctx = makeDoctorContext({
      models: { fast: 'deep' },
      runtimeOverrides: {
        fastRuntime: 'openrouter',
        voiceRuntime: 'anthropic',
        ttsVoice: 'alloy',
      },
      envDefaults: {
        ...makeDoctorContext().envDefaults,
        fast: 'capable',
      },
    });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'fast', 'default', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).toHaveBeenCalledWith('/repo/data/models.json', { fast: 'capable' });
    expect(saveOverridesMock).toHaveBeenCalledWith('/repo/data/runtime-overrides.json', {
      voiceRuntime: 'anthropic',
      ttsVoice: 'alloy',
    });
    expect(frames.some((frame) => frame.includes('Reset fast to default: capable. Cleared fastRuntime override. Changes take effect on next service restart.'))).toBe(true);
  });

  it('resets voice to the env-derived default and clears voiceRuntime', async () => {
    const ctx = makeDoctorContext({
      models: { voice: 'deep' },
      runtimeOverrides: {
        fastRuntime: 'openrouter',
        voiceRuntime: 'anthropic',
        ttsVoice: 'alloy',
      },
      envDefaults: {
        ...makeDoctorContext().envDefaults,
        voice: 'capable',
      },
    });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'voice', 'default', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).toHaveBeenCalledWith('/repo/data/models.json', { voice: 'capable' });
    expect(saveOverridesMock).toHaveBeenCalledWith('/repo/data/runtime-overrides.json', {
      fastRuntime: 'openrouter',
      ttsVoice: 'alloy',
    });
    expect(frames.some((frame) => frame.includes('Reset voice to default: capable. Cleared voiceRuntime override. Changes take effect on next service restart.'))).toBe(true);
  });

  it('bootstraps dashboard context from .env via dotenv before the first render', async () => {
    const cwd = await makeTempInstall('dashboard-dotenv-bootstrap');
    delete process.env.DISCOCLAW_DATA_DIR;
    delete process.env.DISCOCLAW_SERVICE_NAME;
    await writeEnv(cwd, [
      'PRIMARY_RUNTIME=claude',
      'DISCOCLAW_DATA_DIR=./ops-data',
      'DISCOCLAW_SERVICE_NAME=discoclaw-ops',
    ]);
    await writeJson(path.join(cwd, 'ops-data', 'models.json'), {
      chat: 'opus',
    });
    const { io, frames } = makeIo(['q']);

    await runDashboard({
      cwd,
      io,
      deps: {
        inspect,
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext,
        saveModelConfig: vi.fn(async () => undefined),
        saveOverrides: vi.fn(async () => undefined),
        runCommand: vi.fn(async () => ({
          stdout: 'Active: active (running)\n',
          stderr: '',
          exitCode: 0,
        })),
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(process.env.DISCOCLAW_DATA_DIR).toBe('./ops-data');
    expect(process.env.DISCOCLAW_SERVICE_NAME).toBe('discoclaw-ops');
    expect(frames.some((frame) => frame.includes('service: discoclaw-ops (active (running))'))).toBe(true);
    expect(frames.some((frame) => frame.includes(`models: ${path.join(cwd, 'ops-data', 'models.json')}`))).toBe(true);
  });

  it('runs doctor fixes from the menu after confirmation', async () => {
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
    const { io, frames } = makeIo(['6', 'y', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(applyFixesMock).toHaveBeenCalledWith(report, { cwd: '/repo', env: {} });
    expect(frames.some((frame) => frame.includes('Applied IDs: deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL'))).toBe(true);
  });

  it('does not run doctor fixes when confirmation is declined', async () => {
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
    const applyFixesMock = vi.fn(async () => makeFixResult());
    const { io, frames } = makeIo(['6', 'n', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(applyFixesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('Doctor fixes canceled.'))).toBe(true);
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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('Chat runtime swaps are live-only'))).toBe(true);
  });

  it('rejects concrete model ids for the fast role', async () => {
    const ctx = makeDoctorContext({ models: {}, runtimeOverrides: {} });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'fast', 'haiku', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('fast accepts only model tiers'))).toBe(true);
  });

  it('rejects runtime names for the voice role', async () => {
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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('voice accepts only model tiers'))).toBe(true);
  });

  it('rejects concrete model ids for the voice role', async () => {
    const ctx = makeDoctorContext({ models: {}, runtimeOverrides: {} });
    const saveModelConfigMock = vi.fn(async (_filePath: string, _config: ModelConfig) => undefined);
    const saveOverridesMock = vi.fn(async (_filePath: string, _overrides: RuntimeOverrides) => undefined);
    const { io, frames } = makeIo(['7', 'voice', 'gpt-4o-mini-transcribe', 'q']);

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
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(saveModelConfigMock).not.toHaveBeenCalled();
    expect(saveOverridesMock).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.includes('voice accepts only model tiers'))).toBe(true);
  });

  it('requires confirmation before restart/start service', async () => {
    const runCommandMock = vi.fn(async () => ({
      stdout: 'Active: active (running)\n',
      stderr: '',
      exitCode: 0,
    }));
    const { io, frames } = makeIo(['4', 'n', 'q']);

    await runDashboard({
      cwd: '/repo',
      env: {},
      io,
      loadEnv: false,
      deps: {
        inspect: vi.fn(async () => makeDoctorReport()),
        applyFixes: vi.fn(async () => makeFixResult()),
        loadDoctorContext: vi.fn(async () => makeDoctorContext()),
        saveModelConfig: vi.fn(async () => undefined),
        saveOverrides: vi.fn(async () => undefined),
        runCommand: runCommandMock,
        getLocalVersion: vi.fn(() => '1.2.3'),
        isNpmManaged: vi.fn(async () => false),
        getGitHash: vi.fn(async () => 'abc1234'),
        platform: 'linux',
        homeDir: '/Users/david',
        getUid: () => 501,
      },
    });

    expect(runCommandMock).toHaveBeenCalledTimes(2);
    expect(frames.some((frame) => frame.includes('Restart/start canceled.'))).toBe(true);
  });
});
