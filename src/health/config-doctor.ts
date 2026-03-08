import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { ModelConfig, ModelRole } from '../model-config.js';
import { DEFAULTS as MODEL_DEFAULTS, saveModelConfig } from '../model-config.js';
import type { RuntimeOverrides } from '../runtime-overrides.js';
import { clearOverrides } from '../runtime-overrides.js';

export type DoctorSeverity = 'info' | 'warn' | 'error';
export type InstallMode = 'source' | 'npm-managed';

export type DoctorFinding = {
  id: string;
  severity: DoctorSeverity;
  message: string;
  recommendation: string;
  autoFixable: boolean;
};

export type DoctorReport = {
  installMode: InstallMode;
  findings: DoctorFinding[];
  configPaths: {
    cwd: string;
    env: string;
    dataDir: string;
    models: string;
    runtimeOverrides: string;
  };
};

export type FixResult = {
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; message: string }>;
};

export type InspectOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type EnvMap = Record<string, string | undefined>;

type EnvFileState = {
  exists: boolean;
  path: string;
  lines: string[];
  values: EnvMap;
  keys: Set<string>;
};

type ModelFileState = {
  exists: boolean;
  path: string;
  config: ModelConfig;
};

type RuntimeOverridesFileState = {
  exists: boolean;
  path: string;
  rawObject: Record<string, unknown>;
  overrides: RuntimeOverrides;
  unknownKeys: string[];
  legacyModels: ModelConfig;
};

export type DoctorContext = {
  cwd: string;
  installMode: InstallMode;
  env: EnvMap;
  explicitEnvKeys: Set<string>;
  configPaths: DoctorReport['configPaths'];
  defaultDataDir: string;
  modelFileExists: boolean;
  models: ModelConfig;
  runtimeOverrides: RuntimeOverrides;
  runtimeOverridesFile: RuntimeOverridesFileState;
  envDefaults: ModelConfig;
};

const KNOWN_RUNTIMES = new Set(['claude', 'openai', 'openrouter', 'gemini', 'codex', 'anthropic']);
const KNOWN_RUNTIME_OVERRIDE_KEYS = new Set(['ttsVoice', 'voiceRuntime', 'fastRuntime']);
const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

const DEPRECATED_ENV_VARS: Record<
  string,
  { recommendation: string; autoFixable: boolean }
> = {
  RUNTIME_MODEL: {
    recommendation: 'Move the chat default into models.json or reset the chat role so startup defaults can apply cleanly.',
    autoFixable: false,
  },
  DISCOCLAW_FAST_MODEL: {
    recommendation: 'Move the fast default into models.json or clear redundant fast-tier overrides so startup defaults come from the current config.',
    autoFixable: false,
  },
  DISCOCLAW_FAST_RUNTIME: {
    recommendation: "Replace DISCOCLAW_FAST_RUNTIME with '!models set fast <model>' and remove the env var once the runtime override is no longer needed.",
    autoFixable: false,
  },
  DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL: {
    recommendation: 'Rename DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL to DISCOCLAW_VOICE_HOME_CHANNEL.',
    autoFixable: true,
  },
};

const ROLE_ENV_KEYS: Partial<Record<ModelRole, string>> = {
  chat: 'RUNTIME_MODEL',
  fast: 'DISCOCLAW_FAST_MODEL',
  summary: 'DISCOCLAW_SUMMARY_MODEL',
  cron: 'DISCOCLAW_CRON_AUTO_TAG_MODEL',
  'cron-exec': 'DISCOCLAW_CRON_EXEC_MODEL',
  voice: 'DISCOCLAW_VOICE_MODEL',
  'forge-drafter': 'FORGE_DRAFTER_MODEL',
  'forge-auditor': 'FORGE_AUDITOR_MODEL',
};

function trimValue(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeRuntimeName(value: string | undefined): string | undefined {
  const trimmed = trimValue(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  return normalized === 'claude_code' ? 'claude' : normalized;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  const trimmed = trimValue(value);
  if (!trimmed) return defaultValue;
  const normalized = trimmed.toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return defaultValue;
}

function resolvePath(cwd: string, maybeRelative: string | undefined, fallback: string): string {
  const trimmed = trimValue(maybeRelative);
  if (!trimmed) return path.join(cwd, fallback);
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toModelConfig(value: unknown): ModelConfig {
  if (!isRecord(value)) return {};
  const config: ModelConfig = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      config[key as ModelRole] = entry;
    }
  }
  return config;
}

async function loadEnvFile(envPath: string): Promise<EnvFileState> {
  try {
    const raw = await fs.readFile(envPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const values: EnvMap = { ...parseDotenv(raw) };
    const keys = new Set<string>();
    for (const line of lines) {
      const match = line.match(ENV_KEY_RE);
      if (match) keys.add(match[1]);
    }
    return { exists: true, path: envPath, lines, values, keys };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, path: envPath, lines: [], values: {}, keys: new Set() };
    }
    throw err;
  }
}

async function readModelConfigReadOnly(filePath: string): Promise<ModelFileState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return { exists: true, path: filePath, config: toModelConfig(JSON.parse(raw)) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, path: filePath, config: {} };
    }
    return { exists: true, path: filePath, config: {} };
  }
}

async function readRuntimeOverridesReadOnly(filePath: string): Promise<RuntimeOverridesFileState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const obj = isRecord(parsed) ? parsed : {};
    const overrides: RuntimeOverrides = {};
    if (typeof obj['ttsVoice'] === 'string') overrides.ttsVoice = obj['ttsVoice'];
    if (typeof obj['voiceRuntime'] === 'string') overrides.voiceRuntime = obj['voiceRuntime'];
    if (typeof obj['fastRuntime'] === 'string') overrides.fastRuntime = obj['fastRuntime'];
    const legacyModels = toModelConfig(obj['models']);
    const unknownKeys = Object.keys(obj).filter((key) => !KNOWN_RUNTIME_OVERRIDE_KEYS.has(key));
    return {
      exists: true,
      path: filePath,
      rawObject: { ...obj },
      overrides,
      unknownKeys,
      legacyModels,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        path: filePath,
        rawObject: {},
        overrides: {},
        unknownKeys: [],
        legacyModels: {},
      };
    }
    return {
      exists: true,
      path: filePath,
      rawObject: {},
      overrides: {},
      unknownKeys: [],
      legacyModels: {},
    };
  }
}

function buildEnvDefaults(env: EnvMap): ModelConfig {
  const runtimeModel = trimValue(env.RUNTIME_MODEL) ?? 'capable';
  const fastModel = trimValue(env.DISCOCLAW_FAST_MODEL) ?? 'fast';
  const summaryModel = trimValue(env.DISCOCLAW_SUMMARY_MODEL) ?? fastModel;
  const cronModel = trimValue(env.DISCOCLAW_CRON_AUTO_TAG_MODEL) ?? fastModel;
  const cronExecModel = trimValue(env.DISCOCLAW_CRON_EXEC_MODEL) ?? 'capable';
  const voiceModel = trimValue(env.DISCOCLAW_VOICE_MODEL) ?? runtimeModel;
  const envDefaults: ModelConfig = {
    ...MODEL_DEFAULTS,
    chat: runtimeModel,
    fast: fastModel,
    summary: summaryModel,
    cron: cronModel,
    'cron-exec': cronExecModel,
    voice: voiceModel,
  };

  const forgeDrafterModel = trimValue(env.FORGE_DRAFTER_MODEL);
  if (forgeDrafterModel) envDefaults['forge-drafter'] = forgeDrafterModel;
  const forgeAuditorModel = trimValue(env.FORGE_AUDITOR_MODEL);
  if (forgeAuditorModel) envDefaults['forge-auditor'] = forgeAuditorModel;

  return envDefaults;
}

function defaultFastRuntime(env: EnvMap): string {
  return normalizeRuntimeName(env.DISCOCLAW_FAST_RUNTIME)
    ?? normalizeRuntimeName(env.PRIMARY_RUNTIME)
    ?? 'claude';
}

function defaultVoiceRuntime(env: EnvMap): string {
  const primaryRuntime = normalizeRuntimeName(env.PRIMARY_RUNTIME) ?? 'claude';
  const voiceEnabled = parseBoolean(env.DISCOCLAW_VOICE_ENABLED, false);
  if (voiceEnabled && trimValue(env.ANTHROPIC_API_KEY)) {
    return 'anthropic';
  }
  return primaryRuntime;
}

function runtimeSecret(runtime: string | undefined): string | undefined {
  switch (runtime) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    default:
      return undefined;
  }
}

function hasSecret(env: EnvMap, key: string): boolean {
  return trimValue(env[key]) !== undefined;
}

function envKeyIsExplicit(ctx: DoctorContext, key: string): boolean {
  return ctx.explicitEnvKeys.has(key);
}

export async function loadDoctorContext(opts: InspectOptions = {}): Promise<DoctorContext> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const envPath = path.join(cwd, '.env');
  const envFile = await loadEnvFile(envPath);
  const explicitEnvKeys = new Set<string>([
    ...envFile.keys,
    ...Object.keys(opts.env ?? {}),
  ]);
  const env: EnvMap = { ...envFile.values, ...(opts.env ?? {}) };

  const dataDir = resolvePath(cwd, env.DISCOCLAW_DATA_DIR, 'data');
  const configPaths = {
    cwd,
    env: envPath,
    dataDir,
    models: path.join(dataDir, 'models.json'),
    runtimeOverrides: path.join(dataDir, 'runtime-overrides.json'),
  };

  const [modelFile, runtimeOverridesFile] = await Promise.all([
    readModelConfigReadOnly(configPaths.models),
    readRuntimeOverridesReadOnly(configPaths.runtimeOverrides),
  ]);
  const models = modelFile.exists
    ? modelFile.config
    : Object.keys(runtimeOverridesFile.legacyModels).length > 0
      ? runtimeOverridesFile.legacyModels
      : {};

  return {
    cwd,
    installMode: fileExists(path.join(cwd, '.git')) ? 'source' : 'npm-managed',
    env,
    explicitEnvKeys,
    configPaths,
    defaultDataDir: path.join(cwd, 'data'),
    modelFileExists: modelFile.exists,
    models,
    runtimeOverrides: runtimeOverridesFile.overrides,
    runtimeOverridesFile,
    envDefaults: buildEnvDefaults(env),
  };
}

export function detectInstallDrift(ctx: DoctorContext): DoctorFinding[] {
  if (ctx.configPaths.dataDir === ctx.defaultDataDir) return [];

  const defaultModels = path.join(ctx.defaultDataDir, 'models.json');
  const defaultOverrides = path.join(ctx.defaultDataDir, 'runtime-overrides.json');
  const stalePaths = [defaultModels, defaultOverrides].filter(fileExists);
  if (stalePaths.length === 0) return [];

  return [{
    id: 'install-drift:split-data-dir',
    severity: 'warn',
    message:
      `Active config uses ${ctx.configPaths.dataDir}, but stale state files also exist under ${ctx.defaultDataDir}.`,
    recommendation:
      'Choose one authoritative data dir, migrate any live state you still need, and remove the stale copy so future edits do not split across installs.',
    autoFixable: false,
  }];
}

export function detectDeprecatedEnvVars(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const [key, meta] of Object.entries(DEPRECATED_ENV_VARS)) {
    if (key === 'RUNTIME_MODEL' && !ctx.modelFileExists) continue;
    if (!envKeyIsExplicit(ctx, key)) continue;
    findings.push({
      id: `deprecated-env:${key}`,
      severity: 'warn',
      message: `${key} is deprecated and still configured.`,
      recommendation: meta.recommendation,
      autoFixable: meta.autoFixable,
    });
  }
  return findings;
}

export function detectUnknownRuntimeOverrideKeys(ctx: DoctorContext): DoctorFinding[] {
  return ctx.runtimeOverridesFile.unknownKeys.map((key) => ({
    id: `unknown-runtime-override-key:${key}`,
    severity: 'warn',
    message:
      key === 'models'
        ? 'runtime-overrides.json still contains the legacy models key.'
        : `runtime-overrides.json contains unknown key "${key}".`,
    recommendation:
      key === 'models'
        ? 'Migrate any legacy model entries into models.json, then remove the legacy models key.'
        : `Remove "${key}" from runtime-overrides.json or migrate it to a supported config location.`,
    autoFixable: key === 'models',
  }));
}

export function detectConflictingOverrides(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const [role, envKey] of Object.entries(ROLE_ENV_KEYS) as Array<[ModelRole, string]>) {
    if (!envKeyIsExplicit(ctx, envKey)) continue;
    const stored = trimValue(ctx.models[role]);
    const envDefault = trimValue(ctx.envDefaults[role]);
    if (!stored || !envDefault || stored === envDefault) continue;
    findings.push({
      id: `conflicting-model-override:${role}`,
      severity: 'warn',
      message: `models.json keeps ${role} on "${stored}", so ${envKey}="${envDefault}" will not take effect on restart.`,
      recommendation:
        `Update models.json for ${role} or reset that role so the startup default from ${envKey} can apply cleanly.`,
      autoFixable: false,
    });
  }

  const fastRuntimeEnv = normalizeRuntimeName(ctx.env.DISCOCLAW_FAST_RUNTIME);
  const fastRuntimeFile = normalizeRuntimeName(ctx.runtimeOverrides.fastRuntime);
  if (fastRuntimeEnv && fastRuntimeFile && fastRuntimeEnv !== fastRuntimeFile) {
    findings.push({
      id: 'conflicting-runtime-override:fastRuntime',
      severity: 'warn',
      message:
        `runtime-overrides.json keeps fastRuntime="${fastRuntimeFile}", but DISCOCLAW_FAST_RUNTIME="${fastRuntimeEnv}" is also set.`,
      recommendation:
        'Pick one fast runtime source of truth. Prefer the modern runtime-overrides/models flow and remove the deprecated env var when possible.',
      autoFixable: false,
    });
  }

  return findings;
}

export function detectStaleRuntimeAndModelOverrides(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const [role, storedValue] of Object.entries(ctx.models) as Array<[ModelRole, string]>) {
    const envDefault = trimValue(ctx.envDefaults[role]);
    if (!envDefault || trimValue(storedValue) !== envDefault) continue;
    findings.push({
      id: `stale-model-override:${role}`,
      severity: 'warn',
      message: `models.json stores ${role}="${storedValue}", which now matches the startup default and is redundant.`,
      recommendation:
        `Remove the redundant ${role} entry from models.json so future env default changes can flow through.`,
      autoFixable: true,
    });
  }

  const fastRuntime = normalizeRuntimeName(ctx.runtimeOverrides.fastRuntime);
  if (fastRuntime) {
    if (!KNOWN_RUNTIMES.has(fastRuntime)) {
      findings.push({
        id: 'stale-runtime-override:fastRuntime',
        severity: 'warn',
        message: `runtime-overrides.json has fastRuntime="${ctx.runtimeOverrides.fastRuntime}", which is not a known runtime.`,
        recommendation: 'Remove the stale fastRuntime override.',
        autoFixable: true,
      });
    } else if (fastRuntime === defaultFastRuntime(ctx.env)) {
      findings.push({
        id: 'stale-runtime-override:fastRuntime',
        severity: 'warn',
        message: `runtime-overrides.json stores fastRuntime="${ctx.runtimeOverrides.fastRuntime}", which matches the startup default and is redundant.`,
        recommendation: 'Remove the redundant fastRuntime override.',
        autoFixable: true,
      });
    }
  }

  const voiceRuntime = normalizeRuntimeName(ctx.runtimeOverrides.voiceRuntime);
  if (voiceRuntime) {
    if (!KNOWN_RUNTIMES.has(voiceRuntime)) {
      findings.push({
        id: 'stale-runtime-override:voiceRuntime',
        severity: 'warn',
        message: `runtime-overrides.json has voiceRuntime="${ctx.runtimeOverrides.voiceRuntime}", which is not a known runtime.`,
        recommendation: 'Remove the stale voiceRuntime override.',
        autoFixable: true,
      });
    } else if (voiceRuntime === defaultVoiceRuntime(ctx.env)) {
      findings.push({
        id: 'stale-runtime-override:voiceRuntime',
        severity: 'warn',
        message: `runtime-overrides.json stores voiceRuntime="${ctx.runtimeOverrides.voiceRuntime}", which matches the startup default and is redundant.`,
        recommendation: 'Remove the redundant voiceRuntime override.',
        autoFixable: true,
      });
    }
  }

  return findings;
}

export function detectMissingSecrets(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const runtimeTargets: Array<{ label: string; runtime: string | undefined }> = [
    { label: 'PRIMARY_RUNTIME', runtime: normalizeRuntimeName(ctx.env.PRIMARY_RUNTIME) },
    { label: 'DISCOCLAW_FAST_RUNTIME', runtime: normalizeRuntimeName(ctx.env.DISCOCLAW_FAST_RUNTIME) },
    { label: 'FORGE_DRAFTER_RUNTIME', runtime: normalizeRuntimeName(ctx.env.FORGE_DRAFTER_RUNTIME) },
    { label: 'FORGE_AUDITOR_RUNTIME', runtime: normalizeRuntimeName(ctx.env.FORGE_AUDITOR_RUNTIME) },
    { label: 'runtime-overrides.fastRuntime', runtime: normalizeRuntimeName(ctx.runtimeOverrides.fastRuntime) },
    { label: 'runtime-overrides.voiceRuntime', runtime: normalizeRuntimeName(ctx.runtimeOverrides.voiceRuntime) },
  ];

  for (const target of runtimeTargets) {
    const secretKey = runtimeSecret(target.runtime);
    if (!secretKey || hasSecret(ctx.env, secretKey)) continue;
    findings.push({
      id: `missing-secret:${target.label}:${secretKey}`,
      severity: 'error',
      message: `${target.label} selects ${target.runtime}, but ${secretKey} is not set.`,
      recommendation: `Set ${secretKey} or change ${target.label} to a runtime that is configured on this install.`,
      autoFixable: false,
    });
  }

  const voiceEnabled = parseBoolean(ctx.env.DISCOCLAW_VOICE_ENABLED, false);
  if (voiceEnabled) {
    const sttProvider = trimValue(ctx.env.DISCOCLAW_STT_PROVIDER) ?? 'deepgram';
    const ttsProvider = trimValue(ctx.env.DISCOCLAW_TTS_PROVIDER) ?? 'cartesia';
    const voiceSecretTargets: Array<{ label: string; provider: string; secretKey: string }> = [];
    if (sttProvider === 'deepgram') {
      voiceSecretTargets.push({ label: 'DISCOCLAW_STT_PROVIDER', provider: sttProvider, secretKey: 'DEEPGRAM_API_KEY' });
    } else if (sttProvider === 'openai') {
      voiceSecretTargets.push({ label: 'DISCOCLAW_STT_PROVIDER', provider: sttProvider, secretKey: 'OPENAI_API_KEY' });
    }

    if (ttsProvider === 'cartesia') {
      voiceSecretTargets.push({ label: 'DISCOCLAW_TTS_PROVIDER', provider: ttsProvider, secretKey: 'CARTESIA_API_KEY' });
    } else if (ttsProvider === 'deepgram') {
      voiceSecretTargets.push({ label: 'DISCOCLAW_TTS_PROVIDER', provider: ttsProvider, secretKey: 'DEEPGRAM_API_KEY' });
    } else if (ttsProvider === 'openai') {
      voiceSecretTargets.push({ label: 'DISCOCLAW_TTS_PROVIDER', provider: ttsProvider, secretKey: 'OPENAI_API_KEY' });
    }

    for (const target of voiceSecretTargets) {
      if (hasSecret(ctx.env, target.secretKey)) continue;
      findings.push({
        id: `missing-secret:${target.label}:${target.secretKey}`,
        severity: 'error',
        message: `${target.label}=${target.provider} requires ${target.secretKey}, but it is not set.`,
        recommendation: `Set ${target.secretKey} or switch ${target.label} to a provider that is already configured.`,
        autoFixable: false,
      });
    }
  }

  return findings;
}

function collectFindings(ctx: DoctorContext): DoctorFinding[] {
  return [
    ...detectInstallDrift(ctx),
    ...detectDeprecatedEnvVars(ctx),
    ...detectConflictingOverrides(ctx),
    ...detectUnknownRuntimeOverrideKeys(ctx),
    ...detectStaleRuntimeAndModelOverrides(ctx),
    ...detectMissingSecrets(ctx),
  ];
}

export async function inspect(opts: InspectOptions = {}): Promise<DoctorReport> {
  const ctx = await loadDoctorContext(opts);
  const findings = collectFindings(ctx);

  return {
    installMode: ctx.installMode,
    findings,
    configPaths: ctx.configPaths,
  };
}

function envKeyPattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}=`);
}

function removeEnvKey(lines: string[], key: string): string[] {
  const pattern = envKeyPattern(key);
  return lines.filter((line) => !pattern.test(line));
}

function setEnvKey(lines: string[], key: string, value: string): string[] {
  const nextLines = [...lines];
  const pattern = envKeyPattern(key);
  const lineIndex = nextLines.findIndex((line) => pattern.test(line));
  const rendered = `${key}=${value}`;
  if (lineIndex >= 0) {
    nextLines[lineIndex] = rendered;
    return nextLines.filter((line, idx) => idx === lineIndex || !pattern.test(line));
  }
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop();
  }
  nextLines.push(rendered, '');
  return nextLines;
}

async function writeEnvLines(envPath: string, lines: string[]): Promise<void> {
  const body = lines.join('\n');
  const normalized = body.endsWith('\n') ? body : `${body}\n`;
  await fs.writeFile(envPath, normalized, 'utf-8');
}

async function writeJsonFile(filePath: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function applyFixes(report: DoctorReport, opts: InspectOptions = {}): Promise<FixResult> {
  const ctx = await loadDoctorContext(opts);
  const liveFindings = collectFindings(ctx);
  const liveFindingsById = new Map(liveFindings.map((finding) => [finding.id, finding]));
  const result: FixResult = { applied: [], skipped: [], errors: [] };
  const requestedIds = new Set(report.findings.map((finding) => finding.id));

  const envFile = await loadEnvFile(ctx.configPaths.env);
  let envLines = [...envFile.lines];
  let envChanged = false;

  const nextModels: ModelConfig = { ...ctx.models };
  let modelsChanged = false;

  const nextOverridesRaw: Record<string, unknown> = { ...ctx.runtimeOverridesFile.rawObject };
  let overridesChanged = false;

  for (const id of requestedIds) {
    const liveFinding = liveFindingsById.get(id);
    if (!liveFinding) {
      result.skipped.push({ id, reason: 'finding no longer present' });
      continue;
    }
    if (!liveFinding.autoFixable) {
      result.skipped.push({ id, reason: 'not auto-fixable' });
      continue;
    }

    try {
      if (id === 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL') {
        if (!envFile.exists) {
          result.skipped.push({ id, reason: '.env file not found' });
          continue;
        }
        const legacyValue = ctx.env.DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL;
        if (trimValue(legacyValue) === undefined) {
          result.skipped.push({ id, reason: 'deprecated env var already absent' });
          continue;
        }
        if (trimValue(ctx.env.DISCOCLAW_VOICE_HOME_CHANNEL) === undefined) {
          envLines = setEnvKey(envLines, 'DISCOCLAW_VOICE_HOME_CHANNEL', legacyValue ?? '');
        }
        envLines = removeEnvKey(envLines, 'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL');
        envChanged = true;
        result.applied.push(id);
        continue;
      }

      if (id.startsWith('stale-model-override:')) {
        const role = id.slice('stale-model-override:'.length) as ModelRole;
        if (!(role in nextModels)) {
          result.skipped.push({ id, reason: 'model override already absent' });
          continue;
        }
        delete nextModels[role];
        modelsChanged = true;
        result.applied.push(id);
        continue;
      }

      if (id === 'stale-runtime-override:fastRuntime') {
        if (typeof nextOverridesRaw['fastRuntime'] !== 'string') {
          result.skipped.push({ id, reason: 'fastRuntime override already absent' });
          continue;
        }
        delete nextOverridesRaw['fastRuntime'];
        overridesChanged = true;
        result.applied.push(id);
        continue;
      }

      if (id === 'stale-runtime-override:voiceRuntime') {
        if (typeof nextOverridesRaw['voiceRuntime'] !== 'string') {
          result.skipped.push({ id, reason: 'voiceRuntime override already absent' });
          continue;
        }
        delete nextOverridesRaw['voiceRuntime'];
        overridesChanged = true;
        result.applied.push(id);
        continue;
      }

      if (id === 'unknown-runtime-override-key:models') {
        if (!('models' in nextOverridesRaw)) {
          result.skipped.push({ id, reason: 'legacy models key already absent' });
          continue;
        }
        delete nextOverridesRaw['models'];
        if (!ctx.modelFileExists && Object.keys(nextModels).length > 0) {
          modelsChanged = true;
        }
        overridesChanged = true;
        result.applied.push(id);
        continue;
      }

      result.skipped.push({ id, reason: 'no fixer registered' });
    } catch (err: unknown) {
      result.errors.push({
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    if (envChanged) {
      await writeEnvLines(ctx.configPaths.env, envLines);
    }
  } catch (err: unknown) {
    result.errors.push({
      id: 'deprecated-env:DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    if (modelsChanged) {
      await saveModelConfig(ctx.configPaths.models, nextModels);
    }
  } catch (err: unknown) {
    result.errors.push({
      id: 'stale-model-override',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    if (overridesChanged) {
      if (Object.keys(nextOverridesRaw).length === 0) {
        await clearOverrides(ctx.configPaths.runtimeOverrides);
      } else {
        await writeJsonFile(ctx.configPaths.runtimeOverrides, nextOverridesRaw);
      }
    }
  } catch (err: unknown) {
    result.errors.push({
      id: 'stale-runtime-override',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
