import fs from 'node:fs/promises';
import path from 'node:path';

export type RuntimeOverrides = {
  runtimeModel?: string;
  voiceModel?: string;
  ttsVoice?: string;
};

const OVERRIDES_FILENAME = 'runtime-overrides.json';

/**
 * Resolve the path to the runtime-overrides.json file.
 * Uses the configured data dir when present, otherwise defaults to <projectRoot>/data.
 */
export function resolveOverridesPath(dataDir: string | undefined, projectRoot: string): string {
  const configured = (dataDir ?? '').trim();
  const baseDir = configured || path.join(projectRoot, 'data');
  return path.join(baseDir, OVERRIDES_FILENAME);
}

/**
 * Load runtime overrides from the JSON overlay file.
 * Returns an empty object if the file does not exist or cannot be parsed.
 * Only known string-typed fields are accepted; unknown/wrong-typed fields are silently dropped.
 */
export async function loadOverrides(filePath: string): Promise<RuntimeOverrides> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const overrides: RuntimeOverrides = {};
  if (typeof obj['runtimeModel'] === 'string') overrides.runtimeModel = obj['runtimeModel'];
  if (typeof obj['voiceModel'] === 'string') overrides.voiceModel = obj['voiceModel'];
  if (typeof obj['ttsVoice'] === 'string') overrides.ttsVoice = obj['ttsVoice'];
  return overrides;
}

/**
 * Atomically save runtime overrides to the JSON overlay file.
 * Uses a write-to-temp-then-rename strategy to prevent partial writes.
 * Creates the parent directory if it does not exist.
 */
export async function saveOverrides(filePath: string, overrides: RuntimeOverrides): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(overrides, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Clear all runtime overrides by deleting the JSON overlay file.
 * Does nothing if the file does not exist.
 */
export async function clearOverrides(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
