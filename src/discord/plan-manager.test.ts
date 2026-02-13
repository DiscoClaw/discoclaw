import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { EngineEvent } from '../runtime/types.js';

import {
  computePlanHash,
  extractFilePaths,
  groupFiles,
  extractChangeSpec,
  decomposePlan,
  serializePhases,
  deserializePhases,
  getNextPhase,
  updatePhaseStatus,
  checkStaleness,
  buildPhasePrompt,
  buildAuditFixPrompt,
  resolveProjectCwd,
  resolveContextFilePath,
  writePhasesFile,
  executePhase,
  runNextPhase,
} from './plan-manager.js';
import type { PlanPhases, PlanPhase, PhaseExecutionOpts } from './plan-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'plan-manager-test-'));
}

function makeRuntime(events: EngineEvent[]): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke() {
      for (const evt of events) yield evt;
    },
  };
}

function makeSuccessRuntime(text: string): RuntimeAdapter {
  return makeRuntime([
    { type: 'text_delta', text },
    { type: 'text_final', text },
  ]);
}

function makeErrorRuntime(msg: string): RuntimeAdapter {
  return makeRuntime([
    { type: 'error', message: msg },
  ]);
}

const SAMPLE_PLAN = `# Plan: Add phase manager

**ID:** plan-011
**Bead:** ws-test
**Created:** 2026-02-12
**Status:** APPROVED
**Project:** discoclaw

---

## Objective

Add a plan manager that decomposes complex plans into phases.

## Changes

### File-by-file breakdown

- \`src/discord/plan-manager.ts\` — New file. Core phase logic.
  - Types: PlanPhase, PlanPhases
  - Functions: decomposePlan, serializePhases

- \`src/discord/plan-manager.test.ts\` — New file. Unit tests.
  - Tests for decomposePlan
  - Tests for serialization

- \`src/discord/plan-commands.ts\` — Add phases/run/skip subcommands.
  - Expand PlanCommand action union
  - Add RESERVED_SUBCOMMANDS entries

- \`src/config.ts\` — Add config entries.
  - PLAN_PHASES_ENABLED
  - PLAN_PHASE_MAX_CONTEXT_FILES

- \`src/discord.ts\` — Wire async execution.
  - Writer lock
  - Run/skip interceptors

- \`workspace/TOOLS.md\` — Document phase manager.

## Risks

- Context overflow
- Phase ordering

## Testing

Unit tests for all functions.
`;

const SAMPLE_PLAN_NO_CHANGES = `# Plan: Audit plan-010

**ID:** plan-010
**Bead:** ws-audit
**Created:** 2026-02-12
**Status:** REVIEW
**Project:** discoclaw

---

## Objective

Review plan-010 implementation quality.

## Scope

Audit only — no code changes.

## Risks

None identified.
`;

// ---------------------------------------------------------------------------
// computePlanHash
// ---------------------------------------------------------------------------

describe('computePlanHash', () => {
  it('returns 16 hex chars', () => {
    const hash = computePlanHash('test content');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same input = same hash', () => {
    expect(computePlanHash('abc')).toBe(computePlanHash('abc'));
  });

  it('different input = different hash', () => {
    expect(computePlanHash('abc')).not.toBe(computePlanHash('def'));
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------

describe('extractFilePaths', () => {
  it('extracts standard format paths', () => {
    const section = '- `src/discord/plan-commands.ts` — Add phases\n- `src/config.ts` — Add config';
    expect(extractFilePaths(section)).toEqual([
      'src/discord/plan-commands.ts',
      'src/config.ts',
    ]);
  });

  it('rejects backticked type names', () => {
    const section = '- `PlanPhase` type definition\n- `src/foo.ts` — real file';
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('rejects backticked config keys', () => {
    const section = '- `PLAN_PHASES_ENABLED` — config\n- `src/config.ts` — file';
    expect(extractFilePaths(section)).toEqual(['src/config.ts']);
  });

  it('rejects quoted strings', () => {
    const section = "- `'pending'` — status\n- `src/foo.ts` — file";
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('deduplicates paths', () => {
    const section = '- `src/foo.ts` — first\n- `src/foo.ts` — second';
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('handles mixed valid/invalid', () => {
    const section = [
      '- `src/discord/plan-manager.ts` — New file',
      '- `PlanPhase` type: ...',
      '- `PLAN_PHASES_ENABLED` config',
      '- `src/config.ts` — Add config',
    ].join('\n');
    expect(extractFilePaths(section)).toEqual([
      'src/discord/plan-manager.ts',
      'src/config.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// groupFiles
// ---------------------------------------------------------------------------

describe('groupFiles', () => {
  it('pairs module + test file', () => {
    const files = ['src/foo.ts', 'src/foo.test.ts'];
    const groups = groupFiles(files, 5);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toContain('src/foo.ts');
    expect(groups[0]).toContain('src/foo.test.ts');
  });

  it('groups files in same directory', () => {
    const files = ['src/a.ts', 'src/b.ts', 'lib/c.ts'];
    const groups = groupFiles(files, 5);
    // src/a.ts and src/b.ts in one group, lib/c.ts in another
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const srcGroup = groups.find((g) => g.includes('src/a.ts'));
    expect(srcGroup).toContain('src/b.ts');
  });

  it('splits group exceeding maxPerGroup', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const groups = groupFiles(files, 2);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const group of groups) {
      expect(group.length).toBeLessThanOrEqual(2);
    }
  });

  it('single file = group of one', () => {
    expect(groupFiles(['src/foo.ts'], 5)).toEqual([['src/foo.ts']]);
  });

  it('empty list = empty groups', () => {
    expect(groupFiles([], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractChangeSpec
// ---------------------------------------------------------------------------

describe('extractChangeSpec', () => {
  const changes = [
    '- `src/foo.ts` — Add new function',
    '  - Add `doStuff()` method',
    '  - Update imports',
    '',
    '- `src/bar.ts` — Fix bug',
    '  - Handle null case',
    '',
    '- `src/baz.ts` — Refactor',
  ].join('\n');

  it('extracts block for a single file', () => {
    const spec = extractChangeSpec(changes, ['src/foo.ts']);
    expect(spec).toContain('Add new function');
    expect(spec).toContain('doStuff()');
    expect(spec).not.toContain('Fix bug');
  });

  it('extracts blocks for multiple files', () => {
    const spec = extractChangeSpec(changes, ['src/foo.ts', 'src/bar.ts']);
    expect(spec).toContain('Add new function');
    expect(spec).toContain('Fix bug');
  });

  it('returns fallback for missing file', () => {
    const spec = extractChangeSpec(changes, ['src/missing.ts']);
    expect(spec).toContain('not described in Changes section');
  });

  it('captures nested sub-bullets', () => {
    const spec = extractChangeSpec(changes, ['src/foo.ts']);
    expect(spec).toContain('Add `doStuff()` method');
    expect(spec).toContain('Update imports');
  });

  it('cleanly separates adjacent file entries', () => {
    const spec = extractChangeSpec(changes, ['src/foo.ts']);
    expect(spec).not.toContain('Fix bug');
    expect(spec).not.toContain('Refactor');
  });
});

// ---------------------------------------------------------------------------
// decomposePlan
// ---------------------------------------------------------------------------

describe('decomposePlan', () => {
  it('plan with file changes → impl + audit phases', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    expect(phases.planId).toBe('plan-011');
    expect(phases.phases.length).toBeGreaterThanOrEqual(2);

    const implPhases = phases.phases.filter((p) => p.kind === 'implement');
    const auditPhases = phases.phases.filter((p) => p.kind === 'audit');
    expect(implPhases.length).toBeGreaterThanOrEqual(1);
    expect(auditPhases.length).toBe(1);

    // Audit depends on all impl phases
    const auditPhase = auditPhases[0]!;
    for (const impl of implPhases) {
      expect(auditPhase.dependsOn).toContain(impl.id);
    }
  });

  it('plan with no file paths → 2-phase minimal set', () => {
    const phases = decomposePlan(SAMPLE_PLAN_NO_CHANGES, 'plan-010', 'workspace/plans/plan-010.md');
    expect(phases.phases).toHaveLength(2);
    expect(phases.phases[0]!.kind).toBe('read');
    expect(phases.phases[1]!.kind).toBe('implement');
  });

  it('contextFiles limited to per-batch files', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    const implPhases = phases.phases.filter((p) => p.kind === 'implement');
    for (const phase of implPhases) {
      // Each impl phase should only have its batch's files
      expect(phase.contextFiles.length).toBeLessThanOrEqual(5);
    }
  });

  it('dependsOn ordering is correct', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    // First impl phase has no deps (or deps on earlier phases)
    expect(phases.phases[0]!.dependsOn).toEqual([]);
  });

  it('changeSpec is populated for implement phases', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    const implPhases = phases.phases.filter((p) => p.kind === 'implement');
    for (const phase of implPhases) {
      expect(phase.changeSpec).toBeTruthy();
    }
  });

  it('hash is computed and stored', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    expect(phases.planContentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(phases.planContentHash).toBe(computePlanHash(SAMPLE_PLAN));
  });

  it('normalizes bare workspace filenames', () => {
    const plan = SAMPLE_PLAN.replace('`workspace/TOOLS.md`', '`TOOLS.md`');
    const phases = decomposePlan(plan, 'plan-011', 'workspace/plans/plan-011.md');
    const allContextFiles = phases.phases.flatMap((p) => p.contextFiles);
    // TOOLS.md should be normalized to workspace/TOOLS.md
    const hasNormalized = allContextFiles.some((f) => f === 'workspace/TOOLS.md');
    // The original TOOLS.md should not appear without prefix
    const hasBare = allContextFiles.some((f) => f === 'TOOLS.md');
    expect(hasNormalized || !hasBare).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('serialization', () => {
  it('serializePhases → deserializePhases round-trip', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    const serialized = serializePhases(phases);
    const deserialized = deserializePhases(serialized);

    expect(deserialized.planId).toBe(phases.planId);
    expect(deserialized.planContentHash).toBe(phases.planContentHash);
    expect(deserialized.phases.length).toBe(phases.phases.length);
    for (let i = 0; i < phases.phases.length; i++) {
      expect(deserialized.phases[i]!.id).toBe(phases.phases[i]!.id);
      expect(deserialized.phases[i]!.kind).toBe(phases.phases[i]!.kind);
      expect(deserialized.phases[i]!.status).toBe(phases.phases[i]!.status);
    }
  });

  it('handles all status values', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    // Set various statuses
    phases.phases[0]!.status = 'done';
    phases.phases[0]!.output = 'All good.';
    if (phases.phases[1]) phases.phases[1].status = 'failed';
    if (phases.phases[1]) phases.phases[1].error = 'Timeout';

    const serialized = serializePhases(phases);
    const deserialized = deserializePhases(serialized);
    expect(deserialized.phases[0]!.status).toBe('done');
    expect(deserialized.phases[0]!.output).toBe('All good.');
    if (deserialized.phases[1]) {
      expect(deserialized.phases[1].status).toBe('failed');
      expect(deserialized.phases[1].error).toBe('Timeout');
    }
  });

  it('failureHashes round-trips', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011.md');
    phases.phases[0]!.failureHashes = { 'src/foo.ts': 'abc123def4567890' };
    phases.phases[0]!.modifiedFiles = ['src/foo.ts'];

    const serialized = serializePhases(phases);
    const deserialized = deserializePhases(serialized);
    expect(deserialized.phases[0]!.failureHashes).toEqual({ 'src/foo.ts': 'abc123def4567890' });
    expect(deserialized.phases[0]!.modifiedFiles).toEqual(['src/foo.ts']);
  });

  it('throws on malformed file', () => {
    expect(() => deserializePhases('garbage content')).toThrow();
  });

  it('throws on unknown status value', () => {
    const badContent = [
      '# Phases: plan-001 — test.md',
      'Created: 2026-01-01',
      'Updated: 2026-01-01',
      'Plan hash: abc123def4567890',
      '',
      '## phase-1: Test',
      '**Kind:** implement',
      '**Status:** unknown_bad_status',
      '**Context:** (none)',
      '**Depends on:** (none)',
      '',
      'Description here',
      '',
      '---',
    ].join('\n');
    expect(() => deserializePhases(badContent)).toThrow('Unknown phase status');
  });

  it('throws on unknown kind value', () => {
    const badContent = [
      '# Phases: plan-001 — test.md',
      'Created: 2026-01-01',
      'Updated: 2026-01-01',
      'Plan hash: abc123def4567890',
      '',
      '## phase-1: Test',
      '**Kind:** unknown_bad_kind',
      '**Status:** pending',
      '**Context:** (none)',
      '**Depends on:** (none)',
      '',
      'Description here',
      '',
      '---',
    ].join('\n');
    expect(() => deserializePhases(badContent)).toThrow('Unknown phase kind');
  });
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

describe('getNextPhase', () => {
  function makePhases(statuses: Array<{ id: string; status: string; dependsOn?: string[] }>): PlanPhases {
    return {
      planId: 'plan-001',
      planFile: 'test.md',
      planContentHash: 'abc',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      phases: statuses.map((s) => ({
        id: s.id,
        title: s.id,
        kind: 'implement' as const,
        description: '',
        status: s.status as any,
        dependsOn: s.dependsOn ?? [],
        contextFiles: [],
      })),
    };
  }

  it('returns first pending phase when no in-progress or failed', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'pending' },
      { id: 'phase-2', status: 'pending' },
    ]);
    expect(getNextPhase(phases)?.id).toBe('phase-1');
  });

  it('returns in-progress phase (resume)', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'done' },
      { id: 'phase-2', status: 'in-progress' },
      { id: 'phase-3', status: 'pending' },
    ]);
    expect(getNextPhase(phases)?.id).toBe('phase-2');
  });

  it('returns failed phase for retry', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'done' },
      { id: 'phase-2', status: 'failed' },
      { id: 'phase-3', status: 'pending' },
    ]);
    expect(getNextPhase(phases)?.id).toBe('phase-2');
  });

  it('returns null when all done', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'done' },
      { id: 'phase-2', status: 'done' },
    ]);
    expect(getNextPhase(phases)).toBeNull();
  });

  it('skips phases with unmet dependencies', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'pending', dependsOn: [] },
      { id: 'phase-2', status: 'pending', dependsOn: ['phase-1'] },
    ]);
    expect(getNextPhase(phases)?.id).toBe('phase-1');
  });

  it('returns null when dependencies are unmet', () => {
    const phases = makePhases([
      { id: 'phase-1', status: 'skipped' },
      { id: 'phase-2', status: 'pending', dependsOn: ['phase-1'] },
    ]);
    // skipped counts as met
    expect(getNextPhase(phases)?.id).toBe('phase-2');
  });
});

// ---------------------------------------------------------------------------
// checkStaleness
// ---------------------------------------------------------------------------

describe('checkStaleness', () => {
  it('same content → not stale', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    expect(checkStaleness(phases, SAMPLE_PLAN)).toEqual({ stale: false, message: '' });
  });

  it('different content → stale', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const result = checkStaleness(phases, SAMPLE_PLAN + '\nModified!');
    expect(result.stale).toBe(true);
    expect(result.message).toContain('changed');
  });
});

// ---------------------------------------------------------------------------
// buildPhasePrompt
// ---------------------------------------------------------------------------

describe('buildPhasePrompt', () => {
  const phase: PlanPhase = {
    id: 'phase-1',
    title: 'Implement foo',
    kind: 'implement',
    description: 'Implement changes to foo.ts',
    status: 'pending',
    dependsOn: [],
    contextFiles: ['src/foo.ts', 'src/foo.test.ts'],
    changeSpec: '- `src/foo.ts` — Add doStuff()',
  };

  it('includes objective from plan', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).toContain('Add a plan manager');
  });

  it('includes changeSpec for implement phases', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).toContain('Add doStuff()');
  });

  it('includes context files', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/foo.test.ts');
  });

  it('implement phase includes write tools instruction', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).toContain('Write');
    expect(prompt).toContain('Edit');
  });

  it('read phase uses read-only instruction', () => {
    const readPhase: PlanPhase = { ...phase, kind: 'read' };
    const prompt = buildPhasePrompt(readPhase, SAMPLE_PLAN);
    expect(prompt).toContain('Read, Glob, and Grep');
    expect(prompt).not.toContain('Write, Edit');
  });

  it('audit phase includes audit-specific framing', () => {
    const auditPhase: PlanPhase = { ...phase, kind: 'audit' };
    const prompt = buildPhasePrompt(auditPhase, SAMPLE_PLAN);
    expect(prompt).toContain('Audit');
    expect(prompt).toContain('plan specification');
  });

  it('injectedContext appears after objective', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN, '### File: workspace/TOOLS.md\n```\ncontent\n```');
    const objIdx = prompt.indexOf('Objective');
    const injIdx = prompt.indexOf('Pre-read Context Files');
    const specIdx = prompt.indexOf('Change Specification');
    expect(injIdx).toBeGreaterThan(objIdx);
    expect(specIdx).toBeGreaterThan(injIdx);
  });

  it('no injection block when injectedContext is undefined', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).not.toContain('Pre-read Context Files');
  });

  it('does not include workspace exclusion instruction', () => {
    const prompt = buildPhasePrompt(phase, SAMPLE_PLAN);
    expect(prompt).not.toContain('Do not modify workspace');
    expect(prompt).not.toContain('workspace exclusion');
  });
});

// ---------------------------------------------------------------------------
// resolveProjectCwd
// ---------------------------------------------------------------------------

describe('resolveProjectCwd', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    wsDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(wsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves known project from plan content', async () => {
    const projectDir = path.join(tmpDir, 'my-project');
    await fs.mkdir(projectDir, { recursive: true });
    const map = { 'my-project': projectDir };
    const plan = '**Project:** my-project\n';
    const result = resolveProjectCwd(plan, wsDir, map);
    expect(result).toBe(projectDir);
  });

  it('throws for unknown project', () => {
    const plan = '**Project:** unknown-project\n';
    expect(() => resolveProjectCwd(plan, wsDir, {})).toThrow('not in project directory map');
  });

  it('throws for missing Project field', () => {
    const plan = '**Status:** DRAFT\n';
    expect(() => resolveProjectCwd(plan, wsDir)).toThrow('no **Project:** field');
  });

  it('throws when project dir does not exist', () => {
    const map = { 'gone-project': path.join(tmpDir, 'does-not-exist') };
    const plan = '**Project:** gone-project\n';
    expect(() => resolveProjectCwd(plan, wsDir, map)).toThrow('does not exist');
  });

  it('passes validation when no symlinks to workspace', async () => {
    const projectDir = path.join(tmpDir, 'clean-project');
    await fs.mkdir(projectDir, { recursive: true });
    const map = { 'clean-project': projectDir };
    const plan = '**Project:** clean-project\n';
    const result = resolveProjectCwd(plan, wsDir, map);
    expect(result).toBeTruthy();
  });

  it('allows project dir with symlink to workspace', async () => {
    const projectDir = path.join(tmpDir, 'linked-project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(wsDir, path.join(projectDir, 'ws-link'));
    const map = { 'linked-project': projectDir };
    const plan = '**Project:** linked-project\n';
    expect(() => resolveProjectCwd(plan, wsDir, map)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveContextFilePath
// ---------------------------------------------------------------------------

describe('resolveContextFilePath', () => {
  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;

  beforeEach(async () => {
    const rawTmpDir = await makeTmpDir();
    // Canonicalize so tests match realpath-based return values (e.g. macOS /tmp → /private/tmp)
    tmpDir = fsSync.realpathSync(rawTmpDir);
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(wsDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'src', 'discord'), { recursive: true });
    await fs.mkdir(path.join(wsDir, 'plans'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves source file against projectCwd', () => {
    const resolved = resolveContextFilePath('src/discord/plan-commands.ts', projectDir, wsDir);
    expect(resolved).toBe(path.join(projectDir, 'src/discord/plan-commands.ts'));
  });

  it('strips workspace/ prefix and resolves against workspaceCwd', () => {
    const resolved = resolveContextFilePath('workspace/plans/plan-011.md', projectDir, wsDir);
    expect(resolved).toBe(path.join(wsDir, 'plans/plan-011.md'));
  });

  it('workspace/TOOLS.md resolves correctly (no double workspace)', () => {
    const resolved = resolveContextFilePath('workspace/TOOLS.md', projectDir, wsDir);
    expect(resolved).toBe(path.join(wsDir, 'TOOLS.md'));
    expect(resolved).not.toContain('workspace/workspace');
  });

  it('rejects path traversal outside both roots', () => {
    expect(() => {
      resolveContextFilePath('../../etc/passwd', projectDir, wsDir);
    }).toThrow('outside allowed roots');
  });

  it('rejects symlink traversal outside roots', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');

    // Create a symlink inside project pointing outside
    await fs.symlink(outsideDir, path.join(projectDir, 'src', 'evil-link'));

    expect(() => {
      resolveContextFilePath('src/evil-link/secret.txt', projectDir, wsDir);
    }).toThrow('outside allowed roots');
  });

  it('allows non-existent file under legitimate parent', () => {
    const resolved = resolveContextFilePath('src/discord/newfile.ts', projectDir, wsDir);
    expect(resolved).toBe(path.join(projectDir, 'src/discord/newfile.ts'));
  });

  it('unprefixed path resolves against projectCwd', () => {
    const resolved = resolveContextFilePath('src/config.ts', projectDir, wsDir);
    expect(resolved).toBe(path.join(projectDir, 'src/config.ts'));
  });

  it('bare TOOLS.md (not normalized) resolves against projectCwd', () => {
    // This is correct: bare names without workspace/ prefix go to projectCwd
    const resolved = resolveContextFilePath('TOOLS.md', projectDir, wsDir);
    expect(resolved).toBe(path.join(projectDir, 'TOOLS.md'));
  });
});

// ---------------------------------------------------------------------------
// writePhasesFile (atomic writes)
// ---------------------------------------------------------------------------

describe('writePhasesFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes serialized data and no .tmp remains', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const filePath = path.join(tmpDir, 'phases.md');

    writePhasesFile(filePath, phases);

    expect(fsSync.existsSync(filePath)).toBe(true);
    expect(fsSync.existsSync(filePath + '.tmp')).toBe(false);

    const content = fsSync.readFileSync(filePath, 'utf-8');
    expect(content).toContain('plan-011');
  });

  it('overwrites existing file atomically', () => {
    const phases1 = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const filePath = path.join(tmpDir, 'phases.md');

    writePhasesFile(filePath, phases1);

    const phases2 = { ...phases1, updatedAt: '2026-12-31' };
    writePhasesFile(filePath, phases2);

    const content = fsSync.readFileSync(filePath, 'utf-8');
    expect(content).toContain('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// executePhase
// ---------------------------------------------------------------------------

describe('executePhase', () => {
  const phase: PlanPhase = {
    id: 'phase-1',
    title: 'Test phase',
    kind: 'implement',
    description: 'Test',
    status: 'in-progress',
    dependsOn: [],
    contextFiles: ['src/foo.ts'],
  };

  const basePhases: PlanPhases = {
    planId: 'plan-001',
    planFile: 'test.md',
    planContentHash: 'abc',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    phases: [phase],
  };

  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(wsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeOpts(runtime: RuntimeAdapter): PhaseExecutionOpts {
    return {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
    };
  }

  it('returns done on success', async () => {
    const result = await executePhase(phase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime('Done!')));
    expect(result.status).toBe('done');
    expect(result.output).toBe('Done!');
  });

  it('returns failed on runtime error', async () => {
    const result = await executePhase(phase, SAMPLE_PLAN, basePhases, makeOpts(makeErrorRuntime('Runtime broke')));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('Runtime broke');
    }
  });

  it('does not mutate phases object', async () => {
    const phasesCopy = JSON.parse(JSON.stringify(basePhases));
    await executePhase(phase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime('ok')));
    expect(basePhases).toEqual(phasesCopy);
  });

  it('forwards injectedContext to prompt', async () => {
    let capturedPrompt = '';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params) {
        capturedPrompt = params.prompt;
        yield { type: 'text_final', text: 'ok' };
      },
    };

    await executePhase(phase, SAMPLE_PLAN, basePhases, makeOpts(runtime), '### File: workspace/TOOLS.md\ncontent');
    expect(capturedPrompt).toContain('Pre-read Context Files');
    expect(capturedPrompt).toContain('workspace/TOOLS.md');
  });

  it('filters workspace path from implement phase addDirs', async () => {
    let capturedAddDirs: string[] | undefined;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params) {
        capturedAddDirs = params.addDirs;
        yield { type: 'text_final', text: 'ok' };
      },
    };

    const opts = makeOpts(runtime);
    opts.addDirs = [wsDir, '/other/dir'];

    await executePhase(phase, SAMPLE_PLAN, basePhases, opts);
    // Workspace should be filtered out, /other/dir preserved
    expect(capturedAddDirs).not.toContain(wsDir);
  });

  it('includes workspace path for read/audit phases', async () => {
    let capturedAddDirs: string[] | undefined;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params) {
        capturedAddDirs = params.addDirs;
        yield { type: 'text_final', text: 'ok' };
      },
    };

    const readPhase: PlanPhase = { ...phase, kind: 'read' };
    const opts = makeOpts(runtime);

    await executePhase(readPhase, SAMPLE_PLAN, basePhases, opts);
    expect(capturedAddDirs).toContain(wsDir);
  });

  it('preserves non-workspace addDirs for implement phases', async () => {
    let capturedAddDirs: string[] | undefined;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params) {
        capturedAddDirs = params.addDirs;
        yield { type: 'text_final', text: 'ok' };
      },
    };

    const opts = makeOpts(runtime);
    opts.addDirs = ['/some/other/dir'];

    await executePhase(phase, SAMPLE_PLAN, basePhases, opts);
    // /some/other/dir should be passed through (it's not workspace)
    // Note: it only appears if addDirs has items
    expect(capturedAddDirs).toEqual(['/some/other/dir']);
  });
});

// ---------------------------------------------------------------------------
// runNextPhase
// ---------------------------------------------------------------------------

describe('runNextPhase', () => {
  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;
  let plansDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    plansDir = path.join(wsDir, 'plans');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(plansDir, { recursive: true });

    // Init git in project dir
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: projectDir, stdio: 'pipe' });
      // Create initial commit
      await fs.writeFile(path.join(projectDir, 'README.md'), 'test');
      execSync('git add . && git commit -m "init"', { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // git not available — tests will still work for non-git paths
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeOpts(runtime: RuntimeAdapter): PhaseExecutionOpts {
    return {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
    };
  }

  const progressMsgs: string[] = [];
  const onProgress = async (msg: string) => { progressMsgs.push(msg); };

  beforeEach(() => {
    progressMsgs.length = 0;
  });

  it('happy path: executes next phase and writes updated status', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Phase done!')), onProgress);
    expect(result.result).toBe('done');

    // Read back phases file to verify status was updated
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    expect(updated.phases[0]!.status).toBe('done');
  });

  it('stale plan → returns stale', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    // Modify plan after generating phases
    await fs.writeFile(planPath, SAMPLE_PLAN + '\nModified!');

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('stale');
  });

  it('all done → returns nothing_to_run', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    // Mark all phases as done
    for (const p of phases.phases) p.status = 'done';
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('nothing_to_run');
  });

  it('corrupt phases file → returns corrupt', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    fsSync.writeFileSync(phasesPath, 'garbage content', 'utf-8');

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('corrupt');
  });

  it('phase failure → marks failed with error', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeErrorRuntime('Timeout!')), onProgress);
    expect(result.result).toBe('failed');
    if (result.result === 'failed') {
      expect(result.error).toContain('Timeout!');
    }

    // Verify status on disk
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    expect(updated.phases[0]!.status).toBe('failed');
  });

  it('retry blocked without modifiedFiles in git env', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    // Simulate a failed phase without modifiedFiles
    phases.phases[0]!.status = 'failed';
    phases.phases[0]!.error = 'previous error';
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('retry_blocked');
    if (result.result === 'retry_blocked') {
      expect(result.message).toContain('modifiedFiles');
    }

    // Verify status is still failed on disk (not changed to in-progress)
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    expect(updated.phases[0]!.status).toBe('failed');
  });

  it('retry blocked with modifiedFiles but no failureHashes', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    phases.phases[0]!.status = 'failed';
    phases.phases[0]!.modifiedFiles = ['src/foo.ts'];
    // No failureHashes
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('retry_blocked');
    if (result.result === 'retry_blocked') {
      expect(result.message).toContain('failureHashes');
    }
  });

  it('git commit skipped when no files modified', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    // Runtime that doesn't create any files
    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Done!')), onProgress);
    expect(result.result).toBe('done');

    // No git commit should be created for this phase
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    expect(updated.phases[0]!.gitCommit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workspace filename normalization in decomposePlan
// ---------------------------------------------------------------------------

describe('workspace filename normalization', () => {
  it('bare TOOLS.md normalized to workspace/TOOLS.md', () => {
    const plan = SAMPLE_PLAN.replace('`workspace/TOOLS.md`', '`TOOLS.md`');
    const phases = decomposePlan(plan, 'plan-011', 'test.md');
    const allFiles = phases.phases.flatMap((p) => p.contextFiles);
    expect(allFiles).not.toContain('TOOLS.md');
  });

  it('already-prefixed workspace/TOOLS.md is unchanged', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const allFiles = phases.phases.flatMap((p) => p.contextFiles);
    // Should have workspace/TOOLS.md, not workspace/workspace/TOOLS.md
    for (const f of allFiles) {
      expect(f).not.toContain('workspace/workspace');
    }
  });

  it('source-relative paths are unchanged', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const allFiles = phases.phases.flatMap((p) => p.contextFiles);
    const srcFiles = allFiles.filter((f) => f.startsWith('src/'));
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const f of srcFiles) {
      expect(f.startsWith('workspace/src/')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// updatePhaseStatus
// ---------------------------------------------------------------------------

describe('updatePhaseStatus', () => {
  it('updates status immutably', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const original = JSON.parse(JSON.stringify(phases));

    const updated = updatePhaseStatus(phases, phases.phases[0]!.id, 'done', 'output text');
    expect(updated.phases[0]!.status).toBe('done');
    expect(updated.phases[0]!.output).toBe('output text');

    // Original unchanged
    expect(phases.phases[0]!.status).toBe(original.phases[0].status);
  });

  it('sets updatedAt', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const updated = updatePhaseStatus(phases, phases.phases[0]!.id, 'failed', undefined, 'error msg');
    expect(updated.updatedAt).toBeTruthy();
    expect(updated.phases[0]!.error).toBe('error msg');
  });
});

// ---------------------------------------------------------------------------
// Audit verdict handling in executePhase
// ---------------------------------------------------------------------------

describe('executePhase audit verdict', () => {
  const auditPhase: PlanPhase = {
    id: 'phase-2',
    title: 'Post-implementation audit',
    kind: 'audit',
    description: 'Audit all changes against the plan specification.',
    status: 'in-progress',
    dependsOn: ['phase-1'],
    contextFiles: ['src/foo.ts'],
  };

  const implPhase: PlanPhase = {
    id: 'phase-1',
    title: 'Implement foo',
    kind: 'implement',
    description: 'Implement changes to foo.ts',
    status: 'in-progress',
    dependsOn: [],
    contextFiles: ['src/foo.ts'],
  };

  const basePhases: PlanPhases = {
    planId: 'plan-001',
    planFile: 'test.md',
    planContentHash: 'abc',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    phases: [implPhase, auditPhase],
  };

  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(wsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeOpts(runtime: RuntimeAdapter): PhaseExecutionOpts {
    return {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
    };
  }

  it('audit phase with HIGH severity returns audit_failed', async () => {
    const auditOutput = '**Concern 1: Missing error handling**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(auditOutput)));
    expect(result.status).toBe('audit_failed');
    if (result.status === 'audit_failed') {
      expect(result.verdict.maxSeverity).toBe('high');
      expect(result.verdict.shouldLoop).toBe(true);
    }
  });

  it('audit phase with only LOW severity returns done', async () => {
    const auditOutput = '**Concern 1: Minor nitpick**\n**Severity: low**\n\n**Verdict:** Ready to approve.';
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(auditOutput)));
    expect(result.status).toBe('done');
  });

  it('audit phase with no severity markers returns done', async () => {
    const auditOutput = 'Everything looks great. No concerns.';
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(auditOutput)));
    expect(result.status).toBe('done');
  });

  it('implement phase ignores severity markers in output', async () => {
    const implOutput = '**Severity: HIGH**\nDone implementing.';
    const result = await executePhase(implPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(implOutput)));
    expect(result.status).toBe('done');
  });

  it('audit phase with runtime error returns failed not audit_failed', async () => {
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeErrorRuntime('Connection timeout')));
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Audit verdict handling in runNextPhase
// ---------------------------------------------------------------------------

describe('runNextPhase audit verdict', () => {
  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;
  let plansDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    plansDir = path.join(wsDir, 'plans');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(plansDir, { recursive: true });

    // Init git in project dir
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: projectDir, stdio: 'pipe' });
      await fs.writeFile(path.join(projectDir, 'README.md'), 'test');
      execSync('git add . && git commit -m "init"', { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // git not available
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeOpts(runtime: RuntimeAdapter): PhaseExecutionOpts {
    return {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
    };
  }

  const progressMsgs: string[] = [];
  const onProgress = async (msg: string) => { progressMsgs.push(msg); };

  beforeEach(() => {
    progressMsgs.length = 0;
  });

  // Helper to create a phases file with a single audit phase ready to run
  function writeAuditPhases(phasesPath: string, planPath: string, overrides?: Partial<PlanPhase>) {
    const phases: PlanPhases = {
      planId: 'plan-011',
      planFile: 'workspace/plans/plan-011-test.md',
      planContentHash: computePlanHash(SAMPLE_PLAN),
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      phases: [
        {
          id: 'phase-1',
          title: 'Implement src/discord/',
          kind: 'implement',
          description: 'Implement changes.',
          status: 'done',
          dependsOn: [],
          contextFiles: ['src/foo.ts'],
          output: 'Done.',
          ...({} as any), // base phase
        },
        {
          id: 'phase-2',
          title: 'Post-implementation audit',
          kind: 'audit',
          description: 'Audit all changes against the plan specification.',
          status: 'pending',
          dependsOn: ['phase-1'],
          contextFiles: ['src/foo.ts'],
          ...overrides,
        },
      ],
    };
    writePhasesFile(phasesPath, phases);
  }

  it('audit phase with HIGH severity returns audit_failed result', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath, planPath);

    const auditOutput = '**Concern 1: Missing error handling**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime(auditOutput)), onProgress);

    expect(result.result).toBe('audit_failed');
    if (result.result === 'audit_failed') {
      expect(result.verdict.maxSeverity).toBe('high');
    }

    // Verify on-disk status is 'failed' (not 'audit_failed')
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    const auditPhase = updated.phases.find(p => p.id === 'phase-2')!;
    expect(auditPhase.status).toBe('failed');
  });

  it('failed audit phase can be retried (not blocked by modifiedFiles check)', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    // Set audit phase to failed with no modifiedFiles (would block non-audit phases)
    writeAuditPhases(phasesPath, planPath, {
      status: 'failed',
      error: 'previous audit failure',
    });

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('All good. No concerns.')), onProgress);
    // Should proceed to execution (not retry_blocked)
    expect(result.result).not.toBe('retry_blocked');
  });

  it('failed implement phase without modifiedFiles is still retry_blocked', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    // Simulate a failed implement phase without modifiedFiles
    phases.phases[0]!.status = 'failed';
    phases.phases[0]!.error = 'previous error';
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('retry_blocked');
  });
});

// ---------------------------------------------------------------------------
// buildAuditFixPrompt
// ---------------------------------------------------------------------------

describe('buildAuditFixPrompt', () => {
  const auditPhase: PlanPhase = {
    id: 'phase-2',
    title: 'Post-implementation audit',
    kind: 'audit',
    description: 'Audit all changes against the plan specification.',
    status: 'in-progress',
    dependsOn: ['phase-1'],
    contextFiles: ['src/foo.ts', 'src/bar.ts'],
  };

  it('includes objective from plan', () => {
    const prompt = buildAuditFixPrompt(auditPhase, SAMPLE_PLAN, 'Audit findings here');
    expect(prompt).toContain('Add a plan manager');
  });

  it('includes audit findings', () => {
    const findings = '**Concern 1: Missing error handling**\n**Severity: HIGH**';
    const prompt = buildAuditFixPrompt(auditPhase, SAMPLE_PLAN, findings);
    expect(prompt).toContain('Missing error handling');
    expect(prompt).toContain('Severity: HIGH');
  });

  it('lists files to fix', () => {
    const prompt = buildAuditFixPrompt(auditPhase, SAMPLE_PLAN, 'findings');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/bar.ts');
  });

  it('includes fix instructions with write tools', () => {
    const prompt = buildAuditFixPrompt(auditPhase, SAMPLE_PLAN, 'findings');
    expect(prompt).toContain('fix every high and medium severity concern');
    expect(prompt).toContain('Write');
    expect(prompt).toContain('Edit');
  });
});

// ---------------------------------------------------------------------------
// Audit fix loop in runNextPhase
// ---------------------------------------------------------------------------

describe('runNextPhase audit fix loop', () => {
  let tmpDir: string;
  let projectDir: string;
  let wsDir: string;
  let plansDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    projectDir = path.join(tmpDir, 'project');
    wsDir = path.join(tmpDir, 'workspace');
    plansDir = path.join(wsDir, 'plans');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(plansDir, { recursive: true });

    // Init git in project dir
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: projectDir, stdio: 'pipe' });
      await fs.writeFile(path.join(projectDir, 'README.md'), 'test');
      execSync('git add . && git commit -m "init"', { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // git not available
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const progressMsgs: string[] = [];
  const onProgress = async (msg: string) => { progressMsgs.push(msg); };

  beforeEach(() => {
    progressMsgs.length = 0;
  });

  function writeAuditPhases(phasesPath: string, overrides?: Partial<PlanPhase>) {
    const phases: PlanPhases = {
      planId: 'plan-011',
      planFile: 'workspace/plans/plan-011-test.md',
      planContentHash: computePlanHash(SAMPLE_PLAN),
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      phases: [
        {
          id: 'phase-1',
          title: 'Implement src/discord/',
          kind: 'implement',
          description: 'Implement changes.',
          status: 'done',
          dependsOn: [],
          contextFiles: ['src/foo.ts'],
          output: 'Done.',
        },
        {
          id: 'phase-2',
          title: 'Post-implementation audit',
          kind: 'audit',
          description: 'Audit all changes against the plan specification.',
          status: 'pending',
          dependsOn: ['phase-1'],
          contextFiles: ['src/foo.ts'],
          ...overrides,
        },
      ],
    };
    writePhasesFile(phasesPath, phases);
  }

  it('fix loop succeeds on first attempt → returns done', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    // First call: audit fails. After fix agent runs, second audit passes.
    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke() {
        callCount++;
        if (callCount === 1) {
          // First audit: fails
          const text = '**Concern 1: Missing validation**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 2) {
          // Fix agent
          const text = 'Fixed the validation issue.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Re-audit: passes
          const text = 'No concerns. **Verdict:** Ready to approve.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        }
      },
    };

    const opts: PhaseExecutionOpts = {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
      maxAuditFixAttempts: 2,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('done');
    expect(callCount).toBe(3); // audit + fix + re-audit
    expect(progressMsgs.some(m => m.includes('Fix attempt 1'))).toBe(true);
  });

  it('exhausted fix attempts → rollback and return audit_failed', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    // Create an uncommitted file that should be cleaned up by rollback
    await fs.writeFile(path.join(projectDir, 'dirty-file.txt'), 'should be cleaned');

    // Every audit returns HIGH severity — fixes never work
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke() {
        const text = '**Concern 1: Still broken**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
        yield { type: 'text_delta', text };
        yield { type: 'text_final', text };
      },
    };

    const opts: PhaseExecutionOpts = {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
      maxAuditFixAttempts: 2,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('audit_failed');
    // Rollback should have cleaned the dirty file
    expect(fsSync.existsSync(path.join(projectDir, 'dirty-file.txt'))).toBe(false);
    expect(progressMsgs.some(m => m.includes('Rolling back'))).toBe(true);
  });

  it('maxAuditFixAttempts=0 skips fix loop entirely', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    const auditOutput = '**Concern 1: Issue**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';

    const opts: PhaseExecutionOpts = {
      runtime: makeSuccessRuntime(auditOutput),
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
      maxAuditFixAttempts: 0,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('audit_failed');
    // No fix attempt messages
    expect(progressMsgs.some(m => m.includes('Fix attempt'))).toBe(false);
  });

  it('no git repo → skips fix loop', async () => {
    // Create a non-git project dir
    const noGitDir = path.join(tmpDir, 'no-git-project');
    await fs.mkdir(noGitDir, { recursive: true });

    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    const auditOutput = '**Concern 1: Issue**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';

    const opts: PhaseExecutionOpts = {
      runtime: makeSuccessRuntime(auditOutput),
      model: 'test',
      projectCwd: noGitDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
      maxAuditFixAttempts: 2,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('audit_failed');
    // Should not attempt fixes without git
    expect(progressMsgs.some(m => m.includes('Fix attempt'))).toBe(false);
  });

  it('fix agent error breaks out of loop early', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke() {
        callCount++;
        if (callCount === 1) {
          // First audit: fails
          const text = '**Concern 1: Problem**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Fix agent: throws error
          yield { type: 'error', message: 'Runtime crashed' };
        }
      },
    };

    const opts: PhaseExecutionOpts = {
      runtime,
      model: 'test',
      projectCwd: projectDir,
      addDirs: [],
      timeoutMs: 5000,
      workspaceCwd: wsDir,
      maxAuditFixAttempts: 3,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('audit_failed');
    // Should only have called: audit (1) + fix attempt (1) = 2 calls
    // NOT 1 audit + 3 fix attempts
    expect(callCount).toBe(2);
  });
});
