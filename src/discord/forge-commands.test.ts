import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseForgeCommand,
  parseAuditVerdict,
  buildDrafterPrompt,
  buildAuditorPrompt,
  buildRevisionPrompt,
  buildPlanSummary,
  appendAuditRound,
  ForgeOrchestrator,
} from './forge-commands.js';
import type { ForgeOrchestratorOpts } from './forge-commands.js';
import type { RuntimeAdapter, EngineEvent, RuntimeInvokeParams } from '../runtime/types.js';

// Mock the bd-cli module so we don't shell out to the real CLI.
vi.mock('../beads/bd-cli.js', () => ({
  bdCreate: vi.fn(async () => ({ id: 'ws-test-001', title: 'test', status: 'open' })),
  bdClose: vi.fn(async () => {}),
  bdUpdate: vi.fn(async () => {}),
  bdAddLabel: vi.fn(async () => {}),
}));

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
}

function makeMockRuntime(responses: string[]): RuntimeAdapter {
  let callIndex = 0;
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      const text = responses[callIndex] ?? '(no response)';
      callIndex++;
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
      })();
    },
  };
}

function makeMockRuntimeWithError(errorOnCall: number, responses: string[]): RuntimeAdapter {
  let callIndex = 0;
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      const idx = callIndex++;
      if (idx === errorOnCall) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'error', message: 'Runtime crashed' };
        })();
      }
      const text = responses[idx] ?? '(no response)';
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
      })();
    },
  };
}

async function baseOpts(
  tmpDir: string,
  runtime: RuntimeAdapter,
  overrides: Partial<ForgeOrchestratorOpts> = {},
): Promise<ForgeOrchestratorOpts> {
  const plansDir = path.join(tmpDir, 'plans');
  await fs.mkdir(plansDir, { recursive: true });
  // Write a minimal template
  await fs.writeFile(
    path.join(plansDir, '.plan-template.md'),
    `# Plan: {{TITLE}}\n\n**ID:** {{PLAN_ID}}\n**Bead:** {{BEAD_ID}}\n**Created:** {{DATE}}\n**Status:** DRAFT\n**Project:** {{PROJECT}}\n\n---\n\n## Objective\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`,
  );
  return {
    runtime,
    model: 'test-model',
    cwd: tmpDir,
    workspaceCwd: tmpDir,
    beadsCwd: tmpDir,
    plansDir,
    maxAuditRounds: 5,
    progressThrottleMs: 0,
    timeoutMs: 30000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseForgeCommand
// ---------------------------------------------------------------------------

describe('parseForgeCommand', () => {
  it('returns null for non-forge messages', () => {
    expect(parseForgeCommand('hello world')).toBeNull();
    expect(parseForgeCommand('!plan create something')).toBeNull();
    expect(parseForgeCommand('!memory show')).toBeNull();
    expect(parseForgeCommand('')).toBeNull();
  });

  it('returns null for !forging or !forger (prefix collision)', () => {
    expect(parseForgeCommand('!forging something')).toBeNull();
    expect(parseForgeCommand('!forger')).toBeNull();
  });

  it('!forge with no args returns help', () => {
    expect(parseForgeCommand('!forge')).toEqual({ action: 'help', args: '' });
  });

  it('!forge with extra whitespace returns help', () => {
    expect(parseForgeCommand('  !forge  ')).toEqual({ action: 'help', args: '' });
  });

  it('parses create from description text', () => {
    expect(parseForgeCommand('!forge build a webhook retry system')).toEqual({
      action: 'create',
      args: 'build a webhook retry system',
    });
  });

  it('parses status as reserved subcommand', () => {
    expect(parseForgeCommand('!forge status')).toEqual({ action: 'status', args: '' });
  });

  it('parses cancel as reserved subcommand', () => {
    expect(parseForgeCommand('!forge cancel')).toEqual({ action: 'cancel', args: '' });
  });

  it('parses help explicitly', () => {
    expect(parseForgeCommand('!forge help')).toEqual({ action: 'help', args: '' });
  });

  it('parses audit as reserved subcommand with plan-id arg', () => {
    expect(parseForgeCommand('!forge audit plan-027')).toEqual({
      action: 'audit',
      args: 'plan-027',
    });
  });

  it('parses audit with no args', () => {
    expect(parseForgeCommand('!forge audit')).toEqual({ action: 'audit', args: '' });
  });

  it('treats unknown first word as create description', () => {
    expect(parseForgeCommand('!forge add rate limiting')).toEqual({
      action: 'create',
      args: 'add rate limiting',
    });
  });
});

// ---------------------------------------------------------------------------
// parseAuditVerdict
// ---------------------------------------------------------------------------

describe('parseAuditVerdict', () => {
  it('text containing "Severity: high" -> high, shouldLoop', () => {
    const text = '**Concern 1: Missing error handling**\n**Severity: high**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'high', shouldLoop: true });
  });

  it('text containing "Severity: medium" -> medium, shouldLoop', () => {
    const text = '**Concern 1: Unclear scope**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: true });
  });

  it('text containing only "Severity: low" -> low, no loop', () => {
    const text = '**Concern 1: Minor naming**\n**Severity: low**\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'low', shouldLoop: false });
  });

  it('"Ready to approve" with no severity markers -> low, no loop', () => {
    const text = 'No concerns found.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'low', shouldLoop: false });
  });

  it('empty text -> none, no loop', () => {
    expect(parseAuditVerdict('')).toEqual({ maxSeverity: 'none', shouldLoop: false });
  });

  it('whitespace-only text -> none, no loop', () => {
    expect(parseAuditVerdict('   \n  ')).toEqual({ maxSeverity: 'none', shouldLoop: false });
  });

  it('malformed text with no markers -> none, no loop', () => {
    expect(parseAuditVerdict('This plan looks interesting.')).toEqual({
      maxSeverity: 'none',
      shouldLoop: false,
    });
  });

  it('high takes precedence over medium', () => {
    const text = '**Severity: medium**\n**Severity: high**\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'high', shouldLoop: true });
  });
});

// ---------------------------------------------------------------------------
// buildDrafterPrompt / buildAuditorPrompt / buildRevisionPrompt
// ---------------------------------------------------------------------------

describe('buildDrafterPrompt', () => {
  it('includes description, template, and context', () => {
    const prompt = buildDrafterPrompt('Add rate limiting', '## Template', 'Some context');
    expect(prompt).toContain('Add rate limiting');
    expect(prompt).toContain('## Template');
    expect(prompt).toContain('Some context');
    expect(prompt).toContain('Read the codebase');
  });
});

describe('buildAuditorPrompt', () => {
  it('includes plan content and structured instructions', () => {
    const prompt = buildAuditorPrompt('# Plan: Test\n\n## Objective\nDo stuff.', 1);
    expect(prompt).toContain('# Plan: Test');
    expect(prompt).toContain('Severity: high | medium | low');
    expect(prompt).toContain('audit round 1');
  });

  it('includes project context when provided', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1, 'Single-user system. No concurrency guards.');
    expect(prompt).toContain('## Project Context');
    expect(prompt).toContain('Single-user system. No concurrency guards.');
    expect(prompt).toContain('Respect them when auditing');
  });

  it('omits project context section when not provided', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).not.toContain('## Project Context');
  });

  it('includes prior audit history instructions for round > 1', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 3);
    expect(prompt).toContain('Prior Audit History');
    expect(prompt).toContain('DO NOT re-raise concerns that were adequately resolved');
    expect(prompt).toContain('Focus on genuinely new issues');
  });

  it('omits prior audit history instructions for round 1', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).not.toContain('Prior Audit History');
    expect(prompt).not.toContain('DO NOT re-raise');
  });

  it('includes verification instructions for tool use', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('## Verification');
    expect(prompt).toContain('Read, Glob, and Grep tools');
    expect(prompt).toContain('Use them before raising concerns');
    expect(prompt).toContain('concern evaporates after checking the code');
  });
});

describe('buildRevisionPrompt', () => {
  it('includes plan, audit notes, and description', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad thing', 'Add feature');
    expect(prompt).toContain('# Plan: Test');
    expect(prompt).toContain('Concern 1: bad thing');
    expect(prompt).toContain('Add feature');
  });

  it('includes project context when provided', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature', 'Single-user system.');
    expect(prompt).toContain('## Project Context');
    expect(prompt).toContain('Single-user system.');
    expect(prompt).toContain('do not re-introduce complexity');
  });

  it('omits project context section when not provided', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).not.toContain('## Project Context');
  });

  it('includes instruction to preserve prior resolutions', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).toContain('Preserve resolutions from prior audit rounds');
  });
});

// ---------------------------------------------------------------------------
// buildPlanSummary
// ---------------------------------------------------------------------------

describe('buildPlanSummary', () => {
  it('extracts header, objective, scope, and files from plan content', () => {
    const plan = [
      '# Plan: Add rate limiting',
      '',
      '**ID:** plan-010',
      '**Bead:** ws-abc',
      '**Created:** 2026-02-12',
      '**Status:** REVIEW',
      '**Project:** discoclaw',
      '',
      '---',
      '',
      '## Objective',
      '',
      'Add rate limiting to the webhook handler.',
      '',
      '## Scope',
      '',
      '**In:**',
      '- Add per-IP rate limiter',
      '- Add 429 response handling',
      '',
      '**Out:**',
      '- No changes to auth flow',
      '',
      '## Changes',
      '',
      '### File-by-file breakdown',
      '',
      '#### `src/webhook/handler.ts`',
      '',
      'Add rate limiter middleware.',
      '',
      '#### `src/webhook/rate-limiter.ts`',
      '',
      'New rate limiter module.',
      '',
      '## Risks',
      '',
      '- None.',
    ].join('\n');

    const summary = buildPlanSummary(plan);
    expect(summary).toContain('**plan-010**');
    expect(summary).toContain('Add rate limiting');
    expect(summary).toContain('REVIEW');
    expect(summary).toContain('ws-abc');
    expect(summary).toContain('Add rate limiting to the webhook handler.');
    expect(summary).toContain('per-IP rate limiter');
    expect(summary).not.toContain('No changes to auth flow');
    expect(summary).toContain('`src/webhook/handler.ts`');
    expect(summary).toContain('`src/webhook/rate-limiter.ts`');
  });

  it('handles plan with no scope In/Out sections', () => {
    const plan = [
      '# Plan: Simple fix',
      '',
      '**ID:** plan-001',
      '**Bead:** ws-001',
      '**Created:** 2026-01-01',
      '**Status:** DRAFT',
      '**Project:** test',
      '',
      '## Objective',
      '',
      'Fix the bug.',
      '',
      '## Scope',
      '',
      'Just fix one file.',
      '',
      '## Changes',
      '',
      'No structured file changes.',
      '',
      '## Risks',
    ].join('\n');

    const summary = buildPlanSummary(plan);
    expect(summary).toContain('Fix the bug.');
    expect(summary).toContain('Just fix one file.');
  });

  it('returns (no objective) when objective section is empty', () => {
    const plan = [
      '# Plan: Empty',
      '',
      '**ID:** plan-002',
      '**Bead:** ws-002',
      '**Created:** 2026-01-01',
      '**Status:** DRAFT',
      '**Project:** test',
      '',
      '## Objective',
      '',
      '## Scope',
      '',
      '## Changes',
    ].join('\n');

    const summary = buildPlanSummary(plan);
    expect(summary).toContain('(no objective)');
  });
});

// ---------------------------------------------------------------------------
// appendAuditRound (standalone)
// ---------------------------------------------------------------------------

describe('appendAuditRound', () => {
  const basePlan = [
    '# Plan: Test',
    '',
    '## Audit Log',
    '',
    '---',
    '',
    '## Implementation Notes',
    '',
    '_Filled in during/after implementation._',
  ].join('\n');

  it('inserts audit section before Implementation Notes', () => {
    const verdict = { maxSeverity: 'low' as const, shouldLoop: false };
    const result = appendAuditRound(basePlan, 1, 'All good.', verdict);
    expect(result).toContain('### Review 1');
    expect(result).toContain('All good.');
    expect(result).toContain('**Status:** COMPLETE');
    // Implementation Notes should still be present and come after the audit
    const auditIdx = result.indexOf('### Review 1');
    const implIdx = result.indexOf('## Implementation Notes');
    expect(implIdx).toBeGreaterThan(auditIdx);
  });

  it('appends at end when no Implementation Notes section exists', () => {
    const plan = '# Plan: Test\n\n## Audit Log\n';
    const verdict = { maxSeverity: 'high' as const, shouldLoop: true };
    const result = appendAuditRound(plan, 2, 'Needs work.', verdict);
    expect(result).toContain('### Review 2');
    expect(result).toContain('Needs work.');
  });
});

// ---------------------------------------------------------------------------
// ForgeOrchestrator
// ---------------------------------------------------------------------------

describe('ForgeOrchestrator', () => {
  it('completes in 1 round when audit returns clean', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Concern 1: Minor naming**\n**Severity: low**\n\n**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.planId).toMatch(/^plan-001$/);
    expect(result.rounds).toBe(1);
    expect(result.reachedMaxRounds).toBe(false);
    expect(result.error).toBeUndefined();
    expect(progress.some((p) => p.includes('Draft complete'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
    expect(result.planSummary).toBeDefined();
    expect(result.planSummary).toContain('plan-001');
  });

  it('completes in 2 rounds when first audit has medium concerns', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditMedium = '**Concern 1: Missing details**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan; // Same structure, orchestrator handles merge
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft -> Audit (medium) -> Revise -> Audit (clean)
    const runtime = makeMockRuntime([draftPlan, auditMedium, revisedPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.rounds).toBe(2);
    expect(result.reachedMaxRounds).toBe(false);
    expect(progress.some((p) => p.includes('medium concerns'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('stops at max rounds when audit always returns high concerns', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditHigh = '**Concern 1: Fundamental flaw**\n**Severity: high**\n\n**Verdict:** Needs revision.';

    // 3 rounds max: draft, audit, revise, audit, revise, audit = 6 runtime calls
    const responses: string[] = [];
    for (let i = 0; i < 10; i++) {
      responses.push(i % 2 === 0 ? draftPlan : auditHigh);
    }
    const runtime = makeMockRuntime(responses);
    const opts = await baseOpts(tmpDir, runtime, { maxAuditRounds: 3 });
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.rounds).toBe(3);
    expect(result.reachedMaxRounds).toBe(true);
    expect(progress.some((p) => p.includes('Forge stopped after 3 audit rounds'))).toBe(true);
  });

  it('reports error when draft phase fails', async () => {
    const tmpDir = await makeTmpDir();
    const runtime = makeMockRuntimeWithError(0, []);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(progress.some((p) => p.includes('Forge failed'))).toBe(true);
  });

  it('reports error when audit phase fails but preserves draft', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    // Draft succeeds, audit errors
    const runtime = makeMockRuntimeWithError(1, [draftPlan]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(result.planId).toMatch(/^plan-001$/);
    expect(result.filePath).toBeTruthy();
    expect(progress.some((p) => p.includes('Partial plan saved'))).toBe(true);
  });

  it('progress callback receives round numbers in format "Audit round N/M"', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test', async (msg) => {
      progress.push(msg);
    });

    expect(progress.some((p) => /Audit round 1\/5/.test(p))).toBe(true);
  });

  it('terminal messages pass force: true', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const calls: Array<{ msg: string; force?: boolean }> = [];
    await orchestrator.run('Test', async (msg, optsArg) => {
      calls.push({ msg, force: optsArg?.force });
    });

    const terminalCall = calls.find((c) => c.msg.includes('Forge complete'));
    expect(terminalCall).toBeDefined();
    expect(terminalCall!.force).toBe(true);
  });

  it('isRunning reflects orchestrator state', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    expect(orchestrator.isRunning).toBe(false);
    const promise = orchestrator.run('Test', async () => {});
    // isRunning is true during execution
    expect(orchestrator.isRunning).toBe(true);
    await promise;
    expect(orchestrator.isRunning).toBe(false);
  });

  it('cancel stops the forge between phases', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditMedium = '**Concern 1: Issue**\n**Severity: medium**\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditMedium, revisedPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    // Cancel after the first audit
    const result = await orchestrator.run('Test', async (msg) => {
      progress.push(msg);
      if (msg.includes('medium concerns')) {
        orchestrator.requestCancel();
      }
    });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(result.rounds).toBeLessThanOrEqual(2);
  });

  it('concurrent forge throws error', async () => {
    const tmpDir = await makeTmpDir();
    // Use a runtime that returns slowly
    let resolveFirst: () => void;
    const firstCallDone = new Promise<void>((r) => { resolveFirst = r; });

    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          // First call blocks until we resolve
          await firstCallDone;
          yield { type: 'text_final', text: '# Plan: Test\n' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    // Start first forge (will block)
    const p1 = orchestrator.run('Test 1', async () => {});

    // Try starting second forge
    await expect(
      orchestrator.run('Test 2', async () => {}),
    ).rejects.toThrow('already running');

    // Cleanup: let the first one finish (it'll error, which is fine)
    resolveFirst!();
    await p1.catch(() => {});
  });

  it('includes .context/project.md in drafter and auditor prompts', async () => {
    const tmpDir = await makeTmpDir();

    // Create a .context/project.md in the cwd
    const contextDir = path.join(tmpDir, '.context');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(
      path.join(contextDir, 'project.md'),
      'Single-user system. No concurrency guards needed.',
    );

    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Capture the prompts sent to the runtime
    const prompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        prompts.push(params.prompt);
        const responses = [draftPlan, auditClean];
        const text = responses[prompts.length - 1] ?? '(no response)';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.run('Test', async () => {});

    // Drafter prompt (first call) should include project context
    expect(prompts[0]).toContain('Single-user system');
    // Auditor prompt (second call) should include project context
    expect(prompts[1]).toContain('Single-user system');
    expect(prompts[1]).toContain('Project Context');
  });

  it('includes .context/tools.md in drafter prompt but not auditor prompt', async () => {
    const tmpDir = await makeTmpDir();

    // Create a .context/tools.md in the cwd
    const contextDir = path.join(tmpDir, '.context');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(
      path.join(contextDir, 'tools.md'),
      'Browser escalation: WebFetch → Playwright → CDP',
    );

    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Capture the prompts sent to the runtime
    const prompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        prompts.push(params.prompt);
        const responses = [draftPlan, auditClean];
        const text = responses[prompts.length - 1] ?? '(no response)';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.run('Test', async () => {});

    // Drafter prompt (first call) should include tools context
    expect(prompts[0]).toContain('Browser escalation: WebFetch');
    expect(prompts[0]).toContain('tools.md (repo)');
    // Auditor prompt (second call) should NOT include tools context
    expect(prompts[1]).not.toContain('Browser escalation: WebFetch');
    expect(prompts[1]).not.toContain('tools.md (repo)');
  });

  it('passes read-only tools to auditor invoke call', async () => {
    const tmpDir = await makeTmpDir();

    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Capture invoke params for each call
    const invocations: Array<Record<string, unknown>> = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        invocations.push({ tools: params.tools, addDirs: params.addDirs });
        const responses = [draftPlan, auditClean];
        const text = responses[invocations.length - 1] ?? '(no response)';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.run('Test', async () => {});

    // Drafter (first call) gets read-only tools
    expect(invocations[0]!.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(invocations[0]!.addDirs).toEqual([tmpDir]);

    // Auditor (second call) also gets read-only tools
    expect(invocations[1]!.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(invocations[1]!.addDirs).toEqual([tmpDir]);
  });

  it('updates bead title when drafter produces a different title than raw description', async () => {
    const { bdUpdate } = await import('../beads/bd-cli.js');
    const mockBdUpdate = vi.mocked(bdUpdate);
    mockBdUpdate.mockClear();

    const tmpDir = await makeTmpDir();
    // Drafter returns a clean title ("Add webhook retry logic") different from raw input
    const draftPlan = `# Plan: Add webhook retry logic\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nAdd retry logic.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    // Raw description differs from the drafter's clean title
    await orchestrator.run('a]plan to add webhook retry stuff', async () => {});

    expect(mockBdUpdate).toHaveBeenCalledWith(
      'ws-test-001',
      { title: 'Add webhook retry logic' },
      tmpDir,
    );
  });

  it('skips bead title update when drafter title matches description', async () => {
    const { bdUpdate } = await import('../beads/bd-cli.js');
    const mockBdUpdate = vi.mocked(bdUpdate);
    mockBdUpdate.mockClear();

    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild it.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    // Description matches the drafter's title exactly
    await orchestrator.run('Test feature', async () => {});

    expect(mockBdUpdate).not.toHaveBeenCalled();
  });

  it('passes existingBeadId through to handlePlanCommand (skips bdCreate)', async () => {
    const { bdCreate, bdAddLabel } = await import('../beads/bd-cli.js');
    const mockBdCreate = vi.mocked(bdCreate);
    const mockBdAddLabel = vi.mocked(bdAddLabel);
    mockBdCreate.mockClear();
    mockBdAddLabel.mockClear();

    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { existingBeadId: 'existing-bead-42' });
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.planId).toMatch(/^plan-001$/);
    expect(result.error).toBeUndefined();
    // bdCreate should NOT have been called — reusing existing bead
    expect(mockBdCreate).not.toHaveBeenCalled();
    // bdAddLabel should have been called to add the 'plan' label
    expect(mockBdAddLabel).toHaveBeenCalledWith('existing-bead-42', 'plan', expect.any(String));

    // Verify the plan file contains the existing bead ID
    const plansDir = path.join(tmpDir, 'plans');
    const entries = await fs.readdir(plansDir);
    const planFile = entries.find((e) => e.startsWith('plan-001') && e.endsWith('.md') && !e.includes('template'));
    expect(planFile).toBeTruthy();
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('**Bead:** existing-bead-42');
  });
});

// ---------------------------------------------------------------------------
// ForgeOrchestrator.resume()
// ---------------------------------------------------------------------------

function makePlanContent(overrides: { status?: string; title?: string; planId?: string; reviews?: number; includeChanges?: boolean } = {}): string {
  const status = overrides.status ?? 'REVIEW';
  const title = overrides.title ?? 'Test Plan';
  const planId = overrides.planId ?? 'plan-001';
  const includeChanges = overrides.includeChanges ?? true;
  const reviews = overrides.reviews ?? 0;

  const lines = [
    `# Plan: ${title}`,
    '',
    `**ID:** ${planId}`,
    `**Bead:** ws-test-001`,
    `**Created:** 2026-01-01`,
    `**Status:** ${status}`,
    `**Project:** discoclaw`,
    '',
    '---',
    '',
    '## Objective',
    '',
    'Build the test feature with proper error handling.',
    '',
    '## Scope',
    '',
    'In scope: everything related to testing.',
    '',
    '## Changes',
    '',
    ...(includeChanges
      ? ['### File-by-file breakdown', '', '#### `src/foo.ts`', '', 'Add bar function.', '']
      : ['']),
    '## Risks',
    '',
    '- Low risk of breaking existing tests.',
    '',
    '## Testing',
    '',
    '- Unit tests for the new feature.',
    '',
    '---',
    '',
    '## Audit Log',
    '',
  ];

  for (let i = 1; i <= reviews; i++) {
    lines.push(`### Review ${i} — 2026-01-01`);
    lines.push('**Status:** COMPLETE');
    lines.push('');
    lines.push(`Audit round ${i} notes.`);
    lines.push('');
  }

  lines.push('---', '', '## Implementation Notes', '', '_Filled in during/after implementation._', '');
  return lines.join('\n');
}

describe('ForgeOrchestrator.resume()', () => {
  it('loads existing plan and runs audit loop (skipping draft)', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([
      // Only audit output — no draft call
      '**Verdict:** Ready to approve.',
    ]));

    // Write plan file directly
    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async (msg) => {
      progress.push(msg);
    });

    expect(result.planId).toBe('plan-001');
    expect(result.rounds).toBe(1);
    expect(result.reachedMaxRounds).toBe(false);
    expect(result.error).toBeUndefined();
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
    // Should NOT contain draft-phase progress
    expect(progress.some((p) => p.includes('Drafting'))).toBe(false);
  });

  it('handles audit-then-revise loop', async () => {
    const tmpDir = await makeTmpDir();
    const auditMedium = '**Concern 1: Issue**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    const revisedPlan = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const auditClean = '**Verdict:** Ready to approve.';

    const opts = await baseOpts(tmpDir, makeMockRuntime([
      auditMedium,  // first audit
      revisedPlan,  // revision
      auditClean,   // second audit
    ]));

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    expect(result.rounds).toBe(2);
    expect(result.reachedMaxRounds).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('respects cancel', async () => {
    const tmpDir = await makeTmpDir();
    const auditMedium = '**Concern 1: Issue**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    const revisedPlan = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const auditClean = '**Verdict:** Ready to approve.';

    const opts = await baseOpts(tmpDir, makeMockRuntime([auditMedium, revisedPlan, auditClean]));

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async (msg) => {
      if (msg.includes('medium concerns')) {
        orchestrator.requestCancel();
      }
    });

    expect(result.finalVerdict).toBe('CANCELLED');
  });

  it('rejects IMPLEMENTING plans', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([]));

    const planContent = makePlanContent({ planId: 'plan-001', status: 'IMPLEMENTING' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    expect(result.error).toBeDefined();
    expect(result.error).toContain('currently being implemented');
  });

  it('rejects APPROVED plans', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([]));

    const planContent = makePlanContent({ planId: 'plan-001', status: 'APPROVED' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    expect(result.error).toBeDefined();
    expect(result.error).toContain('approved');
    expect(result.error).toContain('downgrade');
  });

  it('uses correct round numbers when plan has existing reviews', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([
      '**Verdict:** Ready to approve.',
    ]));

    // Plan already has Review 1 and Review 2
    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW', reviews: 2 });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    // Read the plan file and verify the new review is Review 3
    const updatedContent = await fs.readFile(filePath, 'utf-8');
    expect(updatedContent).toContain('### Review 3');
  });

  it('rejects plans with missing required sections', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([]));

    // Plan missing Changes and Testing sections
    const planContent = [
      '# Plan: Incomplete Plan',
      '',
      '**ID:** plan-001',
      '**Bead:** ws-test-001',
      '**Created:** 2026-01-01',
      '**Status:** REVIEW',
      '**Project:** discoclaw',
      '',
      '---',
      '',
      '## Objective',
      '',
      'Build the test feature with proper error handling.',
      '',
      '## Scope',
      '',
      'In scope: everything.',
      '',
      '## Risks',
      '',
      '- None.',
      '',
      '---',
      '',
      '## Audit Log',
      '',
      '---',
      '',
      '## Implementation Notes',
      '',
      '_Filled in during/after implementation._',
    ].join('\n');
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const result = await orchestrator.resume('plan-001', filePath, 'Incomplete Plan', async () => {});

    expect(result.error).toBeDefined();
    expect(result.error).toContain('structural issues');
    expect(result.error).toContain('Changes');
    expect(result.error).toContain('Testing');
  });
});

// ---------------------------------------------------------------------------
// Forge session key tests
// ---------------------------------------------------------------------------

function makeCaptureRuntime(responses: string[]): {
  runtime: RuntimeAdapter;
  invocations: RuntimeInvokeParams[];
} {
  let callIndex = 0;
  const invocations: RuntimeInvokeParams[] = [];
  const runtime: RuntimeAdapter = {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(params) {
      invocations.push(params);
      const text = responses[callIndex] ?? '(no response)';
      callIndex++;
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
      })();
    },
  };
  return { runtime, invocations };
}

describe('Forge session keys', () => {
  it('passes distinct sessionKey for drafter and auditor calls', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // Draft call (index 0) should have drafter session key
    expect(invocations[0]!.sessionKey).toContain(':drafter');
    // Audit call (index 1) should have auditor session key
    expect(invocations[1]!.sessionKey).toContain(':auditor');
    // Keys must be different
    expect(invocations[0]!.sessionKey).not.toBe(invocations[1]!.sessionKey);
  });

  it('session key includes model to prevent mismatch', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, {
      drafterModel: 'opus',
      auditorModel: 'sonnet',
    });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(invocations[0]!.sessionKey).toContain('opus');
    expect(invocations[0]!.sessionKey).toContain(':drafter');
    expect(invocations[1]!.sessionKey).toContain('sonnet');
    expect(invocations[1]!.sessionKey).toContain(':auditor');
  });

  it('session key includes planId for uniqueness', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // planId is plan-001 (auto-generated by handlePlanCommand)
    expect(invocations[0]!.sessionKey).toContain('plan-001');
    expect(invocations[1]!.sessionKey).toContain('plan-001');
  });

  it('revision step reuses drafter session key', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** (system)\n**Bead:** (system)\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditMedium = '**Concern 1: Missing details**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan;
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft -> Audit (medium) -> Revise -> Audit (clean)
    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditMedium, revisedPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // Call 0: draft (drafter key)
    // Call 1: audit round 1 (auditor key)
    // Call 2: revision (drafter key — same as call 0)
    // Call 3: audit round 2 (auditor key — same as call 1)
    expect(invocations[2]!.sessionKey).toBe(invocations[0]!.sessionKey);
    expect(invocations[3]!.sessionKey).toBe(invocations[1]!.sessionKey);
  });

  it('resume() also gets session keys via auditLoop', async () => {
    const tmpDir = await makeTmpDir();

    const { runtime, invocations } = makeCaptureRuntime([
      '**Verdict:** Ready to approve.',
    ]);
    const opts = await baseOpts(tmpDir, runtime);

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    // The audit call should have a session key
    expect(invocations[0]!.sessionKey).toContain(':auditor');
    expect(invocations[0]!.sessionKey).toContain('plan-001');
  });
});
