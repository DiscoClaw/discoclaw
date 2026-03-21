import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);

export type NpmManagedClaudeAuditVerdict = 'support-claimable' | 'not-yet-support-claimable';

export type NpmManagedClaudeSupportState = 'supported' | 'blocked';

export type NpmManagedClaudeBlockerCode =
  | 'missing-shipped-auth-smoke'
  | 'missing-claude-bin-persistence'
  | 'daemon-runtime-path-mismatch'
  | 'blocked-by-auth-and-daemon-gaps';

export type NpmManagedClaudeSurfaceId =
  | 'global-install'
  | 'init-login-validation'
  | 'daemon-install-startup'
  | 'first-useful-reply'
  | 'restart-recovery'
  | 'update';

export type NpmManagedClaudeBlocker = {
  code: NpmManagedClaudeBlockerCode;
  summary: string;
};

export type NpmManagedClaudeSurfaceAudit = {
  id: NpmManagedClaudeSurfaceId;
  label: string;
  state: NpmManagedClaudeSupportState;
  supportClaimable: boolean;
  summary: string;
  blockerCodes: readonly NpmManagedClaudeBlockerCode[];
  evidence: readonly string[];
};

export type NpmManagedClaudeAudit = {
  installCommand: 'npm install -g discoclaw';
  releaseGate: '1.0';
  verdict: NpmManagedClaudeAuditVerdict;
  supportClaimable: boolean;
  summary: string;
  supportedClaims: readonly string[];
  blockedClaims: readonly string[];
  blockers: readonly NpmManagedClaudeBlocker[];
  surfaces: readonly NpmManagedClaudeSurfaceAudit[];
};

export const NPM_MANAGED_CLAUDE_1P0_AUDIT = {
  installCommand: 'npm install -g discoclaw',
  releaseGate: '1.0',
  verdict: 'not-yet-support-claimable',
  supportClaimable: false,
  summary:
    'The npm-managed path can claim install and update mechanics, but cannot yet claim a supported stranger-run Claude workflow for 1.0.',
  supportedClaims: [
    'global install via `npm install -g discoclaw`',
    'npm-managed install detection',
    'version checks via `npm show discoclaw version`',
    'global upgrade via `npm install -g discoclaw --loglevel=error`',
  ],
  blockedClaims: [
    'shipped npm-managed Claude auth-smoke validation',
    'persisting the interactively validated Claude binary into `.env` as `CLAUDE_BIN`',
    'daemon startup that records the validated Node and Claude runtime paths',
    'first useful Claude-backed reply on the npm-managed stranger path',
    'restart recovery on the npm-managed Claude daemon path',
  ],
  blockers: [
    {
      code: 'missing-shipped-auth-smoke',
      summary:
        'The shipped npm package has no npm-managed Claude auth-smoke subcommand, and the published files omit the source-only auth smoke script.',
    },
    {
      code: 'missing-claude-bin-persistence',
      summary:
        'The init wizard detects `claude` interactively but does not persist `CLAUDE_BIN`, so later runtime resolution can diverge from the validated shell path.',
    },
    {
      code: 'daemon-runtime-path-mismatch',
      summary:
        'The daemon installers hardcode `/usr/bin/node` and a fixed service PATH instead of recording the Node and Claude executables that actually worked during setup.',
    },
    {
      code: 'blocked-by-auth-and-daemon-gaps',
      summary:
        'First useful reply and restart recovery stay blocked until the npm-managed path ships auth proof and daemon/runtime-path parity.',
    },
  ],
  surfaces: [
    {
      id: 'global-install',
      label: 'Global install',
      state: 'supported',
      supportClaimable: true,
      summary:
        'The published package exposes the `discoclaw` binary and compiled runtime, so `npm install -g discoclaw` is a real supported install surface.',
      blockerCodes: [],
      evidence: ['package.json', 'src/npm-managed.ts', 'src/cli/index.ts'],
    },
    {
      id: 'init-login-validation',
      label: 'Init / login validation',
      state: 'blocked',
      supportClaimable: false,
      summary:
        '`discoclaw init` can detect Claude in the current shell and prints manual guidance, but there is no shipped npm-managed auth-smoke command and the generated `.env` does not persist `CLAUDE_BIN`.',
      blockerCodes: ['missing-shipped-auth-smoke', 'missing-claude-bin-persistence'],
      evidence: ['src/cli/init-wizard.ts', 'src/cli/index.ts', 'package.json'],
    },
    {
      id: 'daemon-install-startup',
      label: 'Daemon install / startup',
      state: 'blocked',
      supportClaimable: false,
      summary:
        'The daemon path can diverge from the operator shell because it hardcodes `/usr/bin/node` and a fixed PATH while relying on later CLAUDE_BIN resolution.',
      blockerCodes: ['missing-claude-bin-persistence', 'daemon-runtime-path-mismatch'],
      evidence: ['src/cli/daemon-installer.ts', 'src/cli/init-wizard.ts', 'src/config.ts', 'src/index.ts'],
    },
    {
      id: 'first-useful-reply',
      label: 'First useful reply',
      state: 'blocked',
      supportClaimable: false,
      summary:
        'Shared Discord reply machinery exists, but the npm-managed Claude path cannot currently prove auth and daemon/runtime parity well enough to claim this stranger-run step.',
      blockerCodes: ['blocked-by-auth-and-daemon-gaps'],
      evidence: ['src/index.ts', 'src/cli/index.ts', 'src/cli/daemon-installer.ts', 'src/cli/init-wizard.ts'],
    },
    {
      id: 'restart-recovery',
      label: 'Restart recovery',
      state: 'blocked',
      supportClaimable: false,
      summary:
        'The restart path inherits the same unresolved Node and Claude runtime-path mismatch as the initial daemon startup.',
      blockerCodes: ['daemon-runtime-path-mismatch'],
      evidence: ['src/cli/daemon-installer.ts', 'src/config.ts', 'src/index.ts', 'src/discord/update-command.ts'],
    },
    {
      id: 'update',
      label: 'Update',
      state: 'supported',
      supportClaimable: true,
      summary:
        'The npm-managed update path is real: the CLI checks npm for the latest version and applies upgrades with `npm install -g discoclaw --loglevel=error`.',
      blockerCodes: [],
      evidence: ['src/npm-managed.ts', 'src/cli/index.ts', 'src/discord/update-command.ts'],
    },
  ],
} as const satisfies NpmManagedClaudeAudit;

export function getNpmManagedClaude1p0Audit(): NpmManagedClaudeAudit {
  return NPM_MANAGED_CLAUDE_1P0_AUDIT;
}

export function getNpmManagedClaude1p0ClaimableSurfaces(): NpmManagedClaudeSurfaceAudit[] {
  return NPM_MANAGED_CLAUDE_1P0_AUDIT.surfaces.filter((surface) => surface.supportClaimable);
}

export function getNpmManagedClaude1p0BlockedSurfaces(): NpmManagedClaudeSurfaceAudit[] {
  return NPM_MANAGED_CLAUDE_1P0_AUDIT.surfaces.filter((surface) => !surface.supportClaimable);
}

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
    const result = await execa('npm', ['install', '-g', 'discoclaw', '--loglevel=error'], {
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
