import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { handlePlanAudit, auditPlanStructure, maxReviewNumber } from './audit-handler.js';
import type { PlanAuditOpts } from './audit-handler.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'audit-handler-test-'));
}

function makeMockRuntime(response: string): RuntimeAdapter {
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text: response };
      })();
    },
  };
}

function makeMockRuntimeError(message: string): RuntimeAdapter {
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'error', message };
      })();
    },
  };
}

const MINIMAL_PLAN = `# Plan: Test plan

**ID:** plan-099
**Bead:** workspace-test
**Created:** 2026-02-13
**Status:** APPROVED
**Project:** discoclaw

---

## Objective

Add a widget to the thing.

## Scope

**In:**
- Add the widget module
- Write tests

**Out:**
- Changing existing widgets

## Changes

### File-by-file breakdown

- \`src/widget.ts\` — New file containing the widget implementation.
- \`src/widget.test.ts\` — Tests for the widget.

### New files
- \`src/widget.ts\`
- \`src/widget.test.ts\`

### Deleted files
_(none)_

## Risks

- Widget might conflict with existing gizmo module.

## Testing

- Unit tests for widget creation, deletion, and update.
- Integration test with the gizmo module.

## Dependencies

_(none)_

---

## Audit Log

---

## Implementation Notes

_Filled in during/after implementation._
`;

function makeLockFn(): { fn: () => Promise<() => void>; released: boolean } {
  const state = { released: false };
  const fn = async () => {
    return () => { state.released = true; };
  };
  return { fn, get released() { return state.released; } };
}

async function writeTestPlan(plansDir: string, content: string = MINIMAL_PLAN): Promise<string> {
  await fs.mkdir(plansDir, { recursive: true });
  const filePath = path.join(plansDir, 'plan-099-test-plan.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

function baseOpts(plansDir: string, runtime: RuntimeAdapter, lock: { fn: () => Promise<() => void> }, workspaceCwd: string): PlanAuditOpts {
  return {
    planId: 'plan-099',
    plansDir,
    workspaceCwd,
    runtime,
    auditorModel: 'test-model',
    timeoutMs: 30_000,
    acquireWriterLock: lock.fn,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: auditPlanStructure
// ---------------------------------------------------------------------------

describe('auditPlanStructure', () => {
  it('returns no concerns for a complete plan', () => {
    const concerns = auditPlanStructure(MINIMAL_PLAN);
    expect(concerns).toEqual([]);
  });

  it('flags missing required sections', () => {
    const content = `# Plan: Test\n\n## Objective\n\nDo the thing.\n\n## Scope\n\n**In:** stuff\n\n---\n\n## Audit Log\n`;
    const concerns = auditPlanStructure(content);
    const titles = concerns.map((c) => c.title);
    expect(titles).toContain('Missing section: Changes');
    expect(titles).toContain('Missing section: Risks');
    expect(titles).toContain('Missing section: Testing');
  });

  it('flags placeholder sections', () => {
    const content = MINIMAL_PLAN.replace(
      '## Risks\n\n- Widget might conflict with existing gizmo module.',
      '## Risks\n\n_(TBD)_',
    );
    const concerns = auditPlanStructure(content);
    expect(concerns.some((c) => c.title === 'Empty or placeholder: Risks')).toBe(true);
  });

  it('flags Changes section without file paths', () => {
    const content = MINIMAL_PLAN.replace(
      /## Changes[\s\S]*?## Risks/m,
      '## Changes\n\nWe will make some changes to the codebase to improve things significantly.\n\n## Risks',
    );
    const concerns = auditPlanStructure(content);
    expect(concerns.some((c) => c.title === 'Changes section lacks file paths')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: maxReviewNumber
// ---------------------------------------------------------------------------

describe('maxReviewNumber', () => {
  it('returns 0 when no reviews exist', () => {
    expect(maxReviewNumber(MINIMAL_PLAN)).toBe(0);
  });

  it('returns the max review number', () => {
    const content = MINIMAL_PLAN.replace(
      '## Audit Log\n',
      '## Audit Log\n\n### Review 1 — 2026-02-13\nStuff\n\n### Review 3 — 2026-02-13\nMore stuff\n',
    );
    expect(maxReviewNumber(content)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: handlePlanAudit
// ---------------------------------------------------------------------------

describe('handlePlanAudit', () => {
  let tmpDir: string;
  let plansDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    plansDir = path.join(tmpDir, 'plans');
  });

  it('happy path: structural passes, AI audit appends review', async () => {
    await writeTestPlan(plansDir);
    const runtime = makeMockRuntime('No concerns found.\n\n**Verdict:** Ready to approve.');
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.round).toBe(1);
      // parseAuditVerdict returns 'minor' for "ready to approve" with no severity markers
      expect(result.verdict.maxSeverity).toBe('minor');
      expect(result.verdict.shouldLoop).toBe(false);
    }

    // Verify the plan file was updated
    const updated = await fs.readFile(path.join(plansDir, 'plan-099-test-plan.md'), 'utf-8');
    expect(updated).toContain('### Review 1');
    expect(lock.released).toBe(true);
  });

  it('plan not found', async () => {
    await fs.mkdir(plansDir, { recursive: true });
    const runtime = makeMockRuntime('unused');
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Plan not found');
    }
  });

  it('missing Audit Log section', async () => {
    const noAuditLog = MINIMAL_PLAN.replace('## Audit Log\n', '');
    await writeTestPlan(plansDir, noAuditLog);
    const runtime = makeMockRuntime('unused');
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Audit Log');
    }
  });

  it('structural gate stops on high severity — no AI call', async () => {
    // Plan missing Changes, Risks, Testing sections
    const badPlan = `# Plan: Bad plan

**ID:** plan-099
**Bead:** workspace-test
**Created:** 2026-02-13
**Status:** DRAFT
**Project:** discoclaw

---

## Objective

Do something.

## Scope

**In:** stuff

---

## Audit Log

---

## Implementation Notes

_Filled in during/after implementation._
`;
    await writeTestPlan(plansDir, badPlan);
    const invokespy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke: invokespy as any,
    };
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.maxSeverity).toBe('blocking');
      expect(result.verdict.shouldLoop).toBe(true);
    }
    // AI agent should NOT have been called
    expect(invokespy).not.toHaveBeenCalled();
    expect(lock.released).toBe(true);
  });

  it('AI agent failure returns error without writing', async () => {
    await writeTestPlan(plansDir);
    const runtime = makeMockRuntimeError('Model overloaded');
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Auditor agent failed');
    }

    // Plan file should be untouched
    const content = await fs.readFile(path.join(plansDir, 'plan-099-test-plan.md'), 'utf-8');
    expect(content).not.toContain('### Review');
  });

  it('round numbering with existing reviews', async () => {
    const withReviews = MINIMAL_PLAN.replace(
      '## Audit Log\n',
      '## Audit Log\n\n### Review 1 — 2026-02-13\n**Status:** COMPLETE\nStuff\n\n### Review 2 — 2026-02-13\n**Status:** COMPLETE\nMore stuff\n',
    );
    await writeTestPlan(plansDir, withReviews);
    const runtime = makeMockRuntime('No concerns.\n\n**Verdict:** Ready to approve.');
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.round).toBe(3);
    }
  });

  it('lock released even on write failure', async () => {
    await writeTestPlan(plansDir);
    const runtime = makeMockRuntime('No concerns.\n\n**Verdict:** Ready to approve.');
    const lock = makeLockFn();

    // Make the plans directory read-only so the .tmp file creation fails.
    // chmod on the file alone won't work — rename(2) only needs directory
    // write permission, not file write permission.
    await fs.chmod(plansDir, 0o555);

    // handlePlanAudit will throw from the write phase (EACCES on .tmp creation),
    // but the try/finally must still release the lock.
    await expect(handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir))).rejects.toThrow();
    expect(lock.released).toBe(true);

    // Plan file should be unchanged (write never completed)
    await fs.chmod(plansDir, 0o755);
    const content = await fs.readFile(path.join(plansDir, 'plan-099-test-plan.md'), 'utf-8');
    expect(content).not.toContain('### Review');
  });

  it('tools_fs runtime receives tools and addDirs', async () => {
    await writeTestPlan(plansDir);
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text', 'tools_fs'] as const),
      invoke(params) {
        invokeSpy(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: 'No concerns.\n\n**Verdict:** Ready to approve.' };
        })();
      },
    };
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(true);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const params = invokeSpy.mock.calls[0][0];
    // Should receive the read-only tool list
    expect(params.tools).toEqual(['Read', 'Glob', 'Grep']);
    // Should receive addDirs containing the workspace cwd
    expect(params.addDirs).toEqual([tmpDir]);
  });

  it('non-tools_fs runtime receives no tools or addDirs', async () => {
    await writeTestPlan(plansDir);
    const invokeSpy = vi.fn();
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text'] as const),
      invoke(params) {
        invokeSpy(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: 'No concerns.\n\n**Verdict:** Ready to approve.' };
        })();
      },
    };
    const lock = makeLockFn();
    const result = await handlePlanAudit(baseOpts(plansDir, runtime, lock, tmpDir));

    expect(result.ok).toBe(true);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const params = invokeSpy.mock.calls[0][0];
    // Should receive empty tools
    expect(params.tools).toEqual([]);
    // addDirs should be undefined (collectRuntimeText converts [] to undefined)
    expect(params.addDirs).toBeUndefined();
  });

  it('empty plan ID', async () => {
    await fs.mkdir(plansDir, { recursive: true });
    const runtime = makeMockRuntime('unused');
    const lock = makeLockFn();
    const opts = baseOpts(plansDir, runtime, lock, tmpDir);
    opts.planId = '';
    const result = await handlePlanAudit(opts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });
});
