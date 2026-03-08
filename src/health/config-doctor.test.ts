import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyFixes,
  detectConflictingOverrides,
  detectDeprecatedEnvVars,
  detectInstallDrift,
  detectMissingSecrets,
  detectStaleRuntimeAndModelOverrides,
  detectUnknownRuntimeOverrideKeys,
  inspect,
  loadDoctorContext,
} from './config-doctor.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

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

describe('detectInstallDrift', () => {
  it('flags split state when DISCOCLAW_DATA_DIR points away from cwd but default data still has files', async () => {
    const cwd = await makeTempInstall('doctor-install-drift');
    await fs.mkdir(path.join(cwd, '.git'));
    await writeEnv(cwd, ['DISCOCLAW_DATA_DIR=./alt-data']);
    await writeJson(path.join(cwd, 'data', 'models.json'), { chat: 'capable' });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectInstallDrift(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('install-drift:split-data-dir');
    expect(findings[0]?.autoFixable).toBe(false);
  });
});

describe('detectDeprecatedEnvVars', () => {
  it('returns findings for deprecated env vars and marks the voice channel migration as auto-fixable', async () => {
    const cwd = await makeTempInstall('doctor-deprecated-env');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'DISCOCLAW_FAST_RUNTIME=openai',
      'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL=123',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'capable',
    });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectDeprecatedEnvVars(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'deprecated-env:RUNTIME_MODEL',
      'deprecated-env:DISCOCLAW_FAST_RUNTIME',
      'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
    ]);
    expect(
      findings.find((finding) => finding.id === 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL')
        ?.autoFixable,
    ).toBe(true);
  });

  it('does not flag RUNTIME_MODEL when models.json does not exist yet', async () => {
    const cwd = await makeTempInstall('doctor-deprecated-env-no-models');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'DISCOCLAW_FAST_RUNTIME=openai',
    ]);

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectDeprecatedEnvVars(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'deprecated-env:DISCOCLAW_FAST_RUNTIME',
    ]);
  });
});

describe('detectConflictingOverrides', () => {
  it('flags model and fast runtime overrides that fight explicit env config', async () => {
    const cwd = await makeTempInstall('doctor-conflicts');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'DISCOCLAW_FAST_RUNTIME=openai',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'gpt-5.4',
    });
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      fastRuntime: 'openrouter',
    });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectConflictingOverrides(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'conflicting-model-override:chat',
      'conflicting-runtime-override:fastRuntime',
    ]);
  });
});

describe('detectStaleRuntimeAndModelOverrides', () => {
  it('flags redundant model/runtime overrides and invalid runtime names', async () => {
    const cwd = await makeTempInstall('doctor-stale-overrides');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'PRIMARY_RUNTIME=claude',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'capable',
    });
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      fastRuntime: 'claude',
      voiceRuntime: 'not-a-runtime',
    });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectStaleRuntimeAndModelOverrides(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'stale-model-override:chat',
      'stale-runtime-override:fastRuntime',
      'stale-runtime-override:voiceRuntime',
    ]);
    expect(findings.every((finding) => finding.autoFixable)).toBe(true);
  });
});

describe('detectUnknownRuntimeOverrideKeys', () => {
  it('flags the legacy models key and other unknown runtime-overrides fields', async () => {
    const cwd = await makeTempInstall('doctor-unknown-runtime-keys');
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      fastRuntime: 'claude',
      models: { chat: 'capable' },
      extraFlag: true,
    });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectUnknownRuntimeOverrideKeys(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'unknown-runtime-override-key:models',
      'unknown-runtime-override-key:extraFlag',
    ]);
    expect(findings[0]?.autoFixable).toBe(true);
    expect(findings[1]?.autoFixable).toBe(false);
  });
});

describe('detectMissingSecrets', () => {
  it('flags missing runtime and voice-provider secrets', async () => {
    const cwd = await makeTempInstall('doctor-missing-secrets');
    await writeEnv(cwd, [
      'PRIMARY_RUNTIME=openrouter',
      'DISCOCLAW_VOICE_ENABLED=1',
      'DISCOCLAW_STT_PROVIDER=deepgram',
      'DISCOCLAW_TTS_PROVIDER=cartesia',
    ]);
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      voiceRuntime: 'openai',
    });

    const ctx = await loadDoctorContext({ cwd });
    const findings = detectMissingSecrets(ctx);

    expect(findings.map((finding) => finding.id)).toEqual([
      'missing-secret:PRIMARY_RUNTIME:OPENROUTER_API_KEY',
      'missing-secret:runtime-overrides.voiceRuntime:OPENAI_API_KEY',
      'missing-secret:DISCOCLAW_STT_PROVIDER:DEEPGRAM_API_KEY',
      'missing-secret:DISCOCLAW_TTS_PROVIDER:CARTESIA_API_KEY',
    ]);
    expect(findings.every((finding) => finding.severity === 'error')).toBe(true);
  });
});

describe('inspect', () => {
  it('returns install mode, resolved paths, and combined findings', async () => {
    const cwd = await makeTempInstall('doctor-inspect');
    await fs.mkdir(path.join(cwd, '.git'));
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'export DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL=555',
      'export PRIMARY_RUNTIME=openrouter',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'capable',
    });

    const report = await inspect({ cwd });

    expect(report.installMode).toBe('source');
    expect(report.configPaths.env).toBe(path.join(cwd, '.env'));
    expect(report.configPaths.models).toBe(path.join(cwd, 'data', 'models.json'));
    expect(report.findings.map((finding) => finding.id)).toEqual([
      'deprecated-env:RUNTIME_MODEL',
      'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
      'stale-model-override:chat',
      'missing-secret:PRIMARY_RUNTIME:OPENROUTER_API_KEY',
    ]);
  });
});

describe('applyFixes', () => {
  it('migrates export-style env vars and revalidates live state before applying fixes', async () => {
    const cwd = await makeTempInstall('doctor-apply-fixes');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'export DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL=voice-home-123',
      'PRIMARY_RUNTIME=claude',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'capable',
      fast: 'fast',
    });
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      fastRuntime: 'claude',
      voiceRuntime: 'mystery-runtime',
    });

    const report = await inspect({ cwd });
    const result = await applyFixes(report, { cwd });

    expect(result.applied).toEqual([
      'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
      'stale-model-override:chat',
      'stale-model-override:fast',
      'stale-runtime-override:fastRuntime',
      'stale-runtime-override:voiceRuntime',
    ]);
    expect(result.errors).toEqual([]);

    const envContent = await fs.readFile(path.join(cwd, '.env'), 'utf-8');
    expect(envContent).toContain('DISCOCLAW_VOICE_HOME_CHANNEL=voice-home-123');
    expect(envContent).not.toContain('DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL=');

    const modelsRaw = await fs.readFile(path.join(cwd, 'data', 'models.json'), 'utf-8');
    expect(JSON.parse(modelsRaw)).toEqual({});

    await expect(fs.readFile(path.join(cwd, 'data', 'runtime-overrides.json'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves legacy models data when pruning stale runtime overrides', async () => {
    const cwd = await makeTempInstall('doctor-apply-preserve-legacy-models');
    await writeEnv(cwd, [
      'PRIMARY_RUNTIME=claude',
    ]);
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      fastRuntime: 'claude',
      voiceRuntime: 'mystery-runtime',
      models: { summary: 'deep' },
    });

    const fullReport = await inspect({ cwd });
    const report = {
      ...fullReport,
      findings: fullReport.findings.filter((finding) => finding.id.startsWith('stale-runtime-override:')),
    };
    const result = await applyFixes(report, { cwd });

    expect(result.applied).toEqual([
      'stale-runtime-override:fastRuntime',
      'stale-runtime-override:voiceRuntime',
    ]);

    const overridesRaw = await fs.readFile(path.join(cwd, 'data', 'runtime-overrides.json'), 'utf-8');
    expect(JSON.parse(overridesRaw)).toEqual({
      models: { summary: 'deep' },
    });
  });

  it('migrates legacy runtime-overrides models into models.json before removing the legacy key', async () => {
    const cwd = await makeTempInstall('doctor-apply-legacy-model-key');
    await writeJson(path.join(cwd, 'data', 'runtime-overrides.json'), {
      models: { chat: 'gpt-5.4', summary: 'deep' },
      extraFlag: true,
    });

    const fullReport = await inspect({ cwd });
    const report = {
      ...fullReport,
      findings: fullReport.findings.filter((finding) => finding.id === 'unknown-runtime-override-key:models'),
    };
    const result = await applyFixes(report, { cwd });

    expect(result.applied).toEqual(['unknown-runtime-override-key:models']);

    const modelsRaw = await fs.readFile(path.join(cwd, 'data', 'models.json'), 'utf-8');
    expect(JSON.parse(modelsRaw)).toEqual({
      chat: 'gpt-5.4',
      summary: 'deep',
    });

    const overridesRaw = await fs.readFile(path.join(cwd, 'data', 'runtime-overrides.json'), 'utf-8');
    expect(JSON.parse(overridesRaw)).toEqual({
      extraFlag: true,
    });
  });

  it('skips fixes from stale reports after the current config has changed', async () => {
    const cwd = await makeTempInstall('doctor-apply-stale-report');
    await writeEnv(cwd, [
      'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL=voice-home-123',
    ]);

    const report = await inspect({ cwd });
    await writeEnv(cwd, [
      'DISCOCLAW_VOICE_HOME_CHANNEL=voice-home-123',
    ]);

    const result = await applyFixes(report, { cwd });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL', reason: 'finding no longer present' },
    ]);
  });

  it('skips non-auto-fixable findings', async () => {
    const cwd = await makeTempInstall('doctor-apply-skip');
    await writeEnv(cwd, [
      'RUNTIME_MODEL=capable',
      'PRIMARY_RUNTIME=openrouter',
    ]);
    await writeJson(path.join(cwd, 'data', 'models.json'), {
      chat: 'capable',
    });

    const report = await inspect({ cwd });
    const result = await applyFixes({
      ...report,
      findings: report.findings.filter((finding) => !finding.autoFixable),
    }, { cwd });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'deprecated-env:RUNTIME_MODEL', reason: 'not auto-fixable' },
      { id: 'missing-secret:PRIMARY_RUNTIME:OPENROUTER_API_KEY', reason: 'not auto-fixable' },
    ]);
  });
});
