import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole =
  | 'chat'
  | 'fast'
  | 'forge-drafter'
  | 'forge-auditor'
  | 'summary'
  | 'cron'
  | 'cron-exec'
  | 'voice';

/** Record mapping each model role to its model string. */
export type ModelConfig = Partial<Record<ModelRole, string>>;

/** Result of loading models.json — distinguishes loaded / missing / corrupt. */
export type LoadResult =
  | { status: 'loaded'; config: ModelConfig }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS: Readonly<ModelConfig> = {
  chat: 'capable',
  fast: 'fast',
  summary: 'fast',
  'forge-drafter': 'capable',
  'forge-auditor': 'capable',
  cron: 'fast',
  'cron-exec': 'capable',
  voice: 'capable',
};

const MODELS_FILENAME = 'models.json';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to models.json.
 * Uses the configured data dir when present, otherwise defaults to `<projectRoot>/data`.
 */
export function resolveModelsJsonPath(dataDir: string | undefined, projectRoot: string): string {
  const configured = (dataDir ?? '').trim();
  const baseDir = configured || path.join(projectRoot, 'data');
  return path.join(baseDir, MODELS_FILENAME);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load models.json, returning a discriminated result.
 *
 * - `loaded` — file existed and parsed successfully.
 * - `missing` — file does not exist (ENOENT).
 * - `corrupt` — file exists but is not valid JSON or not an object.
 *   On corrupt: warns via `onWarn`, backs up the file to `models.json.corrupt.<timestamp>`,
 *   and returns the `corrupt` result.
 */
export async function loadModelConfig(
  filePath: string,
  onWarn?: (msg: string, data?: unknown) => void,
): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const errorMsg = `corrupt JSON in models.json: ${(e as Error).message}`;
    onWarn?.(errorMsg, { filePath });
    await backupCorrupt(filePath);
    return { status: 'corrupt', error: errorMsg };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const errorMsg = 'models.json root is not an object';
    onWarn?.(errorMsg, { filePath });
    await backupCorrupt(filePath);
    return { status: 'corrupt', error: errorMsg };
  }

  const obj = parsed as Record<string, unknown>;
  const config: ModelConfig = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      config[key as ModelRole] = val;
    }
  }
  return { status: 'loaded', config };
}

async function backupCorrupt(filePath: string): Promise<void> {
  const backupPath = `${filePath}.corrupt.${Date.now()}`;
  try {
    await fs.rename(filePath, backupPath);
  } catch {
    // Best-effort — if rename fails, don't block the caller.
  }
}

// ---------------------------------------------------------------------------
// Save (atomic write)
// ---------------------------------------------------------------------------

/**
 * Atomically save a ModelConfig to the given path.
 * Creates the parent directory if it does not exist.
 */
export async function saveModelConfig(filePath: string, config: ModelConfig): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Legacy migration helpers
// ---------------------------------------------------------------------------

/**
 * One-shot reader for the `models` key from a legacy `runtime-overrides.json` file.
 * Returns an empty record if the file is missing, corrupt, or has no models key.
 */
export async function loadLegacyOverrideModels(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['models'] !== 'object' || obj['models'] === null || Array.isArray(obj['models'])) {
    return {};
  }

  const rawModels = obj['models'] as Record<string, unknown>;
  const models: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawModels)) {
    if (typeof val === 'string') models[key] = val;
  }
  return models;
}

/**
 * Merge env-based defaults with legacy override models into a ModelConfig.
 * Override models win over env defaults for the same role.
 */
export function migrateFromLegacy(
  envConfig: Partial<Record<ModelRole, string>>,
  overridesModels: Record<string, string>,
): ModelConfig {
  const config: ModelConfig = { ...envConfig };
  for (const [key, val] of Object.entries(overridesModels)) {
    if (typeof val === 'string' && val) {
      config[key as ModelRole] = val;
    }
  }
  return config;
}

/**
 * Identify which stored roles are true overrides relative to the env-derived
 * startup defaults. Roles that match env defaults are treated as baseline, not
 * overrides.
 */
export function detectOverrideSources(
  currentConfig: ModelConfig,
  envDefaults: Partial<Record<ModelRole, string>>,
): Partial<Record<ModelRole, boolean>> {
  const overrideSources: Partial<Record<ModelRole, boolean>> = {};
  for (const role of Object.keys(currentConfig) as ModelRole[]) {
    const stored = currentConfig[role];
    if (stored && stored !== envDefaults[role]) overrideSources[role] = true;
  }
  return overrideSources;
}
