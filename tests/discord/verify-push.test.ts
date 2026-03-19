/**
 * Tests for verify-push: post-implementation verification that detects
 * local-only commits and warns/blocks task completion until code is
 * on a remote branch or PR.
 *
 * Uses real git repos in temp directories to exercise the actual git
 * helper functions (no mocking of child_process).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyPushStatus,
  formatPushWarning,
} from '../../src/discord/verify-push.js';
import type { PushVerificationResult } from '../../src/discord/verify-push.js';
import type { PlanPhase } from '../../src/discord/plan-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PlanPhase stub for testing — only fields verify-push inspects. */
function makePhase(overrides: Partial<PlanPhase> = {}): PlanPhase {
  return {
    id: 'phase-1',
    title: 'Test phase',
    kind: 'implement',
    description: '',
    status: 'pending',
    dependsOn: [],
    contextFiles: [],
    ...overrides,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test' },
  }).trim();
}

/** Create a temp dir with an initialized git repo and one initial commit. */
function initRepo(dir: string): void {
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'initial commit']);
}

/** Create a bare "remote" repo and add it as origin to the working repo. */
function addBareRemote(workDir: string, bareDir: string): void {
  git(bareDir, ['init', '--bare']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-u', 'origin', 'main']);
}

/** Make a commit in the repo and return its short hash. */
function makeCommit(cwd: string, filename: string, message: string): string {
  fs.writeFileSync(path.join(cwd, filename), `${message}\n`);
  git(cwd, ['add', filename]);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpBase: string;
let workDir: string;
let bareDir: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-push-test-'));
  workDir = path.join(tmpBase, 'work');
  bareDir = path.join(tmpBase, 'bare');
  fs.mkdirSync(workDir);
  fs.mkdirSync(bareDir);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyPushStatus
// ---------------------------------------------------------------------------

describe('verifyPushStatus', () => {
  it('returns git-unavailable warning for non-repo directory', () => {
    const nonRepo = path.join(tmpBase, 'not-a-repo');
    fs.mkdirSync(nonRepo);
    const result = verifyPushStatus(nonRepo, [makePhase({ status: 'done', gitCommit: 'abc1234' })]);
    expect(result.branch).toBeNull();
    expect(result.hasRemote).toBe(false);
    expect(result.warning).toMatch(/Git is not available/);
  });

  it('returns no warning when there are no done phases with commits', () => {
    initRepo(workDir);
    const result = verifyPushStatus(workDir, [
      makePhase({ status: 'pending' }),
      makePhase({ id: 'phase-2', status: 'done' }), // done but no gitCommit
    ]);
    expect(result.branch).toBe('main');
    expect(result.unpushedCommits).toBe(0);
    expect(result.unpushedPhaseCommits).toHaveLength(0);
    expect(result.warning).toBeUndefined();
  });

  it('warns when branch has no remote tracking branch', () => {
    initRepo(workDir);
    const hash = makeCommit(workDir, 'file1.ts', 'phase 1 work');
    const phases = [makePhase({ status: 'done', gitCommit: hash })];

    const result = verifyPushStatus(workDir, phases);
    expect(result.branch).toBe('main');
    expect(result.hasRemote).toBe(false);
    expect(result.unpushedPhaseCommits).toEqual([hash]);
    expect(result.warning).toMatch(/no remote tracking branch/);
    expect(result.warning).toMatch(/1 phase commit/);
  });

  it('warns about multiple unpushed phase commits with no remote', () => {
    initRepo(workDir);
    const hash1 = makeCommit(workDir, 'a.ts', 'phase 1');
    const hash2 = makeCommit(workDir, 'b.ts', 'phase 2');
    const phases = [
      makePhase({ id: 'p1', status: 'done', gitCommit: hash1 }),
      makePhase({ id: 'p2', status: 'done', gitCommit: hash2 }),
    ];

    const result = verifyPushStatus(workDir, phases);
    expect(result.hasRemote).toBe(false);
    expect(result.unpushedPhaseCommits).toEqual([hash1, hash2]);
    expect(result.warning).toMatch(/2 phase commit/);
  });

  it('returns clean result when all phase commits are pushed', () => {
    initRepo(workDir);
    addBareRemote(workDir, bareDir);
    const hash = makeCommit(workDir, 'file1.ts', 'phase 1 work');
    git(workDir, ['push']);

    const phases = [makePhase({ status: 'done', gitCommit: hash })];
    const result = verifyPushStatus(workDir, phases);

    expect(result.branch).toBe('main');
    expect(result.hasRemote).toBe(true);
    expect(result.unpushedCommits).toBe(0);
    expect(result.unpushedPhaseCommits).toHaveLength(0);
    expect(result.warning).toBeUndefined();
  });

  it('detects unpushed phase commits when remote exists but commits not pushed', () => {
    initRepo(workDir);
    addBareRemote(workDir, bareDir);
    const hash = makeCommit(workDir, 'file1.ts', 'local-only work');

    const phases = [makePhase({ status: 'done', gitCommit: hash })];
    const result = verifyPushStatus(workDir, phases);

    expect(result.hasRemote).toBe(true);
    expect(result.unpushedCommits).toBeGreaterThan(0);
    expect(result.unpushedPhaseCommits).toEqual([hash]);
    expect(result.warning).toMatch(/unpushed phase commit/);
    expect(result.warning).toContain(hash);
  });

  it('differentiates pushed vs unpushed commits in mixed scenario', () => {
    initRepo(workDir);
    addBareRemote(workDir, bareDir);

    // Phase 1: pushed
    const hash1 = makeCommit(workDir, 'pushed.ts', 'phase 1 pushed');
    git(workDir, ['push']);

    // Phase 2: not pushed
    const hash2 = makeCommit(workDir, 'unpushed.ts', 'phase 2 local');

    const phases = [
      makePhase({ id: 'p1', status: 'done', gitCommit: hash1 }),
      makePhase({ id: 'p2', status: 'done', gitCommit: hash2 }),
    ];
    const result = verifyPushStatus(workDir, phases);

    expect(result.hasRemote).toBe(true);
    expect(result.unpushedPhaseCommits).toEqual([hash2]);
    expect(result.unpushedPhaseCommits).not.toContain(hash1);
    expect(result.warning).toMatch(/1 unpushed phase commit/);
  });

  it('ignores non-done phases even if they have gitCommit', () => {
    initRepo(workDir);
    addBareRemote(workDir, bareDir);
    const hash = makeCommit(workDir, 'wip.ts', 'work in progress');

    const phases = [
      makePhase({ status: 'in-progress', gitCommit: hash }),
      makePhase({ id: 'p2', status: 'failed', gitCommit: hash }),
      makePhase({ id: 'p3', status: 'skipped', gitCommit: hash }),
    ];
    const result = verifyPushStatus(workDir, phases);

    // No done phases with commits → nothing to verify
    expect(result.unpushedPhaseCommits).toHaveLength(0);
    expect(result.warning).toBeUndefined();
  });

  it('works on a non-main branch with tracking', () => {
    initRepo(workDir);
    addBareRemote(workDir, bareDir);

    git(workDir, ['checkout', '-b', 'feature/verify-push']);
    git(workDir, ['push', '-u', 'origin', 'feature/verify-push']);

    const hash = makeCommit(workDir, 'feature.ts', 'feature work');
    // Not pushed yet

    const phases = [makePhase({ status: 'done', gitCommit: hash })];
    const result = verifyPushStatus(workDir, phases);

    expect(result.branch).toBe('feature/verify-push');
    expect(result.hasRemote).toBe(true);
    expect(result.unpushedPhaseCommits).toEqual([hash]);
    expect(result.warning).toMatch(/feature\/verify-push/);
  });

  it('handles detached HEAD gracefully', () => {
    initRepo(workDir);
    const headHash = git(workDir, ['rev-parse', 'HEAD']);
    git(workDir, ['checkout', headHash]);

    const result = verifyPushStatus(workDir, [makePhase({ status: 'done', gitCommit: 'abc' })]);
    expect(result.branch).toBeNull();
    expect(result.warning).toMatch(/Detached HEAD/);
  });
});

// ---------------------------------------------------------------------------
// formatPushWarning
// ---------------------------------------------------------------------------

describe('formatPushWarning', () => {
  it('returns undefined when there is no warning', () => {
    const result: PushVerificationResult = {
      branch: 'main',
      hasRemote: true,
      unpushedCommits: 0,
      unpushedPhaseCommits: [],
    };
    expect(formatPushWarning(result)).toBeUndefined();
  });

  it('formats warning with emoji and push guidance', () => {
    const result: PushVerificationResult = {
      branch: 'main',
      hasRemote: false,
      unpushedCommits: 2,
      unpushedPhaseCommits: ['abc1234', 'def5678'],
      warning: "Branch 'main' has no remote tracking branch — 2 phase commit(s) are local-only.",
    };
    const formatted = formatPushWarning(result);
    expect(formatted).toContain('⚠️');
    expect(formatted).toContain('Push verification');
    expect(formatted).toContain('remote branch');
    expect(formatted).toContain('local-only');
  });
});
