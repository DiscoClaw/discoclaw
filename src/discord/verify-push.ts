import { execa } from 'execa';
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
  /** PR check result — whether gh CLI is available and if a PR exists for the branch. */
  prCheck: { available: boolean; exists: boolean; url?: string };
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

async function gitIsAvailable(cwd: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
    const branch = result.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

async function fetchOrigin(cwd: string): Promise<void> {
  try {
    await execa('git', ['fetch', 'origin'], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
  } catch {
    // Best-effort — remote may be unreachable
  }
}

async function hasUpstream(cwd: string, branch: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

async function countUnpushedCommits(cwd: string, branch: string): Promise<number> {
  try {
    const result = await execa(
      'git',
      ['rev-list', '--count', `${branch}@{upstream}..HEAD`],
      { cwd, env: localGitEnv(), stdio: 'pipe' },
    );
    return parseInt(result.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check whether a specific short commit hash exists on the remote tracking branch.
 * Returns true if the commit is reachable from the upstream ref (i.e. already pushed).
 */
async function isCommitOnRemote(cwd: string, branch: string, shortHash: string): Promise<boolean> {
  try {
    // Resolve the short hash to a full hash first
    const result = await execa('git', ['rev-parse', shortHash], {
      cwd,
      env: localGitEnv(),
      stdio: 'pipe',
    });
    const fullHash = result.stdout.trim();
    // Check if the commit is an ancestor of (reachable from) the upstream
    await execa('git', ['merge-base', '--is-ancestor', fullHash, `${branch}@{upstream}`], {
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
// PR check via gh CLI
// ---------------------------------------------------------------------------

/**
 * Check whether a PR exists for the given branch using the gh CLI.
 * Gracefully degrades if gh is unavailable or not authenticated.
 */
async function checkPRExists(
  branchName: string,
  cwd: string,
): Promise<{ available: boolean; exists: boolean; url?: string }> {
  try {
    const result = await execa(
      'gh',
      ['pr', 'list', '--head', branchName, '--json', 'number,state,url', '--limit', '1'],
      { cwd, env: localGitEnv(), stdio: 'pipe' },
    );
    const prs = JSON.parse(result.stdout.trim() || '[]');
    if (Array.isArray(prs) && prs.length > 0) {
      return { available: true, exists: true, url: prs[0].url };
    }
    return { available: true, exists: false };
  } catch {
    // gh CLI not available or not authenticated
    return { available: false, exists: false };
  }
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

const NO_PR: PushVerificationResult['prCheck'] = { available: false, exists: false };

/**
 * Verify that commits from completed plan phases have been pushed to a remote branch.
 *
 * Fetches from origin before comparing to ensure remote refs are current.
 * Also checks for an open PR via the gh CLI (gracefully degrades if unavailable).
 *
 * Returns a structured result indicating push status. The `prCheck` field
 * indicates whether a PR exists for the branch — callers can use this to
 * allow closure even when commits are ahead of the remote tracking branch.
 */
export async function verifyPushStatus(cwd: string, phases: PlanPhase[]): Promise<PushVerificationResult> {
  if (!(await gitIsAvailable(cwd))) {
    return {
      branch: null,
      hasRemote: false,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
      prCheck: NO_PR,
      warning: 'Git is not available — cannot verify push status.',
    };
  }

  const branch = await getCurrentBranch(cwd);
  if (!branch) {
    return {
      branch: null,
      hasRemote: false,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
      prCheck: NO_PR,
      warning: 'Detached HEAD — cannot verify push status.',
    };
  }

  // Fetch latest remote state before comparing (concern 3: stale refs)
  await fetchOrigin(cwd);

  const remote = await hasUpstream(cwd, branch);

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
      prCheck: NO_PR,
    };
  }

  // Check PR existence for the branch
  const prCheck = await checkPRExists(branch, cwd);

  if (!remote) {
    return {
      branch,
      hasRemote: false,
      unpushedCommits: phaseCommits.length,
      unpushedPhaseCommits: phaseCommits,
      prCheck,
      warning: `Branch '${branch}' has no remote tracking branch — ${phaseCommits.length} phase commit(s) are local-only.`,
    };
  }

  // Branch has a remote — check which phase commits are not yet pushed
  const unpushedChecks = await Promise.all(
    phaseCommits.map(async (hash) => ({
      hash,
      onRemote: await isCommitOnRemote(cwd, branch, hash),
    })),
  );
  const unpushedPhaseCommits = unpushedChecks.filter((c) => !c.onRemote).map((c) => c.hash);
  const totalUnpushed = await countUnpushedCommits(cwd, branch);

  if (unpushedPhaseCommits.length === 0) {
    return {
      branch,
      hasRemote: true,
      unpushedCommits: totalUnpushed,
      unpushedPhaseCommits: [],
      prCheck,
    };
  }

  return {
    branch,
    hasRemote: true,
    unpushedCommits: totalUnpushed,
    unpushedPhaseCommits,
    prCheck,
    warning: `Branch '${branch}' has ${unpushedPhaseCommits.length} unpushed phase commit(s): ${unpushedPhaseCommits.join(', ')}.`,
  };
}

/**
 * Format a push verification warning for display in Discord messages.
 * Returns undefined if there is no warning.
 */
export function formatPushWarning(result: PushVerificationResult): string | undefined {
  if (!result.warning) return undefined;
  if (result.prCheck.exists) {
    const prPart = result.prCheck.url ? ` (PR: ${result.prCheck.url})` : '';
    return `⚠️ **Push verification:** ${result.warning} A PR exists for this branch${prPart} — allowing closure.`;
  }
  return `⚠️ **Push verification:** ${result.warning} Commits must be pushed to a remote branch (with a PR) before the task can be considered complete.`;
}
