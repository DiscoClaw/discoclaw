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
  buildPostRunSummary,
  extractObjective,
  resolveProjectCwd,
  resolveContextFilePath,
  writePhasesFile,
  readPhasesFile,
  executePhase,
  runNextPhase,
} from './plan-manager.js';
import type { PlanPhases, PlanPhase, PhaseExecutionOpts, PlanRunEvent } from './plan-manager.js';

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
**Task:** ws-test
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
**Task:** ws-audit
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

  it('extracts paths from heading format (h4)', () => {
    const section = '#### `src/discord/forge-commands.ts`\n\nSome changes here.\n\n#### `src/discord/audit-handler.ts`\n\nMore changes.';
    expect(extractFilePaths(section)).toEqual([
      'src/discord/forge-commands.ts',
      'src/discord/audit-handler.ts',
    ]);
  });

  it('extracts paths from mixed list and heading formats', () => {
    const section = [
      '#### `src/discord/forge-commands.ts`',
      '',
      '- `AuditVerdict` type: changes',
      '- `parseAuditVerdict()` updates',
      '',
      '#### `src/discord/plan-manager.ts`',
      '',
      '- `buildPhasePrompt()` audit section',
    ].join('\n');
    expect(extractFilePaths(section)).toEqual([
      'src/discord/forge-commands.ts',
      'src/discord/plan-manager.ts',
    ]);
  });

  it('rejects non-file-path headings', () => {
    const section = '#### `PlanPhase` type\n\n#### `src/foo.ts`\n\n#### `PLAN_PHASES_ENABLED`';
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('deduplicates across list and heading formats', () => {
    const section = '#### `src/foo.ts`\n\n- `src/foo.ts` — same file again';
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('extracts bold-wrapped backtick paths in list items', () => {
    const section = '- **`src/index.ts`** (lines ~622–691) — Reorder\n- **`src/tasks/initialize.ts`** — Two options';
    expect(extractFilePaths(section)).toEqual([
      'src/index.ts',
      'src/tasks/initialize.ts',
    ]);
  });

  it('extracts bold-wrapped backtick paths in headings', () => {
    const section = '#### **`src/discord/forge-commands.ts`**\n\nSome changes.';
    expect(extractFilePaths(section)).toEqual(['src/discord/forge-commands.ts']);
  });

  it('extracts italic-wrapped backtick paths', () => {
    const section = '- *`src/foo.ts`* — italic wrapped';
    expect(extractFilePaths(section)).toEqual(['src/foo.ts']);
  });

  it('extracts standalone bold entries used in file-by-file breakdowns', () => {
    const section = [
      '### File-by-file breakdown',
      '',
      '**`src/foo/bar.ts`** — Reorder exports',
      '  - Update imports',
      '',
      '**`src/config/settings.ts`**',
      '  - Align with new site theming',
    ].join('\n');
    expect(extractFilePaths(section)).toEqual(['src/foo/bar.ts', 'src/config/settings.ts']);
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

  it('plan with no file paths → read, implement, audit phases', () => {
    const planPath = 'workspace/plans/plan-010.md';
    const phases = decomposePlan(SAMPLE_PLAN_NO_CHANGES, 'plan-010', planPath);
    expect(phases.phases).toHaveLength(3);
    expect(phases.phases[0]!.kind).toBe('read');
    expect(phases.phases[1]!.kind).toBe('implement');
    const auditPhase = phases.phases[2]!;
    expect(auditPhase.kind).toBe('audit');
    expect(auditPhase.dependsOn).toEqual(['phase-2']);
    expect(auditPhase.contextFiles).toEqual([planPath]);
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

  it('prefers Change Manifest file list over Changes heuristics', () => {
    const plan = [
      '# Plan: Manifest test',
      '',
      '**ID:** plan-011',
      '**Task:** ws-test',
      '**Created:** 2026-02-12',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '',
      '## Objective',
      '',
      'Test manifest.',
      '',
      '## Changes',
      '',
      '- `src/from-changes.ts` — would be used without manifest',
      '',
      '## Change Manifest',
      '',
      '```json',
      '["src/from-manifest.ts"]',
      '```',
    ].join('\n');

    const phases = decomposePlan(plan, 'plan-011', 'workspace/plans/plan-011.md');
    const allContextFiles = phases.phases.flatMap((p) => p.contextFiles);
    expect(allContextFiles.some((f) => f.includes('from-manifest.ts'))).toBe(true);
    expect(allContextFiles.some((f) => f.includes('from-changes.ts'))).toBe(false);
  });

  it('falls back to Changes parsing when Change Manifest is invalid', () => {
    const plan = [
      '# Plan: Manifest fallback test',
      '',
      '**ID:** plan-011',
      '**Task:** ws-test',
      '**Created:** 2026-02-12',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '',
      '## Objective',
      '',
      'Test manifest fallback.',
      '',
      '## Changes',
      '',
      '- `src/fallback-file.ts` — should be picked',
      '',
      '## Change Manifest',
      '',
      '```json',
      '[{"not":"an array of paths"}]',
      '```',
    ].join('\n');

    const phases = decomposePlan(plan, 'plan-011', 'workspace/plans/plan-011.md');
    const allContextFiles = phases.phases.flatMap((p) => p.contextFiles);
    expect(allContextFiles.some((f) => f.includes('fallback-file.ts'))).toBe(true);
  });

  it('ignores top-level heading markers inside code fences while scanning sections', () => {
    const plan = [
      '# Plan: Fence test',
      '',
      '**ID:** plan-011',
      '**Task:** ws-test',
      '**Created:** 2026-02-12',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '',
      '## Objective',
      '',
      'Section scanner should ignore headings in code fences.',
      '',
      '## Changes',
      '',
      '```md',
      '## Not really a top-level section',
      '```',
      '',
      '- `src/fence-safe.ts` — file entry',
      '',
      '## Risks',
      '',
      '- none',
    ].join('\n');

    const phases = decomposePlan(plan, 'plan-011', 'workspace/plans/plan-011.md');
    const allContextFiles = phases.phases.flatMap((p) => p.contextFiles);
    expect(allContextFiles.some((f) => f.includes('fence-safe.ts'))).toBe(true);
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

  it('audit phase prompt uses new severity vocabulary', () => {
    const auditPhase: PlanPhase = { ...phase, kind: 'audit' };
    const prompt = buildPhasePrompt(auditPhase, SAMPLE_PLAN);
    expect(prompt).toContain('blocking | medium | minor | suggestion');
    expect(prompt).not.toContain('Severity: high | medium | low');
  });

  it('audit phase prompt includes severity definitions', () => {
    const auditPhase: PlanPhase = { ...phase, kind: 'audit' };
    const prompt = buildPhasePrompt(auditPhase, SAMPLE_PLAN);
    expect(prompt).toContain('Correctness bugs, security issues, architectural flaws');
  });

  it('audit phase prompt uses blocking-only verdict logic', () => {
    const auditPhase: PlanPhase = { ...phase, kind: 'audit' };
    const prompt = buildPhasePrompt(auditPhase, SAMPLE_PLAN);
    expect(prompt).toContain('if any blocking concerns');
    expect(prompt).toContain('if no blocking concerns');
    expect(prompt).not.toContain('if any high/medium concerns');
  });

  it.each(['implement', 'read', 'audit'] as const)('%s phase includes narration instruction', (kind) => {
    const p: PlanPhase = { ...phase, kind };
    const prompt = buildPhasePrompt(p, SAMPLE_PLAN);
    expect(prompt).toContain("briefly narrate each step");
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
    const jsonPath = path.join(tmpDir, 'phases.json');

    writePhasesFile(filePath, phases);

    expect(fsSync.existsSync(filePath)).toBe(true);
    expect(fsSync.existsSync(jsonPath)).toBe(true);
    expect(fsSync.existsSync(filePath + '.tmp')).toBe(false);
    expect(fsSync.existsSync(jsonPath + '.tmp')).toBe(false);

    const content = fsSync.readFileSync(filePath, 'utf-8');
    expect(content).toContain('plan-011');
    const json = JSON.parse(fsSync.readFileSync(jsonPath, 'utf-8'));
    expect(json.version).toBe(1);
    expect(json.planId).toBe('plan-011');
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

  it('readPhasesFile prefers json and falls back to markdown with backfill', () => {
    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'test.md');
    const filePath = path.join(tmpDir, 'phases.md');
    const jsonPath = path.join(tmpDir, 'phases.json');

    writePhasesFile(filePath, phases);

    // Mutate json state so we can verify json-first reads.
    const json = JSON.parse(fsSync.readFileSync(jsonPath, 'utf-8'));
    json.updatedAt = '2099-01-01';
    fsSync.writeFileSync(jsonPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');

    const fromJson = readPhasesFile(filePath);
    expect(fromJson.updatedAt).toBe('2099-01-01');

    // Corrupt json; reader should fall back to markdown and backfill json.
    fsSync.writeFileSync(jsonPath, '{"version":1,"bad":', 'utf-8');
    const fromMd = readPhasesFile(filePath);
    expect(fromMd.planId).toBe('plan-011');

    const backfilled = JSON.parse(fsSync.readFileSync(jsonPath, 'utf-8'));
    expect(backfilled.planId).toBe('plan-011');
    expect(backfilled.version).toBe(1);
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

  it('passes signal through to runtime.invoke()', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params) {
        capturedSignal = params.signal;
        yield { type: 'text_final', text: 'ok' };
      },
    };

    const ac = new AbortController();
    const opts = makeOpts(runtime);
    opts.signal = ac.signal;

    await executePhase(phase, SAMPLE_PLAN, basePhases, opts);
    // Loop detection composes a combined signal via AbortSignal.any(),
    // so it won't be the same reference — but aborting the caller should propagate.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
    ac.abort();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('returns failed when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke() {
        yield { type: 'error', message: 'aborted' };
      },
    };

    const opts = makeOpts(runtime);
    opts.signal = ac.signal;

    const result = await executePhase(phase, SAMPLE_PLAN, basePhases, opts);
    expect(result.status).toBe('failed');
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

  it('forwards events to opts.onEvent via PhaseExecutionOpts', async () => {
    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'working...' },
      { type: 'text_final', text: 'Done!' },
    ];
    const runtime = makeRuntime(events);
    const received: EngineEvent[] = [];

    const opts = makeOpts(runtime);
    opts.onEvent = (evt) => received.push(evt);

    await executePhase(phase, SAMPLE_PLAN, basePhases, opts);

    expect(received).toEqual(events);
  });

  it('onEvent spy receives events in order across multiple events', async () => {
    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_final', text: 'ab' },
    ];
    const runtime = makeRuntime(events);
    const received: EngineEvent[] = [];

    const opts = makeOpts(runtime);
    opts.onEvent = (evt) => received.push(evt);

    const result = await executePhase(phase, SAMPLE_PLAN, basePhases, opts);

    expect(result.status).toBe('done');
    expect(received.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'text_final']);
  });

  it('throwing onEvent does not abort phase execution', async () => {
    const runtime = makeSuccessRuntime('Done!');
    const opts = makeOpts(runtime);
    opts.onEvent = () => { throw new Error('callback error'); };

    const result = await executePhase(phase, SAMPLE_PLAN, basePhases, opts);

    expect(result.status).toBe('done');
    expect(result.output).toBe('Done!');
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

  it('emits a typed phase_start event before execution', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const events: PlanRunEvent[] = [];
    const opts = makeOpts(makeSuccessRuntime('Phase done!'));
    opts.onPlanEvent = (evt) => {
      events.push(evt);
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('done');
    expect(events).toEqual([
      {
        type: 'phase_start',
        planId: 'plan-011',
        phase: {
          id: phases.phases[0]!.id,
          title: phases.phases[0]!.title,
          kind: phases.phases[0]!.kind,
        },
      },
      {
        type: 'phase_complete',
        planId: 'plan-011',
        phase: {
          id: phases.phases[0]!.id,
          title: phases.phases[0]!.title,
          kind: phases.phases[0]!.kind,
        },
        status: 'done',
      },
    ]);
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

    const phaseEvents: PlanRunEvent[] = [];
    const opts = makeOpts(makeSuccessRuntime('ok'));
    opts.onPlanEvent = (evt) => {
      phaseEvents.push(evt);
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('retry_blocked');
    if (result.result === 'retry_blocked') {
      expect(result.message).toContain('modifiedFiles');
    }
    expect(phaseEvents).toEqual([]);

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

  it('rollout corruption bypasses retry guard', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    phases.phases[0]!.status = 'failed';
    phases.phases[0]!.error = 'Codex: state db missing rollout path for thread abc';
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('ok')), onProgress);
    expect(result.result).toBe('done');
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
// Phase progress messages and nextPhase on RunPhaseResult
// ---------------------------------------------------------------------------

describe('phase progress messages and nextPhase', () => {
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

  it('phase-start message includes bold phase ID prefix', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Done!')), onProgress);

    const firstPhaseId = phases.phases[0]!.id;
    const firstPhaseTitle = phases.phases[0]!.title;
    expect(progressMsgs.some(m => m === `**${firstPhaseId}**: Running ${firstPhaseTitle}...`)).toBe(true);
  });

  it('sub-step messages include phase ID prefix', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    // Build a phases file with an implement phase that has workspace context files
    const phases: PlanPhases = {
      planId: 'plan-011',
      planFile: 'workspace/plans/plan-011-test.md',
      planContentHash: computePlanHash(SAMPLE_PLAN),
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      phases: [
        {
          id: 'phase-1',
          title: 'Implement plan',
          kind: 'implement',
          description: 'Implement changes.',
          status: 'pending',
          dependsOn: [],
          contextFiles: ['src/foo.ts', 'workspace/TOOLS.md'],
        },
      ],
    };
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Done!')), onProgress);

    // "Executing" sub-step includes phase ID prefix
    expect(progressMsgs.some(m => m === '**phase-1**: Executing implement phase...')).toBe(true);
    // "Reading context files" sub-step includes phase ID prefix (fires because workspace/ files present)
    expect(progressMsgs.some(m => m === '**phase-1**: Reading context files...')).toBe(true);
  });

  it('nextPhase is present on done result for multi-phase plans', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    // Ensure there are at least 2 phases
    expect(phases.phases.length).toBeGreaterThanOrEqual(2);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Done!')), onProgress);
    expect(result.result).toBe('done');
    if (result.result === 'done') {
      expect(result.nextPhase).toBeDefined();
      expect(result.nextPhase!.id).toBe(phases.phases[1]!.id);
      expect(result.nextPhase!.title).toBe(phases.phases[1]!.title);
    }
  });

  it('nextPhase is undefined when last phase completes', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);

    const phases = decomposePlan(SAMPLE_PLAN, 'plan-011', 'workspace/plans/plan-011-test.md');
    // Mark all phases except the last as done
    for (let i = 0; i < phases.phases.length - 1; i++) {
      phases.phases[i]!.status = 'done';
      phases.phases[i]!.output = 'Previously completed.';
    }
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writePhasesFile(phasesPath, phases);

    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime('Final phase done!')), onProgress);
    expect(result.result).toBe('done');
    if (result.result === 'done') {
      expect(result.nextPhase).toBeUndefined();
    }
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

  it('audit phase with HIGH severity returns audit_failed (backward compat)', async () => {
    const auditOutput = '**Concern 1: Missing error handling**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(auditOutput)));
    expect(result.status).toBe('audit_failed');
    if (result.status === 'audit_failed') {
      expect(result.verdict.maxSeverity).toBe('blocking');
      expect(result.verdict.shouldLoop).toBe(true);
    }
  });

  it('audit phase with only minor severity returns done', async () => {
    const auditOutput = '**Concern 1: Minor nitpick**\n**Severity: minor**\n\n**Verdict:** Ready to approve.';
    const result = await executePhase(auditPhase, SAMPLE_PLAN, basePhases, makeOpts(makeSuccessRuntime(auditOutput)));
    expect(result.status).toBe('done');
  });

  it('audit phase with only medium severity returns done (auto-approves)', async () => {
    const auditOutput = '**Concern 1: Missing edge case**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
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

  it('audit phase with blocking severity returns audit_failed result', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath, planPath);

    const auditOutput = '**Concern 1: Missing error handling**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime(auditOutput)), onProgress);

    expect(result.result).toBe('audit_failed');
    if (result.result === 'audit_failed') {
      expect(result.verdict.maxSeverity).toBe('blocking');
    }

    // Verify on-disk status is 'failed' (not 'audit_failed')
    const updated = deserializePhases(fsSync.readFileSync(phasesPath, 'utf-8'));
    const auditPhase = updated.phases.find(p => p.id === 'phase-2')!;
    expect(auditPhase.status).toBe('failed');
  });

  it('audit phase with medium-only severity returns done (auto-approves)', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath, planPath);

    const auditOutput = '**Concern 1: Missing edge case**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    const result = await runNextPhase(phasesPath, planPath, makeOpts(makeSuccessRuntime(auditOutput)), onProgress);

    expect(result.result).toBe('done');
    // No fix attempt messages — medium auto-approves
    expect(progressMsgs.some(m => m.includes('Fix attempt'))).toBe(false);
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
  const contextFiles = ['src/foo.ts', 'src/bar.ts'];
  const modifiedFiles = ['src/foo.ts', 'src/baz.ts'];

  it('includes objective from plan', () => {
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, 'Audit findings here', contextFiles, modifiedFiles, 1, 2);
    expect(prompt).toContain('Add a plan manager');
  });

  it('includes audit findings', () => {
    const findings = '**Concern 1: Missing error handling**\n**Severity: blocking**';
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, findings, contextFiles, modifiedFiles, 1, 2);
    expect(prompt).toContain('Missing error handling');
    expect(prompt).toContain('Severity: blocking');
  });

  it('lists context files', () => {
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, 'findings', contextFiles, modifiedFiles, 1, 2);
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/bar.ts');
  });

  it('includes all required sections per plan spec', () => {
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, 'findings', contextFiles, modifiedFiles, 1, 2);
    // Anti-regression instruction
    expect(prompt).toContain('Fix only the specific deviations');
    expect(prompt).toContain('Do not refactor, reorganize, or modify code that the audit did not flag');
    // Attempt counter
    expect(prompt).toContain('Fix attempt 1 of 2');
    // Limitation note
    expect(prompt).toContain('read/write file tools only');
    expect(prompt).toContain('cannot run tests, build commands, or install packages');
    // Modified files
    expect(prompt).toContain('src/baz.ts');
    // Does NOT mention Bash
    expect(prompt).not.toContain('Bash');
  });

  it('shows urgency escalation on final attempt', () => {
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, 'findings', contextFiles, modifiedFiles, 2, 2);
    expect(prompt).toContain('last chance');
    expect(prompt).toContain('Fix attempt 2 of 2');
  });

  it('handles empty modified files list', () => {
    const prompt = buildAuditFixPrompt(SAMPLE_PLAN, 'findings', contextFiles, [], 1, 1);
    expect(prompt).not.toContain('## Modified Files');
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
          const text = '**Concern 1: Missing validation**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
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
    expect(progressMsgs.some(m => m.includes('rolled back'))).toBe(true);
  });

  it('maxAuditFixAttempts=0 skips fix loop entirely', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    const auditOutput = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';

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

    const auditOutput = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';

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
    // Should emit skip message
    expect(progressMsgs.some(m => m.includes('git not available'))).toBe(true);
  });

  it('fix agent error consumes attempt and continues', async () => {
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
          const text = '**Concern 1: Problem**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Fix agent: throws error (every time)
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
      maxAuditFixAttempts: 2,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    expect(result.result).toBe('audit_failed');
    // With continue behavior: audit (1) + fix error (2) + fix error (3) = 3 calls
    expect(callCount).toBe(3);
  });

  it('fix loop succeeds on second attempt after first re-audit fails', async () => {
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
          // Initial audit: fails
          const text = '**Concern 1: Missing validation**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 2) {
          // First fix agent
          const text = 'Attempted fix.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 3) {
          // First re-audit: still fails
          const text = '**Concern 1: Still broken**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 4) {
          // Second fix agent
          const text = 'Fixed properly this time.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Second re-audit: passes
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
    expect(callCount).toBe(5); // audit + fix1 + re-audit1 + fix2 + re-audit2
    // Both progress messages emitted with correct attempt counters
    expect(progressMsgs.some(m => m.includes('attempting fix (1/2)'))).toBe(true);
    expect(progressMsgs.some(m => m.includes('attempting fix (2/2)'))).toBe(true);
  });

  it('fix agent does not receive Bash tool', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    const capturedTools: string[][] = [];
    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params: any) {
        callCount++;
        // Capture tools from the params passed to invoke
        if (params?.tools) capturedTools.push([...params.tools]);
        if (callCount === 1) {
          // Audit: fails
          const text = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 2) {
          // Fix agent
          const text = 'Fixed.';
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
      maxAuditFixAttempts: 1,
    };

    await runNextPhase(phasesPath, planPath, opts, onProgress);
    // The fix agent call is the second invocation (callCount === 2)
    // Check that capturedTools has at least 2 entries and the second one has no Bash
    expect(capturedTools.length).toBeGreaterThanOrEqual(2);
    const fixAgentTools = capturedTools[1]!;
    expect(fixAgentTools).not.toContain('Bash');
    expect(fixAgentTools).toContain('Read');
    expect(fixAgentTools).toContain('Write');
    expect(fixAgentTools).toContain('Edit');
    expect(fixAgentTools).toContain('Glob');
    expect(fixAgentTools).toContain('Grep');
  });

  it('re-audit runtime error consumes attempt and triggers rollback', async () => {
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
          // Initial audit: fails
          const text = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else if (callCount === 2) {
          // Fix agent: succeeds
          const text = 'Fixed the issues.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Re-audit: runtime error
          yield { type: 'error', message: 'Model timeout' };
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
      maxAuditFixAttempts: 1,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    // Re-audit runtime error should be normalized to audit_failed after fix loop exhaustion
    expect(result.result).toBe('audit_failed');
    expect(progressMsgs.some(m => m.includes('rolled back'))).toBe(true);
  });

  it('rollback failure does not throw — returns audit_failed with warning', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    // RuntimeAdapter: audit HIGH → fix agent (corrupts git) → re-audit HIGH → rollback fails
    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke() {
        callCount++;
        if (callCount === 2) {
          // Fix agent: corrupt the git repo so rollback will fail
          // Rename .git to break git commands
          fsSync.renameSync(path.join(projectDir, '.git'), path.join(projectDir, '.git-broken'));
          const text = 'Attempted fix.';
          yield { type: 'text_delta', text };
          yield { type: 'text_final', text };
        } else {
          // Audit calls: always fail
          const text = '**Concern 1: Still broken**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
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
      maxAuditFixAttempts: 1,
    };

    const result = await runNextPhase(phasesPath, planPath, opts, onProgress);
    // Should return audit_failed, not throw
    expect(result.result).toBe('audit_failed');
    // Should have emitted a rollback failed warning
    expect(progressMsgs.some(m => m.includes('rollback failed'))).toBe(true);
    // fixAttemptsUsed should be set
    if (result.result === 'audit_failed') {
      expect(result.fixAttemptsUsed).toBe(1);
    }

    // Restore .git for cleanup
    if (fsSync.existsSync(path.join(projectDir, '.git-broken'))) {
      fsSync.renameSync(path.join(projectDir, '.git-broken'), path.join(projectDir, '.git'));
    }
  });

  it('fixAttemptsUsed is undefined when fix loop is skipped (maxAuditFixAttempts=0)', async () => {
    const planPath = path.join(plansDir, 'plan-011-test.md');
    await fs.writeFile(planPath, SAMPLE_PLAN);
    const phasesPath = path.join(plansDir, 'plan-011-phases.md');
    writeAuditPhases(phasesPath);

    const auditOutput = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';

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
    if (result.result === 'audit_failed') {
      expect(result.fixAttemptsUsed).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// extractObjective
// ---------------------------------------------------------------------------

describe('extractObjective', () => {
  it('extracts objective section from plan content', () => {
    const result = extractObjective(SAMPLE_PLAN);
    expect(result).toBe('Add a plan manager that decomposes complex plans into phases.');
  });

  it('returns fallback for missing objective', () => {
    const result = extractObjective('# Plan\n\n## Changes\n\nSome changes.');
    expect(result).toBe('(no objective found in plan)');
  });

  it('returns fallback for empty string', () => {
    const result = extractObjective('');
    expect(result).toBe('(no objective found in plan)');
  });
});

// ---------------------------------------------------------------------------
// buildPostRunSummary
// ---------------------------------------------------------------------------

function makePhasesForSummary(overrides: Partial<PlanPhases> = {}): PlanPhases {
  return {
    planId: 'plan-011',
    planFile: 'plans/plan-011.md',
    planContentHash: 'abc123',
    createdAt: '2026-02-17',
    updatedAt: '2026-02-17',
    phases: [],
    ...overrides,
  };
}

describe('buildPostRunSummary', () => {
  it('returns empty string when there are no phases', () => {
    const phases = makePhasesForSummary({ phases: [] });
    expect(buildPostRunSummary(phases)).toBe('');
  });

  it('shows [x] indicator for done phase', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('[x]');
    expect(summary).toContain('phase-1');
    expect(summary).toContain('Implement foo');
  });

  it('shows [!] indicator for failed phase', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'failed',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    expect(buildPostRunSummary(phases)).toContain('[!]');
  });

  it('shows [-] indicator for skipped phase', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Read plan', kind: 'read', status: 'skipped',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    expect(buildPostRunSummary(phases)).toContain('[-]');
  });

  it('shows [~] indicator for in-progress phase', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'in-progress',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    expect(buildPostRunSummary(phases)).toContain('[~]');
  });

  it('shows [ ] indicator for pending phase', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'pending',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    expect(buildPostRunSummary(phases)).toContain('[ ]');
  });

  it('includes git commit hash when present', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          gitCommit: 'a1b2c3d',
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('a1b2c3d');
  });

  it('includes modified file count when present', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          modifiedFiles: ['src/foo.ts', 'src/bar.ts'],
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('2 files');
  });

  it('uses singular "file" for 1 modified file', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          modifiedFiles: ['src/foo.ts'],
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('1 file');
    expect(summary).not.toContain('1 files');
  });

  it('includes audit verdict from output', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-2', title: 'Post-implementation audit', kind: 'audit', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          output: 'No concerns found.\n\n**Verdict:** Ready to approve.',
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('Ready to approve.');
  });

  it('does not add verdict line if audit output has no Verdict marker', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-2', title: 'Post-implementation audit', kind: 'audit', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          output: 'Looks good.',
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).not.toContain(' — ');
  });

  it('includes Files changed rollup with unique files across phases', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          modifiedFiles: ['src/foo.ts', 'src/bar.ts'],
        },
        {
          id: 'phase-2', title: 'Implement baz', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          modifiedFiles: ['src/baz.ts', 'src/bar.ts'], // bar.ts is a duplicate
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('Files changed (3)');
    expect(summary).toContain('`src/foo.ts`');
    expect(summary).toContain('`src/bar.ts`');
    expect(summary).toContain('`src/baz.ts`');
    // bar.ts should appear only once
    expect(summary.split('`src/bar.ts`').length - 1).toBe(1);
  });

  it('omits Files changed section when no phases have modifiedFiles', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Read plan', kind: 'read', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).not.toContain('Files changed');
  });

  it('truncates files list with overflow count when budget is exceeded', () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => `src/module-${i}/long-filename-${i}.ts`);
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Big impl', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          modifiedFiles: manyFiles,
        },
      ],
    });
    const summary = buildPostRunSummary(phases, 200);
    expect(summary).toContain('more)');
  });

  it('handles multiple phases with mixed statuses', () => {
    const phases = makePhasesForSummary({
      phases: [
        {
          id: 'phase-1', title: 'Implement foo', kind: 'implement', status: 'done',
          description: '', dependsOn: [], contextFiles: [],
          gitCommit: 'abc1234', modifiedFiles: ['src/foo.ts'],
        },
        {
          id: 'phase-2', title: 'Implement bar', kind: 'implement', status: 'failed',
          description: '', dependsOn: [], contextFiles: [],
        },
        {
          id: 'phase-3', title: 'Post-implementation audit', kind: 'audit', status: 'skipped',
          description: '', dependsOn: [], contextFiles: [],
        },
      ],
    });
    const summary = buildPostRunSummary(phases);
    expect(summary).toContain('[x]');
    expect(summary).toContain('[!]');
    expect(summary).toContain('[-]');
    expect(summary).toContain('abc1234');
  });
});
