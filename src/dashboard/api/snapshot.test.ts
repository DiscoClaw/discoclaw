import { describe, expect, it, vi } from 'vitest';
import type { DashboardDeps } from '../../cli/dashboard.js';
import type { DoctorContext, DoctorReport, FixResult } from '../../health/config-doctor.js';
import { buildSnapshotResponse } from './snapshot.js';

function makeDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    cwd: '/repo',
    installMode: 'source',
    env: {
      DISCOCLAW_SERVICE_NAME: 'discoclaw-beta',
      PRIMARY_RUNTIME: 'claude',
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
    },
    modelsFile: {
      exists: true,
      values: {
        chat: 'opus',
      },
    },
    runtimeOverrides: {
      fastRuntime: 'openrouter',
    },
    runtimeOverridesFile: {
      exists: true,
      unknownKeys: [],
      raw: {},
      values: {
        fastRuntime: 'openrouter',
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

function makeDeps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    inspect: vi.fn(async () => makeDoctorReport()),
    applyFixes: vi.fn(async () => makeFixResult()),
    loadDoctorContext: vi.fn(async () => makeDoctorContext()),
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
    ...overrides,
  };
}

describe('buildSnapshotResponse', () => {
  it('returns the dashboard snapshot payload for /api/snapshot', async () => {
    const deps = makeDeps();
    const response = await buildSnapshotResponse({ cwd: '/repo', env: {} }, deps);

    expect(response).toEqual({
      ok: true,
      snapshot: {
        cwd: '/repo',
        version: '1.2.3',
        installMode: 'source',
        gitHash: 'abc1234',
        serviceName: 'discoclaw-beta',
        serviceSummary: 'active (running) since today',
        doctorSummary: '0 findings (errors=0, warnings=0, info=0)',
        roles: [
          'chat',
          'plan-run',
          'fast',
          'summary',
          'cron',
          'cron-exec',
          'voice',
          'forge-drafter',
          'forge-auditor',
        ],
        modelOptions: expect.objectContaining({
          chat: expect.arrayContaining(['default', 'capable', 'opus']),
          fast: ['default', 'fast', 'capable', 'deep'],
          voice: ['default', 'fast', 'capable', 'deep'],
        }),
        modelRows: expect.arrayContaining([
          expect.objectContaining({
            role: 'chat',
            effectiveModel: 'opus',
            source: 'override',
            overrideValue: 'opus',
          }),
        ]),
        configPaths: {
          cwd: '/repo',
          env: '/repo/.env',
          dataDir: '/repo/data',
          models: '/repo/data/models.json',
          runtimeOverrides: '/repo/data/runtime-overrides.json',
        },
        runtimeOverrides: {
          fastRuntime: 'openrouter',
          voiceRuntime: undefined,
        },
      },
    });
  });
});
