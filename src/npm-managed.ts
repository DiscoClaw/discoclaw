import { execa } from 'execa';
import { createRequire } from 'node:module';

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
 * Returns the npm global node_modules root directory, or null on failure.
 */
async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const result = await execa('npm', ['root', '-g']);
    const root = result.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the running process was installed via `npm install -g`.
 * Detection: checks whether process.argv[1] is rooted under the npm global
 * node_modules directory returned by `npm root -g`.
 */
export async function isNpmManaged(): Promise<boolean> {
  const globalRoot = await getNpmGlobalRoot();
  if (!globalRoot) return false;
  const script = process.argv[1];
  if (!script) return false;
  return script.startsWith(globalRoot);
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
