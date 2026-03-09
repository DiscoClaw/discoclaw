import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
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

type RuntimeOverridesFileState = {
  exists: boolean;
  unknownKeys: string[];
  raw: Record<string, unknown>;
  values: RuntimeOverrides;
};

type ModelsFileState = {
  exists: boolean;
  values: ModelConfig;
  error?: string;
};

export type DoctorContext = {
  cwd: string;
  installMode: InstallMode;
  env: EnvMap;
  explicitEnvKeys: Set<string>;
  configPaths: DoctorReport['configPaths'];
  defaultDataDir: string;
  models: ModelConfig;
  modelsFile: ModelsFileState;
  runtimeOverrides: RuntimeOverrides;
  runtimeOverridesFile: RuntimeOverridesFileState;
  envDefaults: ModelConfig;
};

export const KNOWN_RUNTIMES = new Set(['claude', 'openai', 'openrouter', 'gemini', 'codex', 'anthropic']);
const KNOWN_RUNTIME_OVERRIDE_KEYS = new Set(['ttsVoice', 'voiceRuntime', 'fastRuntime']);

const DEPRECATED_ENV_VARS: Record<
  string,
  { recommendation: string; autoFixable: boolean }
> = {
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
  'plan-run': 'DISCOCLAW_PLAN_RUN_MODEL',
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

async function loadEnvFile(envPath: string): Promise<EnvFileState> {
  try {
    const raw = await fs.readFile(envPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const values: EnvMap = {};
    const keys = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      values[match[1]] = match[2];
      keys.add(match[1]);
    }
    return { exists: true, path: envPath, lines, values, keys };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, path: envPath, lines: [], values: {}, keys: new Set() };
    }
    throw err;
  }
}

async function readModelConfigReadOnly(filePath: string): Promise<ModelsFileState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        exists: true,
        values: {},
        error: 'models.json must contain a JSON object with role-to-model string entries.',
      };
    }
    const config: ModelConfig = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        config[key as ModelRole] = value;
      }
    }
    return {
      exists: true,
      values: config,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, values: {} };
    }
    return {
      exists: true,
      values: {},
      error: `Failed to read models.json: ${(err as Error).message}`,
    };
  }
}

async function readRuntimeOverridesFileState(filePath: string): Promise<RuntimeOverridesFileState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { exists: true, unknownKeys: [], raw: {}, values: {} };
    }
    const obj = parsed as Record<string, unknown>;
    const overrides: RuntimeOverrides = {};
    if (typeof obj['ttsVoice'] === 'string') overrides.ttsVoice = obj['ttsVoice'];
    if (typeof obj['voiceRuntime'] === 'string') overrides.voiceRuntime = obj['voiceRuntime'];
    if (typeof obj['fastRuntime'] === 'string') overrides.fastRuntime = obj['fastRuntime'];
    const unknownKeys = Object.keys(obj).filter((key) => !KNOWN_RUNTIME_OVERRIDE_KEYS.has(key));
    return { exists: true, unknownKeys, raw: obj, values: overrides };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, unknownKeys: [], raw: {}, values: {} };
    }
    return { exists: false, unknownKeys: [], raw: {}, values: {} };
  }
}

function buildEnvDefaults(env: EnvMap): ModelConfig {
  const runtimeModel = trimValue(env.RUNTIME_MODEL) ?? 'capable';
  const planRunModel = trimValue(env.DISCOCLAW_PLAN_RUN_MODEL) ?? 'capable';
  const fastModel = trimValue(env.DISCOCLAW_FAST_MODEL) ?? 'fast';
  const summaryModel = trimValue(env.DISCOCLAW_SUMMARY_MODEL) ?? fastModel;
  const cronModel = trimValue(env.DISCOCLAW_CRON_AUTO_TAG_MODEL) ?? fastModel;
  const cronExecModel = trimValue(env.DISCOCLAW_CRON_EXEC_MODEL) ?? 'capable';
  const voiceModel = trimValue(env.DISCOCLAW_VOICE_MODEL) ?? runtimeModel;
  const envDefaults: ModelConfig = {
    ...MODEL_DEFAULTS,
    chat: runtimeModel,
    'plan-run': planRunModel,
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
  const fastRuntime = normalizeRuntimeName(env.DISCOCLAW_FAST_RUNTIME);
  if (fastRuntime && KNOWN_RUNTIMES.has(fastRuntime)) return fastRuntime;
  return normalizeRuntimeName(env.PRIMARY_RUNTIME) ?? 'claude';
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

  const [modelsFile, runtimeOverridesFile] = await Promise.all([
    readModelConfigReadOnly(configPaths.models),
    readRuntimeOverridesFileState(configPaths.runtimeOverrides),
  ]);

  return {
    cwd,
    installMode: fileExists(path.join(cwd, '.git')) ? 'source' : 'npm-managed',
    env,
    explicitEnvKeys,
    configPaths,
    defaultDataDir: path.join(cwd, 'data'),
    models: modelsFile.values,
    modelsFile,
    runtimeOverrides: runtimeOverridesFile.values,
    runtimeOverridesFile,
    envDefaults: buildEnvDefaults(env),
  };
}

export function detectInvalidModelsFile(ctx: DoctorContext): DoctorFinding[] {
  if (!ctx.modelsFile.error) return [];
  return [{
    id: 'invalid-model-config:models-json',
    severity: 'error',
    message: `models.json could not be loaded cleanly: ${ctx.modelsFile.error}`,
    recommendation: 'Fix data/models.json so it is valid JSON with a top-level object containing string model values.',
    autoFixable: false,
  }];
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
  if (envKeyIsExplicit(ctx, 'RUNTIME_MODEL')) {
    findings.push({
      id: 'deprecated-env:RUNTIME_MODEL',
      severity: 'warn',
      message: 'RUNTIME_MODEL is deprecated and still configured.',
      recommendation: 'Move the chat default into models.json or reset the chat role so startup defaults can apply cleanly.',
      autoFixable: false,
    });
  }

  for (const [key, meta] of Object.entries(DEPRECATED_ENV_VARS)) {
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

  for (const key of ctx.runtimeOverridesFile.unknownKeys) {
    if (key === 'models') {
      findings.push({
        id: 'legacy-runtime-overrides-key:models',
        severity: 'warn',
        message: 'runtime-overrides.json still contains the legacy "models" key, which is ignored by the current config loader.',
        recommendation: 'Rewrite runtime-overrides.json so it keeps only supported keys.',
        autoFixable: true,
      });
      continue;
    }

    findings.push({
      id: `unknown-runtime-override-key:${key}`,
      severity: 'warn',
      message: `runtime-overrides.json contains unknown key "${key}", which is ignored by the current config loader.`,
      recommendation: 'Remove the unknown key from runtime-overrides.json or rename it to a supported override.',
      autoFixable: false,
    });
  }

  for (const [role, storedValue] of Object.entries(ctx.models) as Array<[ModelRole, string]>) {
    const envDefault = trimValue(ctx.envDefaults[role]);
    if (!envDefault || trimValue(storedValue) !== envDefault) continue;
    findings.push({
      id: `stale-model-override:${role}`,
      severity: 'info',
      message: `models.json stores ${role}="${storedValue}", which now matches the startup default and is redundant.`,
      recommendation:
        `Remove the redundant ${role} entry from models.json so future env default changes can flow through.`,
      autoFixable: false,
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

export function detectInvalidPersistedModelAssignments(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const [role, storedValue] of Object.entries(ctx.models) as Array<[ModelRole, string]>) {
    const runtimeName = normalizeRuntimeName(storedValue);
    if (!runtimeName || !KNOWN_RUNTIMES.has(runtimeName)) continue;

    if (role === 'chat') {
      findings.push({
        id: `invalid-model-assignment:${role}`,
        severity: 'warn',
        message: `models.json stores chat="${storedValue}", but chat runtime swaps are live-only and this value will be treated as a model string on restart.`,
        recommendation: 'Store a concrete chat model in models.json, or change PRIMARY_RUNTIME in .env if the default chat runtime should change after restart.',
        autoFixable: false,
      });
      continue;
    }

    if (role === 'voice') {
      findings.push({
        id: `invalid-model-assignment:${role}`,
        severity: 'warn',
        message: `models.json stores voice="${storedValue}", but persisted voice runtime selection belongs in runtime-overrides.json as voiceRuntime.`,
        recommendation: 'Move the runtime name into runtime-overrides.json (voiceRuntime) or replace the voice entry with a concrete model string.',
        autoFixable: false,
      });
      continue;
    }

    findings.push({
      id: `invalid-model-assignment:${role}`,
      severity: 'warn',
      message: `models.json stores ${role}="${storedValue}", but runtime names are not valid persisted model values for that role.`,
      recommendation: `Replace ${role} with a concrete model string or clear the override so startup defaults apply.`,
      autoFixable: false,
    });
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

  const coldStorageEnabled = parseBoolean(ctx.env.DISCOCLAW_COLD_STORAGE_ENABLED, false);
  if (coldStorageEnabled && !hasSecret(ctx.env, 'COLD_STORAGE_API_KEY') && !hasSecret(ctx.env, 'OPENAI_API_KEY')) {
    findings.push({
      id: 'missing-secret:DISCOCLAW_COLD_STORAGE_ENABLED:COLD_STORAGE_API_KEY-or-OPENAI_API_KEY',
      severity: 'error',
      message: 'DISCOCLAW_COLD_STORAGE_ENABLED=1 but neither COLD_STORAGE_API_KEY nor OPENAI_API_KEY is set.',
      recommendation: 'Set COLD_STORAGE_API_KEY or OPENAI_API_KEY, or disable cold storage on this install.',
      autoFixable: false,
    });
  }

  const imagegenEnabled = parseBoolean(ctx.env.DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN, false);
  if (imagegenEnabled && !hasSecret(ctx.env, 'OPENAI_API_KEY') && !hasSecret(ctx.env, 'IMAGEGEN_GEMINI_API_KEY')) {
    findings.push({
      id: 'missing-secret:DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN:OPENAI_API_KEY-or-IMAGEGEN_GEMINI_API_KEY',
      severity: 'error',
      message: 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1 but neither OPENAI_API_KEY nor IMAGEGEN_GEMINI_API_KEY is set.',
      recommendation: 'Set OPENAI_API_KEY or IMAGEGEN_GEMINI_API_KEY, or disable image generation actions on this install.',
      autoFixable: false,
    });
  }

  const imagegenDefaultModel = trimValue(ctx.env.IMAGEGEN_DEFAULT_MODEL);
  if (imagegenDefaultModel) {
    if ((imagegenDefaultModel.startsWith('imagen-') || imagegenDefaultModel.startsWith('gemini-')) && !hasSecret(ctx.env, 'IMAGEGEN_GEMINI_API_KEY')) {
      findings.push({
        id: 'missing-secret:IMAGEGEN_DEFAULT_MODEL:IMAGEGEN_GEMINI_API_KEY',
        severity: 'error',
        message: `IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires IMAGEGEN_GEMINI_API_KEY, but it is not set.`,
        recommendation: 'Set IMAGEGEN_GEMINI_API_KEY or choose an imagegen model that uses a configured provider.',
        autoFixable: false,
      });
    } else if ((imagegenDefaultModel.startsWith('dall-e-') || imagegenDefaultModel.startsWith('gpt-image-')) && !hasSecret(ctx.env, 'OPENAI_API_KEY')) {
      findings.push({
        id: 'missing-secret:IMAGEGEN_DEFAULT_MODEL:OPENAI_API_KEY',
        severity: 'error',
        message: `IMAGEGEN_DEFAULT_MODEL="${imagegenDefaultModel}" requires OPENAI_API_KEY, but it is not set.`,
        recommendation: 'Set OPENAI_API_KEY or choose an imagegen model that uses a configured provider.',
        autoFixable: false,
      });
    }
  }

  return findings;
}

export async function inspect(opts: InspectOptions = {}): Promise<DoctorReport> {
  const ctx = await loadDoctorContext(opts);
  const findings = [
    ...detectInvalidModelsFile(ctx),
    ...detectInstallDrift(ctx),
    ...detectDeprecatedEnvVars(ctx),
    ...detectConflictingOverrides(ctx),
    ...detectStaleRuntimeAndModelOverrides(ctx),
    ...detectInvalidPersistedModelAssignments(ctx),
    ...detectMissingSecrets(ctx),
  ];

  return {
    installMode: ctx.installMode,
    findings,
    configPaths: ctx.configPaths,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commentMigratedEnvKey(lines: string[], key: string): string[] {
  const pattern = new RegExp(`^(\\s*)(${escapeRegex(key)}=.*)$`);
  return lines.map((line) => {
    const match = line.match(pattern);
    if (!match) return line;
    return `${match[1]}# [doctor-migrated] ${match[2]}`;
  });
}

function setEnvKey(lines: string[], key: string, value: string): string[] {
  const nextLines = [...lines];
  const pattern = new RegExp(`^\\s*${key}=`);
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
  const tmpPath = `${envPath}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, normalized, 'utf-8');
    await fs.rename(tmpPath, envPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function writeJsonObject(filePath: string, value: Record<string, unknown>): Promise<void> {
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
  const result: FixResult = { applied: [], skipped: [], errors: [] };
  const requestedIds = new Set(report.findings.map((finding) => finding.id));
  const autoFixableIds = new Set(
    report.findings.filter((finding) => finding.autoFixable).map((finding) => finding.id),
  );

  const envFile = await loadEnvFile(ctx.configPaths.env);
  let envLines = [...envFile.lines];
  let envChanged = false;

  const nextModels: ModelConfig = { ...ctx.models };
  let modelsChanged = false;
  const pendingModelIds: string[] = [];

  const nextOverridesFile = { ...ctx.runtimeOverridesFile.raw };
  let overridesChanged = false;
  const pendingOverrideIds: string[] = [];
  const pendingEnvIds: string[] = [];

  for (const id of requestedIds) {
    if (!autoFixableIds.has(id)) {
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
        envLines = commentMigratedEnvKey(envLines, 'DISCOCLAW_VOICE_TRANSCRIPT_CHANNEL');
        envChanged = true;
        pendingEnvIds.push(id);
        continue;
      }

      if (id === 'legacy-runtime-overrides-key:models') {
        if (!ctx.runtimeOverridesFile.exists) {
          result.skipped.push({ id, reason: 'runtime-overrides.json not found' });
          continue;
        }
        if (!ctx.runtimeOverridesFile.unknownKeys.includes('models')) {
          result.skipped.push({ id, reason: 'legacy models key already absent' });
          continue;
        }
        delete nextOverridesFile.models;
        overridesChanged = true;
        pendingOverrideIds.push(id);
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
        pendingModelIds.push(id);
        continue;
      }

      if (id === 'stale-runtime-override:fastRuntime') {
        if (typeof nextOverridesFile.fastRuntime !== 'string') {
          result.skipped.push({ id, reason: 'fastRuntime override already absent' });
          continue;
        }
        delete nextOverridesFile.fastRuntime;
        overridesChanged = true;
        pendingOverrideIds.push(id);
        continue;
      }

      if (id === 'stale-runtime-override:voiceRuntime') {
        if (typeof nextOverridesFile.voiceRuntime !== 'string') {
          result.skipped.push({ id, reason: 'voiceRuntime override already absent' });
          continue;
        }
        delete nextOverridesFile.voiceRuntime;
        overridesChanged = true;
        pendingOverrideIds.push(id);
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
    result.applied.push(...pendingEnvIds);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    for (const id of pendingEnvIds) {
      result.errors.push({ id, message });
    }
  }

  try {
    if (modelsChanged) {
      await saveModelConfig(ctx.configPaths.models, nextModels);
    }
    result.applied.push(...pendingModelIds);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    for (const id of pendingModelIds) {
      result.errors.push({ id, message });
    }
  }

  try {
    if (overridesChanged) {
      if (Object.keys(nextOverridesFile).length === 0) {
        await clearOverrides(ctx.configPaths.runtimeOverrides);
      } else {
        await writeJsonObject(ctx.configPaths.runtimeOverrides, nextOverridesFile);
      }
    }
    result.applied.push(...pendingOverrideIds);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    for (const id of pendingOverrideIds) {
      result.errors.push({ id, message });
    }
  }

  return result;
}
