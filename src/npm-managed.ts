import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);

/**
 * Returns the version string from the nearest package.json.
 * Works from both source (src/) and compiled (dist/) locations.
 */
export function getLocalVersion(): string {
  try {
    const pkg = _require('../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns true when the running process was installed via `npm install -g`.
 * Detection: source installs have a `.git` directory at the package root;
 * npm-published packages do not (`.git` is excluded from the `files` array).
 */
export async function isNpmManaged(): Promise<boolean> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return !existsSync(path.join(packageRoot, '.git'));
}

/**
 * Fetches the latest published version of discoclaw from the npm registry.
 * Returns null when the registry is unreachable or the package is unknown.
 */
export async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const result = await execa('npm', ['show', 'discoclaw', 'version'], {
      timeout: 15_000,
    });
    const v = result.stdout.trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Upgrades the globally-installed discoclaw package via npm.
 * Returns the exit code plus captured stdout/stderr.
 */
export async function npmGlobalUpgrade(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execa('npm', ['install', '-g', 'discoclaw'], {
      timeout: 120_000,
    });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (err: any) {
    return {
      exitCode: err?.exitCode ?? 1,
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? '',
    };
  }
}
