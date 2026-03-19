import { execFileSync } from 'node:child_process';
import type { PlanPhase } from './plan-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PushVerificationResult = {
  /** Current branch name, or null if unavailable/detached. */
  branch: string | null;
  /** Whether the branch has a remote tracking branch. */
  hasRemote: boolean;
  /** Number of commits ahead of the remote tracking branch. */
  unpushedCommits: number;
  /** Commit hashes from phases that are not yet on the remote. */
  unpushedPhaseCommits: string[];
  /** Human-readable warning, or undefined if all commits are pushed. */
  warning?: string;
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function localGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function gitIsAvailable(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      env: localGitEnv(),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(cwd: string): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      env: localGitEnv(),
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

function hasUpstream(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd,
      env: localGitEnv(),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function countUnpushedCommits(cwd: string, branch: string): number {
  try {
    const count = execFileSync(
      'git',
      ['rev-list', '--count', `${branch}@{upstream}..HEAD`],
      { cwd, env: localGitEnv(), encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check whether a specific short commit hash exists on the remote tracking branch.
 * Returns true if the commit is reachable from the upstream ref (i.e. already pushed).
 */
function isCommitOnRemote(cwd: string, branch: string, shortHash: string): boolean {
  try {
    // Resolve the short hash to a full hash first
    const fullHash = execFileSync('git', ['rev-parse', shortHash], {
      cwd,
      env: localGitEnv(),
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    // Check if the commit is an ancestor of (reachable from) the upstream
    execFileSync('git', ['merge-base', '--is-ancestor', fullHash, `${branch}@{upstream}`], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

/**
 * Verify that commits from completed plan phases have been pushed to a remote branch.
 *
 * Returns a structured result indicating push status. Callers can use the `warning`
 * field to surface issues to the user without blocking plan closure.
 */
export function verifyPushStatus(cwd: string, phases: PlanPhase[]): PushVerificationResult {
  if (!gitIsAvailable(cwd)) {
    return {
      branch: null,
      hasRemote: false,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
      warning: 'Git is not available — cannot verify push status.',
    };
  }

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    return {
      branch: null,
      hasRemote: false,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
      warning: 'Detached HEAD — cannot verify push status.',
    };
  }

  const remote = hasUpstream(cwd, branch);

  // Collect git commit hashes from completed phases
  const phaseCommits = phases
    .filter((p) => p.status === 'done' && p.gitCommit)
    .map((p) => p.gitCommit!);

  if (phaseCommits.length === 0) {
    // No commits to verify — nothing to warn about
    return {
      branch,
      hasRemote: remote,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
    };
  }

  if (!remote) {
    return {
      branch,
      hasRemote: false,
      unpushedCommits: phaseCommits.length,
      unpushedPhaseCommits: phaseCommits,
      warning: `Branch '${branch}' has no remote tracking branch — ${phaseCommits.length} phase commit(s) are local-only.`,
    };
  }

  // Branch has a remote — check which phase commits are not yet pushed
  const unpushedPhaseCommits = phaseCommits.filter(
    (hash) => !isCommitOnRemote(cwd, branch, hash),
  );
  const totalUnpushed = countUnpushedCommits(cwd, branch);

  if (unpushedPhaseCommits.length === 0) {
    return {
      branch,
      hasRemote: true,
      unpushedCommits: totalUnpushed,
      unpushedPhaseCommits: [],
    };
  }

  return {
    branch,
    hasRemote: true,
    unpushedCommits: totalUnpushed,
    unpushedPhaseCommits,
    warning: `Branch '${branch}' has ${unpushedPhaseCommits.length} unpushed phase commit(s): ${unpushedPhaseCommits.join(', ')}.`,
  };
}

/**
 * Format a push verification warning for display in Discord messages.
 * Returns undefined if there is no warning.
 */
export function formatPushWarning(result: PushVerificationResult): string | undefined {
  if (!result.warning) return undefined;
  return `⚠️ **Push verification:** ${result.warning} Commits must be pushed to a remote branch (with a PR) before the task can be considered complete.`;
}
