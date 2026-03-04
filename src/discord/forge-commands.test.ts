import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseForgeCommand,
  parseAuditVerdict,
  isRetryableError,
  buildDrafterPrompt,
  buildAuditorPrompt,
  buildRevisionPrompt,
  buildPlanSummary,
  appendAuditRound,
  stripTemplateHeader,
  isTemplateEchoed,
  resolveForgeDescription,
  ForgeOrchestrator,
} from './forge-commands.js';
import type { ForgeOrchestratorOpts } from './forge-commands.js';
import type { RuntimeAdapter, EngineEvent, RuntimeInvokeParams } from '../runtime/types.js';
import { TaskStore } from '../tasks/store.js';
import { ROOT_POLICY, TRACKED_DEFAULTS_PREAMBLE } from './prompt-common.js';

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
    `# Plan: {{TITLE}}\n\n**ID:** {{PLAN_ID}}\n**Task:** {{TASK_ID}}\n**Created:** {{DATE}}\n**Status:** DRAFT\n**Project:** {{PROJECT}}\n\n---\n\n## Objective\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`,
  );
  return {
    runtime,
    model: 'test-model',
    cwd: tmpDir,
    workspaceCwd: tmpDir,
    taskStore: new TaskStore({ prefix: 'ws' }),
    plansDir,
    maxAuditRounds: 5,
    progressThrottleMs: 0,
    timeoutMs: 30000,
    ...overrides,
  };
}

/**
 * Returns a runtime where each call index maps to either an error event or a
 * text response. `'error'` entries emit a runtime error; strings emit text.
 */
function makeRetryableRuntime(callMap: Array<string | 'error'>): RuntimeAdapter {
  let callIndex = 0;
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      const entry = callMap[callIndex] ?? 'error';
      callIndex++;
      if (entry === 'error') {
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'error', message: 'hang detected' };
        })();
      }
      const text = entry;
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
      })();
    },
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
  it('parses json verdict payload from fenced block', () => {
    const text = [
      '```json',
      '{"maxSeverity":"blocking","shouldLoop":true,"summary":"Critical issue","concerns":[{"title":"SQL injection","severity":"blocking"}]}',
      '```',
      '',
      '**Concern 1: SQL injection**',
      '**Severity: blocking**',
      '',
      '**Verdict:** Needs revision.',
    ].join('\n');
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('json verdict wins over contradictory prose verdict', () => {
    const text = [
      '```json',
      '{"maxSeverity":"medium","shouldLoop":false,"summary":"Non-blocking concerns"}',
      '```',
      '',
      '**Verdict:** Needs revision.',
    ].join('\n');
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('falls back to legacy parser when json is malformed', () => {
    const text = [
      '```json',
      '{"maxSeverity":"blocking","shouldLoop":true',
      '```',
      '',
      '**Severity: medium**',
      '**Verdict:** Needs revision.',
    ].join('\n');
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('ignores unrelated json objects and falls back to severity markers', () => {
    const text = [
      '```json',
      '{"note":"example payload"}',
      '```',
      '',
      '**Severity: blocking**',
      '**Verdict:** Needs revision.',
    ].join('\n');
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('supports high/low aliases in json payload', () => {
    const text = [
      '```json',
      '{"maxSeverity":"high","shouldLoop":true}',
      '```',
    ].join('\n');
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('text containing "Severity: blocking" -> blocking, shouldLoop', () => {
    const text = '**Concern 1: Missing error handling**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('text containing "Severity: medium" -> medium, no loop', () => {
    const text = '**Concern 1: Unclear scope**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('text containing "Severity: minor" -> minor, no loop', () => {
    const text = '**Concern 1: Minor naming**\n**Severity: minor**\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('text containing "Severity: suggestion" -> suggestion, no loop', () => {
    const text = '**Concern 1: Future idea**\n**Severity: suggestion**\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'suggestion', shouldLoop: false });
  });

  it('backward compat: "Severity: high" -> blocking, shouldLoop', () => {
    const text = '**Concern 1: Missing error handling**\n**Severity: high**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('backward compat: "Severity: HIGH" (uppercase) -> blocking, shouldLoop', () => {
    const text = '**Concern 1: Missing error handling**\n**Severity: HIGH**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('backward compat: "Severity: low" -> minor, no loop', () => {
    const text = '**Concern 1: Minor naming**\n**Severity: low**\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('"Ready to approve" with no severity markers -> minor, no loop', () => {
    const text = 'No concerns found.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
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

  it('blocking takes precedence over medium', () => {
    const text = '**Severity: medium**\n**Severity: blocking**\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('medium takes precedence over minor and suggestion', () => {
    const text = '**Severity: minor**\n**Severity: medium**\n**Severity: suggestion**\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('detects severity in markdown table rows (without fallback)', () => {
    const text = '| # | Concern | Severity |\n|---|---------|----------|\n| 1 | Missing tests | **medium** |\n| 2 | Minor naming | **minor** |\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('detects severity in table cells without bold formatting', () => {
    const text = '| Concern | Rating |\n|---|---|\n| Missing tests | medium |\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('detects blocking severity in table cells', () => {
    const text = '| Concern | Rating |\n|---|---|\n| SQL injection | blocking |\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('detects severity in table header column', () => {
    const text = '| Concern | Severity |\n|---|---|\n| Missing tests | Severity: medium |\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('severity markers win over contradictory verdict text', () => {
    const text = '| # | Concern | Severity |\n|---|---------|----------|\n| 1 | SQL injection | **blocking** |\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('backward compat: table with **high** maps to blocking', () => {
    const text = '| # | Concern | Severity |\n|---|---------|----------|\n| 1 | SQL injection | **high** |\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('falls back to "Needs revision" verdict when no severity markers present', () => {
    const text = 'Some concerns found.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('falls back to "Ready to approve" verdict when no severity markers present', () => {
    const text = 'Minor things but overall good.\n\nVerdict: Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('does not false-positive on "high" in prose without formatting', () => {
    const text = 'The code quality is high.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('does not false-positive on bold "high" in prose without severity marker', () => {
    const text = '**Concern 1: Throughput concerns**\nExpected load is **high** during peak windows.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('does not false-positive on "blocking" in prose without severity marker', () => {
    const text = '**Concern 1: I/O pattern**\nUses blocking I/O for file reads.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  // --- Legacy Concern N (severity) format tests ---

  it('legacy format: "Concern 1 (high)" with no Severity label -> blocking, shouldLoop', () => {
    const text = '**Concern 1 (high): Missing validation**\nDetails here.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('legacy format: "Concern 1 (medium)" with no Severity label -> medium, no loop', () => {
    const text = '**Concern 1 (medium): Edge case missing**\nDetails here.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('legacy format: "Concern 1 (low)" with no Severity label -> minor, no loop', () => {
    const text = '**Concern 1 (low): Naming issue**\nDetails here.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('legacy format: "Concern 1 (blocking)" with no Severity label -> blocking, shouldLoop', () => {
    const text = '**Concern 1 (blocking): Security flaw**\nDetails here.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('mixed format: "Severity: medium" + "Concern 2 (high)" -> blocking, shouldLoop', () => {
    const text = '**Concern 1: Issue A**\n**Severity: medium**\n\n**Concern 2 (high): Issue B**\nDetails.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('mixed format: "Severity: medium" + "Concern 2 (minor)" -> medium, no loop', () => {
    const text = '**Concern 1: Issue A**\n**Severity: medium**\n\n**Concern 2 (minor): Issue B**\nDetails.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('legacy format: "**Item count mismatch (medium):**" -> medium, no loop', () => {
    const text = '**Item count mismatch (medium):**\nExpected 5, got 3.\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  // --- Precedence tests: severity markers vs verdict text ---

  it('precedence: "Severity: medium" + "Needs revision" -> medium, no loop (severity markers win)', () => {
    const text = '**Concern 1: Issue**\n**Severity: medium**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });

  it('precedence: "Severity: blocking" + "Ready to approve" -> blocking, shouldLoop (severity markers win)', () => {
    const text = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'blocking', shouldLoop: true });
  });

  it('precedence: "Severity: minor" + "Needs revision" -> minor, no loop (severity markers win)', () => {
    const text = '**Concern 1: Issue**\n**Severity: minor**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'minor', shouldLoop: false });
  });

  it('precedence: "Severity: medium" + "Severity: minor" + "Needs revision" -> medium, no loop', () => {
    const text = '**Concern 1: Issue A**\n**Severity: medium**\n\n**Concern 2: Issue B**\n**Severity: minor**\n\n**Verdict:** Needs revision.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'medium', shouldLoop: false });
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  it('matches hang detected', () => {
    expect(isRetryableError('hang detected after 60s')).toBe(true);
  });

  it('matches stream stall', () => {
    expect(isRetryableError('stream stall: no output for 30s')).toBe(true);
  });

  it('matches progress stall', () => {
    expect(isRetryableError('progress stall detected')).toBe(true);
  });

  it('matches timed out', () => {
    expect(isRetryableError('operation timed out')).toBe(true);
  });

  it('matches process exited unexpectedly', () => {
    expect(isRetryableError('process exited unexpectedly with code 1')).toBe(true);
  });

  it('matches stdin write failed', () => {
    expect(isRetryableError('stdin write failed: broken pipe')).toBe(true);
  });

  it('matches drafter echoed the template', () => {
    expect(isRetryableError('drafter echoed the template')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRetryableError('HANG DETECTED')).toBe(true);
    expect(isRetryableError('Process Exited Unexpectedly')).toBe(true);
  });

  it('returns false for non-retryable errors', () => {
    expect(isRetryableError('Runtime crashed')).toBe(false);
    expect(isRetryableError('Plan has structural issues')).toBe(false);
    expect(isRetryableError('subprocess crashed')).toBe(false);
    expect(isRetryableError('invalid response format')).toBe(false);
    expect(isRetryableError('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDrafterPrompt / buildAuditorPrompt / buildRevisionPrompt
// ---------------------------------------------------------------------------

describe('stripTemplateHeader', () => {
  it('strips the header through the first --- and returns body sections', () => {
    const template = [
      '# Plan: {{TITLE}}',
      '',
      '**ID:** {{PLAN_ID}}',
      '**Status:** DRAFT',
      '**Project:** {{PROJECT}}',
      '',
      '---',
      '',
      '## Objective',
      '',
      '_Describe the objective here._',
      '',
      '## Changes',
      '',
      '_List file-by-file changes._',
    ].join('\n');
    const result = stripTemplateHeader(template);
    expect(result).toMatch(/^## Objective/);
    expect(result).not.toContain('# Plan:');
    expect(result).not.toContain('{{PLAN_ID}}');
    expect(result).toContain('## Changes');
  });

  it('returns full content unchanged when no header/separator is found', () => {
    const content = '## Objective\n\nDo something useful.\n\n## Changes\n\nEdit files.';
    expect(stripTemplateHeader(content)).toBe(content);
  });
});

describe('isTemplateEchoed', () => {
  it('returns true for output containing {{TITLE}} mustache tokens', () => {
    expect(isTemplateEchoed('# Plan: {{TITLE}}\n\n## Objective\nSomething.')).toBe(true);
  });

  it('returns true for output containing (system) in metadata lines', () => {
    expect(isTemplateEchoed('# Plan: My Plan\n\n**ID:** (system)\n\n## Objective\nSomething.')).toBe(true);
  });

  it('returns true for output containing FALLBACK_TEMPLATE placeholder phrases', () => {
    expect(isTemplateEchoed('## Objective\n\n_Describe the objective here._')).toBe(true);
    expect(isTemplateEchoed('## Scope\n\n_Define what\'s in and out of scope._')).toBe(true);
    expect(isTemplateEchoed('## Changes\n\n_List file-by-file changes._')).toBe(true);
  });

  it('returns false for a genuine draft with substantive content', () => {
    const realDraft = [
      '# Plan: Add Rate Limiting',
      '',
      '## Objective',
      '',
      'Implement token-bucket rate limiting on the /api/messages endpoint to prevent abuse.',
      '',
      '## Changes',
      '',
      '#### `src/middleware/rate-limit.ts`',
      '- New file implementing `TokenBucket` class with `consume()` method.',
    ].join('\n');
    expect(isTemplateEchoed(realDraft)).toBe(false);
  });

  it('returns true for output echoing real .plan-template.md phrases (2+ hits)', () => {
    const echoedTemplate = [
      '## Objective',
      '',
      'What we\'re doing and why.',
      '',
      '## Changes',
      '',
      '### File-by-file breakdown',
      '',
      '- `path/to/file.ts` — what changes and why',
      '- `path/to/other.ts` — what changes and why',
    ].join('\n');
    expect(isTemplateEchoed(echoedTemplate)).toBe(true);
  });

  it('returns true for output echoing current .plan-template.md examples (2+ hits)', () => {
    const echoedTemplate = [
      '## Changes',
      '',
      '### File-by-file breakdown',
      '',
      '- `src/discord/plan-commands.ts` — what changes and why',
      '- `src/discord/plan-manager.ts` — what changes and why',
    ].join('\n');
    expect(isTemplateEchoed(echoedTemplate)).toBe(true);
  });

  it('returns false for a single real template phrase (not enough signal)', () => {
    const singlePhrase = [
      '## Changes',
      '',
      '- `path/to/file.ts` — what changes and why',
      '- `src/discord/actions.ts` — add new action handler',
    ].join('\n');
    expect(isTemplateEchoed(singlePhrase)).toBe(false);
  });

  it('ignores mustache tokens inside fenced code blocks', () => {
    const output = [
      '## Objective',
      '',
      'Implement templating engine.',
      '',
      '```',
      'const t = "{{TITLE}}";',
      '```',
    ].join('\n');
    expect(isTemplateEchoed(output)).toBe(false);
  });
});

describe('resolveForgeDescription', () => {
  it('returns original description when not degenerate', () => {
    expect(resolveForgeDescription('Add rate limiting', undefined, undefined)).toBe('Add rate limiting');
  });

  it('substitutes task title for "this"', () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'Sanitize webhook body', priority: 1 });
    const task = store.list()[0]!;
    expect(resolveForgeDescription('this', store, task.id)).toBe('Sanitize webhook body');
  });

  it('substitutes task title for "that" (case-insensitive)', () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'Fix the bug', priority: 2 });
    const task = store.list()[0]!;
    expect(resolveForgeDescription('That', store, task.id)).toBe('Fix the bug');
  });

  it('substitutes task title for "it"', () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'Implement feature', priority: 2 });
    const task = store.list()[0]!;
    expect(resolveForgeDescription('it', store, task.id)).toBe('Implement feature');
  });

  it('returns original if no task store', () => {
    expect(resolveForgeDescription('this', undefined, 'ws-001')).toBe('this');
  });

  it('returns original if no existing task ID', () => {
    const store = new TaskStore({ prefix: 'ws' });
    expect(resolveForgeDescription('this', store, undefined)).toBe('this');
  });

  it('returns original if task not found in store', () => {
    const store = new TaskStore({ prefix: 'ws' });
    expect(resolveForgeDescription('this', store, 'ws-999')).toBe('this');
  });

  it('does not substitute for normal descriptions', () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'Some task', priority: 2 });
    const task = store.list()[0]!;
    expect(resolveForgeDescription('Add retry logic', store, task.id)).toBe('Add retry logic');
  });
});

describe('buildDrafterPrompt', () => {
  it('includes description, template body, context, and codebase-reading instruction', () => {
    const template = [
      '# Plan: {{TITLE}}',
      '',
      '**ID:** {{PLAN_ID}}',
      '**Project:** {{PROJECT}}',
      '',
      '---',
      '',
      '## Objective',
      '',
      '_Describe the objective here._',
    ].join('\n');
    const prompt = buildDrafterPrompt('Add rate limiting', template, 'Some context');
    expect(prompt).toContain('Add rate limiting');
    // Template body is included (header stripped)
    expect(prompt).toContain('## Objective');
    // Header metadata is stripped
    expect(prompt).not.toContain('{{PLAN_ID}}');
    expect(prompt).toContain('Some context');
    expect(prompt).toContain('Read the codebase');
    expect(prompt).toContain('concrete repo-relative file paths');
    expect(prompt).toContain('Do not use placeholder paths like `path/to/file.ts`');
    // Instructions come before template
    expect(prompt.indexOf('## Instructions')).toBeLessThan(prompt.indexOf('## Expected Output Structure'));
    // Anti-echo instruction
    expect(prompt).toContain('DO NOT echo the template verbatim');
  });

  it('strips mustache tokens from the template body (e.g. {{DATE}} in Audit Log)', () => {
    const template = [
      '# Plan: {{TITLE}}',
      '',
      '**ID:** {{PLAN_ID}}',
      '**Created:** {{DATE}}',
      '',
      '---',
      '',
      '## Objective',
      '',
      'What we\'re doing and why.',
      '',
      '### Review 1 — {{DATE}}',
      '**Status:** PENDING',
    ].join('\n');
    const prompt = buildDrafterPrompt('Fix the bug', template, 'ctx');
    // Header tokens are stripped by stripTemplateHeader
    expect(prompt).not.toContain('{{PLAN_ID}}');
    // Body tokens like {{DATE}} in the Audit Log section should be replaced
    expect(prompt).not.toContain('{{DATE}}');
    // The replacement should be today's date
    const today = new Date().toISOString().split('T')[0]!;
    expect(prompt).toContain(`### Review 1 — ${today}`);
  });
});

describe('buildAuditorPrompt', () => {
  it('includes plan content and structured instructions with new severity vocabulary', () => {
    const prompt = buildAuditorPrompt('# Plan: Test\n\n## Objective\nDo stuff.', 1);
    expect(prompt).toContain('# Plan: Test');
    expect(prompt).toContain('blocking | medium | minor | suggestion');
    expect(prompt).not.toContain('Severity: high | medium | low');
    expect(prompt).toContain('audit round 1');
  });

  it('requires a json verdict block in output format', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('Start with a fenced JSON verdict block');
    expect(prompt).toContain('"maxSeverity":"blocking|medium|minor|suggestion|none"');
    expect(prompt).toContain('`shouldLoop` must be true only when `maxSeverity` is `blocking`');
  });

  it('includes severity level definitions', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('Correctness bugs, security issues, architectural flaws');
    expect(prompt).toContain('Substantive improvements');
    expect(prompt).toContain('Small issues: naming, style');
    expect(prompt).toContain('Ideas for future improvement');
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

  it('requires concrete repo-relative file paths in Changes during revision', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).toContain('concrete backtick-wrapped repo-relative path');
    expect(prompt).toContain('Replace placeholder paths like `path/to/file.ts`');
  });

  it('references blocking severity concerns (not high and medium)', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).toContain('blocking severity concerns');
    expect(prompt).not.toContain('high and medium severity');
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
      '**Task:** ws-abc',
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
      '**Task:** ws-001',
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
      '**Task:** ws-002',
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
    const verdict = { maxSeverity: 'minor' as const, shouldLoop: false };
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
    const verdict = { maxSeverity: 'blocking' as const, shouldLoop: true };
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
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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

  it('completes in 2 rounds when first audit has blocking concerns', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan; // Same structure, orchestrator handles merge
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft -> Audit (blocking) -> Revise -> Audit (clean)
    const runtime = makeMockRuntime([draftPlan, auditBlocking, revisedPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.rounds).toBe(2);
    expect(result.reachedMaxRounds).toBe(false);
    expect(progress.some((p) => p.includes('blocking concerns'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('medium severity auto-approves without revision', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditMedium = '**Concern 1: Missing details**\n**Severity: medium**\n\n**Verdict:** Needs revision.';

    // Draft -> Audit (medium) -> should auto-approve (no revision)
    const runtime = makeMockRuntime([draftPlan, auditMedium]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.rounds).toBe(1);
    expect(result.reachedMaxRounds).toBe(false);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
    // Should NOT include revision progress
    expect(progress.some((p) => p.includes('Revising'))).toBe(false);
  });

  it('stops at max rounds when audit always returns blocking concerns', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditHigh = '**Concern 1: Fundamental flaw**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';

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

  it('reports error when draft phase fails both attempts', async () => {
    const tmpDir = await makeTmpDir();
    // Both draft attempts (original + retry) must error.
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'error', message: 'Runtime crashed' };
        })();
      },
    };
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(progress.some((p) => p.includes('Forge failed'))).toBe(true);
  });

  it('reports error when audit phase fails both attempts but preserves draft', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    // Draft succeeds; both audit attempts (original + retry) fail
    // makeMockRuntimeWithError errors on errorOnCall index; after the error, responses[idx] is used.
    // We need call 1 and call 2 both to error. Use a custom runtime for clarity.
    let callIdx = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        const idx = callIdx++;
        if (idx === 0) {
          return (async function* (): AsyncGenerator<EngineEvent> {
            yield { type: 'text_final', text: draftPlan };
          })();
        }
        // idx 1 and 2 (audit attempt + retry) both error
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'error', message: 'Runtime crashed' };
        })();
      },
    };
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
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditBlocking, revisedPlan, auditClean]);
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const opts = await baseOpts(tmpDir, runtime, { log: mockLog });
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    // Cancel after the first audit
    const result = await orchestrator.run('Test', async (msg) => {
      progress.push(msg);
      if (msg.includes('blocking concerns')) {
        orchestrator.requestCancel();
      }
    });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(result.rounds).toBeLessThanOrEqual(2);
    expect(progress[progress.length - 1]).toMatch(/cancelled/i);

    // Verify structured cancellation log was emitted with correct phase
    const cancelledCalls = mockLog.info.mock.calls.filter(
      (c: unknown[]) => c[1] === 'forge:cancelled',
    );
    expect(cancelledCalls.length).toBeGreaterThanOrEqual(1);
    const lastCancelled = cancelledCalls[cancelledCalls.length - 1]!;
    expect(lastCancelled[0]).toHaveProperty('phase');
    expect(['loop-entry', 'draft', 'audit', 'revision']).toContain(lastCancelled[0].phase);
  });

  it('requestCancel(reason) logs the reason', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const opts = await baseOpts(tmpDir, runtime, { log: mockLog });
    const orchestrator = new ForgeOrchestrator(opts);

    // Start the forge so currentPlanId is set, then cancel with a reason
    const result = await orchestrator.run('Test', async (msg) => {
      if (msg.includes('Drafting')) {
        orchestrator.requestCancel('user-initiated');
      }
    });

    expect(result.finalVerdict).toBe('CANCELLED');

    // Verify requestCancel logged the reason
    const cancelRequestedCalls = mockLog.info.mock.calls.filter(
      (c: unknown[]) => c[1] === 'forge:cancel-requested',
    );
    expect(cancelRequestedCalls.length).toBe(1);
    expect(cancelRequestedCalls[0]![0]).toMatchObject({ reason: 'user-initiated' });
  });

  it('cancel during draft phase logs phase:draft', async () => {
    const tmpDir = await makeTmpDir();

    let orchestrator!: ForgeOrchestrator;
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          // Cancel mid-draft, then yield — post-return guard returns null
          orchestrator.requestCancel();
          yield { type: 'text_final', text: '# Plan: Test\n' };
        })();
      },
    };

    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const opts = await baseOpts(tmpDir, runtime, { log: mockLog });
    orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test', async () => {});

    expect(result.finalVerdict).toBe('CANCELLED');

    // Verify draft-phase cancellation log
    const cancelledCalls = mockLog.info.mock.calls.filter(
      (c: unknown[]) => c[1] === 'forge:cancelled',
    );
    expect(cancelledCalls.length).toBeGreaterThanOrEqual(1);
    expect(cancelledCalls[0]![0]).toMatchObject({ phase: 'draft' });
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

    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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

    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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

  it('injects root policy and tracked defaults into drafter context summary without workspace DISCOCLAW.md', async () => {
    const tmpDir = await makeTmpDir();
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\nUser override rules.', 'utf-8');

    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

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

    const drafterPrompt = prompts[0] ?? '';
    const rootIdx = drafterPrompt.indexOf(ROOT_POLICY);
    const trackedIdx = drafterPrompt.indexOf(TRACKED_DEFAULTS_PREAMBLE);
    const agentsIdx = drafterPrompt.indexOf('--- AGENTS.md ---');

    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(trackedIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(rootIdx).toBeLessThan(trackedIdx);
    expect(trackedIdx).toBeLessThan(agentsIdx);
  });

  it('ignores workspace DISCOCLAW.md and uses tracked defaults in drafter context summary', async () => {
    const tmpDir = await makeTmpDir();
    const legacySentinel = 'LEGACY_WORKSPACE_DISCOCLAW_SHOULD_NOT_BE_INCLUDED';
    await fs.writeFile(path.join(tmpDir, 'DISCOCLAW.md'), legacySentinel, 'utf-8');

    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

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

    const drafterPrompt = prompts[0] ?? '';
    expect(drafterPrompt).toContain('--- DISCOCLAW.md (tracked defaults) ---');
    expect(drafterPrompt).not.toContain(legacySentinel);
  });

  it('passes read-only tools to auditor invoke call', async () => {
    const tmpDir = await makeTmpDir();

    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Capture invoke params for each call
    const invocations: Array<Record<string, unknown>> = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text', 'tools_fs'] as const),
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
    const tmpDir = await makeTmpDir();
    // Drafter returns a clean title ("Add webhook retry logic") different from raw input
    const draftPlan = `# Plan: Add webhook retry logic\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nAdd retry logic.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const updateSpy = vi.spyOn(opts.taskStore, 'update');
    const orchestrator = new ForgeOrchestrator(opts);

    // Raw description differs from the drafter's clean title
    await orchestrator.run('a]plan to add webhook retry stuff', async () => {});

    expect(updateSpy).toHaveBeenCalledWith(
      expect.any(String),
      { title: 'Add webhook retry logic' },
    );
  });

  it('skips bead title update when drafter title matches description', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild it.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const updateSpy = vi.spyOn(opts.taskStore, 'update');
    const orchestrator = new ForgeOrchestrator(opts);

    // Description matches the drafter's title exactly
    await orchestrator.run('Test feature', async () => {});

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reuses existing open bead with matching title instead of creating duplicate', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);

    // Pre-create a bead with the matching title and 'plan' label
    const existingBead = opts.taskStore.create({ title: 'Test feature', labels: ['plan'] });
    const createSpy = vi.spyOn(opts.taskStore, 'create');
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    // taskStore.create should NOT have been called — reusing existing bead
    expect(createSpy).not.toHaveBeenCalled();

    // The plan file should reference the existing bead ID
    const plansDir = path.join(tmpDir, 'plans');
    const entries = await fs.readdir(plansDir);
    const planFile = entries.find((e) => e.startsWith('plan-001') && e.endsWith('.md') && !e.includes('template'));
    expect(planFile).toBeTruthy();
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain(`**Task:** ${existingBead.id}`);
  });

  it('dedup is case-insensitive and trims whitespace', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);

    // Title differs in case and has extra whitespace
    opts.taskStore.create({ title: '  TEST FEATURE  ', labels: ['plan'] });
    const createSpy = vi.spyOn(opts.taskStore, 'create');
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does not reuse closed beads with matching title', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);

    // Only closed bead matches — should NOT be reused
    const closedBead = opts.taskStore.create({ title: 'Test feature', labels: ['plan'] });
    opts.taskStore.close(closedBead.id);
    const createSpy = vi.spyOn(opts.taskStore, 'create');
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    // taskStore.create SHOULD have been called — closed bead not reused
    expect(createSpy).toHaveBeenCalled();
  });

  it('creates new bead when no title match exists', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);

    // No matching beads — only an unrelated one exists
    opts.taskStore.create({ title: 'Something else entirely', labels: ['plan'] });
    const createSpy = vi.spyOn(opts.taskStore, 'create');
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    // taskStore.create SHOULD have been called — no matching bead found
    expect(createSpy).toHaveBeenCalled();
  });

  it('cancel mid-phase (post-return guard): pipeline returns normally but cancel is set', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;

    let orchestrator!: ForgeOrchestrator;
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          // Cancel while the pipeline is running, then still yield the response.
          // The post-return guard should catch this before the output is processed.
          orchestrator.requestCancel();
          yield { type: 'text_final', text: draftPlan };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test', async (msg) => { progress.push(msg); });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(result.error).toBeUndefined();
    expect(progress[progress.length - 1]).toMatch(/cancelled/i);
  });

  it('cancel mid-phase (cancel-aware catch): pipeline throws while cancel is set', async () => {
    const tmpDir = await makeTmpDir();

    let orchestrator!: ForgeOrchestrator;
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        return (async function* (): AsyncGenerator<EngineEvent> {
          // Cancel, then emit an error event — pipeline will throw.
          // The cancel-aware catch should treat the throw as cancellation.
          orchestrator.requestCancel();
          yield { type: 'error', message: 'Aborted by signal' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test', async (msg) => { progress.push(msg); });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(result.error).toBeUndefined();
    expect(progress[progress.length - 1]).toMatch(/cancelled/i);
  });

  // ---------------------------------------------------------------------------
  // Retry behavior
  // ---------------------------------------------------------------------------

  it('retries draft phase on failure and completes if retry succeeds', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Call 0: draft attempt 1 → error, Call 1: draft retry → success, Call 2: audit → clean
    const runtime = makeRetryableRuntime(['error', draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    expect(progress.some((p) => p.includes('Draft') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('retries audit phase on failure and completes if retry succeeds', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Call 0: draft → success, Call 1: audit attempt 1 → error, Call 2: audit retry → clean
    const runtime = makeRetryableRuntime([draftPlan, 'error', auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    expect(progress.some((p) => p.includes('Audit round 1') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('reports phase-specific error when draft fails twice', async () => {
    const tmpDir = await makeTmpDir();

    // Both draft attempts (attempt + retry) fail
    const runtime = makeRetryableRuntime(['error', 'error']);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Draft');
    expect(progress.some((p) => p.includes('Draft') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge failed'))).toBe(true);
  });

  it('reports phase-specific error when audit fails twice', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;

    // Draft succeeds; both audit attempts fail
    const runtime = makeRetryableRuntime([draftPlan, 'error', 'error']);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Audit round');
    expect(progress.some((p) => p.includes('Audit round 1') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Partial plan saved'))).toBe(true);
  });

  it('retry notice is posted with force: true', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft fails once then succeeds on retry
    const runtime = makeRetryableRuntime(['error', draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const calls: Array<{ msg: string; force?: boolean }> = [];
    await orchestrator.run('Test feature', async (msg, optsArg) => {
      calls.push({ msg, force: optsArg?.force });
    });

    const retryCall = calls.find((c) => c.msg.includes('retrying'));
    expect(retryCall).toBeDefined();
    expect(retryCall!.force).toBe(true);
  });

  it('passes existingTaskId through to handlePlanCommand (skips create)', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { existingTaskId: 'existing-task-42' });
    const createSpy = vi.spyOn(opts.taskStore, 'create');
    const addLabelSpy = vi.spyOn(opts.taskStore, 'addLabel');
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.planId).toMatch(/^plan-001$/);
    expect(result.error).toBeUndefined();
    // taskStore.create should NOT have been called — reusing existing task
    expect(createSpy).not.toHaveBeenCalled();
    // taskStore.addLabel should have been called to add the 'plan' label
    expect(addLabelSpy).toHaveBeenCalledWith('existing-task-42', 'plan');

    // Verify the plan file contains the existing task ID.
    const plansDir = path.join(tmpDir, 'plans');
    const entries = await fs.readdir(plansDir);
    const planFile = entries.find((e) => e.startsWith('plan-001') && e.endsWith('.md') && !e.includes('template'));
    expect(planFile).toBeTruthy();
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toMatch(/\*\*(Task|Bead):\*\* existing-task-42/);
  });

  it('non-retryable error causes immediate failure with phase context without retry', async () => {
    const tmpDir = await makeTmpDir();
    let callCount = 0;
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        callCount++;
        return (async function* (): AsyncGenerator<EngineEvent> {
          // 'Plan has structural issues' does not match any retryable pattern
          yield { type: 'error', message: 'Plan has structural issues' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Draft');
    expect(callCount).toBe(1); // no retry attempted
    expect(progress.every((p) => !p.includes('retrying'))).toBe(true); // no retry message
    expect(progress.some((p) => p.includes('Forge failed'))).toBe(true);
  });

  it('cancel set during first failure prevents retry from being attempted', async () => {
    const tmpDir = await makeTmpDir();
    let orchestrator!: ForgeOrchestrator;
    let callCount = 0;

    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        callCount++;
        return (async function* (): AsyncGenerator<EngineEvent> {
          // Request cancel before yielding the retryable error. runCancellable's
          // cancel-aware catch returns null, so runWithRetry's catch never fires
          // and no retry is attempted.
          orchestrator.requestCancel();
          yield { type: 'error', message: 'hang detected' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test', async (msg) => { progress.push(msg); });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(callCount).toBe(1); // retry was not attempted
    expect(progress[progress.length - 1]).toMatch(/cancelled/i);
  });

  // ---------------------------------------------------------------------------
  // Template-echo retry behavior
  // ---------------------------------------------------------------------------

  it('retries draft when first attempt echoes the template, and succeeds on second attempt', async () => {
    const tmpDir = await makeTmpDir();
    const echoedTemplate = `# Plan: {{TITLE}}\n\n**ID:** {{PLAN_ID}}\n**Task:** {{TASK_ID}}\n**Created:** {{DATE}}\n**Status:** DRAFT\n**Project:** {{PROJECT}}\n\n---\n\n## Objective\n\n_Describe the objective here._\n\n## Changes\n\n_List file-by-file changes._\n`;
    const realDraft = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Call 0: draft → echoed template, Call 1: retry draft → real plan, Call 2: audit → clean
    const runtime = makeMockRuntime([echoedTemplate, realDraft, auditClean]);
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const opts = await baseOpts(tmpDir, runtime, { log: mockLog });
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    expect(progress.some((p) => p.includes('stalled') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
    // Verify structured warning log was emitted
    const warnCalls = mockLog.warn.mock.calls.filter(
      (c: unknown[]) => c[1] === 'forge:template-echo',
    );
    expect(warnCalls.length).toBe(1);
  });

  it('reports error when both draft attempts echo the template', async () => {
    const tmpDir = await makeTmpDir();
    const echoedTemplate = `# Plan: {{TITLE}}\n\n**ID:** {{PLAN_ID}}\n**Task:** {{TASK_ID}}\n**Created:** {{DATE}}\n**Status:** DRAFT\n**Project:** {{PROJECT}}\n\n---\n\n## Objective\n\n_Describe the objective here._\n\n## Changes\n\n_List file-by-file changes._\n`;

    // Both draft attempts echo the template
    const runtime = makeMockRuntime([echoedTemplate, echoedTemplate]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('echoed the template');
    expect(progress.some((p) => p.includes('stalled') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge failed'))).toBe(true);
  });

  it('template-echo retry progress message includes force: true', async () => {
    const tmpDir = await makeTmpDir();
    const echoedTemplate = `# Plan: {{TITLE}}\n\n## Objective\n\n_Describe the objective here._\n`;
    const realDraft = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild it.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([echoedTemplate, realDraft, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const calls: Array<{ msg: string; force?: boolean }> = [];
    await orchestrator.run('Test feature', async (msg, optsArg) => {
      calls.push({ msg, force: optsArg?.force });
    });

    const retryCall = calls.find((c) => c.msg.includes('stalled') && c.msg.includes('retrying'));
    expect(retryCall).toBeDefined();
    expect(retryCall!.force).toBe(true);
  });

  it('template-echo retry augments prompt with anti-echo warning', async () => {
    const tmpDir = await makeTmpDir();
    const echoedTemplate = `# Plan: {{TITLE}}\n\n## Objective\n\n_Describe the objective here._\n`;
    const realDraft = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild it.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const prompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        prompts.push(params.prompt);
        const responses = [echoedTemplate, realDraft, auditClean];
        const text = responses[prompts.length - 1] ?? '(no response)';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // First draft prompt should NOT have the retry prefix
    expect(prompts[0]).not.toContain('previous attempt returned the template verbatim');
    // Retry draft prompt SHOULD have the prefix
    expect(prompts[1]).toContain('previous attempt returned the template verbatim');
    expect(prompts[1]).toContain('MUST read the codebase');
  });

  it('retries revision phase on failure and completes if retry succeeds', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const auditClean = '**Verdict:** Ready to approve.';

    // Call 0: draft → success, Call 1: audit → blocking, Call 2: revision attempt → error,
    // Call 3: revision retry → success, Call 4: audit → clean
    const runtime = makeRetryableRuntime([draftPlan, auditBlocking, 'error', draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(2);
    expect(progress.some((p) => p.includes('Revision') && p.includes('stalled'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('resolves degenerate description "this" to task title in drafter prompt', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Sanitize webhook body\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nSanitize webhook.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

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

    const taskStore = new TaskStore({ prefix: 'ws' });
    taskStore.create({ title: 'Sanitize webhook body before prompt interpolation', priority: 1 });
    const task = taskStore.list()[0]!;

    const opts = await baseOpts(tmpDir, runtime, { taskStore, existingTaskId: task.id });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('this', async () => {});

    // Drafter prompt should contain the resolved task title, not "this"
    expect(prompts[0]).toContain('Sanitize webhook body before prompt interpolation');
    expect(prompts[0]).not.toMatch(/## Task\s+\nthis\n/);
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
    `**Task:** ws-test-001`,
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
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const revisedPlan = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const auditClean = '**Verdict:** Ready to approve.';

    const opts = await baseOpts(tmpDir, makeMockRuntime([
      auditBlocking,  // first audit
      revisedPlan,    // revision
      auditClean,     // second audit
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
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const revisedPlan = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const auditClean = '**Verdict:** Ready to approve.';

    const opts = await baseOpts(tmpDir, makeMockRuntime([auditBlocking, revisedPlan, auditClean]));

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async (msg) => {
      progress.push(msg);
      if (msg.includes('blocking concerns')) {
        orchestrator.requestCancel();
      }
    });

    expect(result.finalVerdict).toBe('CANCELLED');
    expect(progress[progress.length - 1]).toMatch(/cancelled/i);
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
      '**Task:** ws-test-001',
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

  it('rejects plans with placeholder sections (medium structural)', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([]));

    // Plan has all required sections but Objective is placeholder text
    const planContent = [
      '# Plan: Placeholder Plan',
      '',
      '**ID:** plan-001',
      '**Task:** ws-test-001',
      '**Created:** 2026-01-01',
      '**Status:** REVIEW',
      '**Project:** discoclaw',
      '',
      '---',
      '',
      '## Objective',
      '',
      '_(TODO)_',
      '',
      '## Scope',
      '',
      'In scope: everything related to testing.',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — Add bar function.',
      '',
      '## Risks',
      '',
      '- Low risk.',
      '',
      '## Testing',
      '',
      '- Unit tests for the new feature.',
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
    const result = await orchestrator.resume('plan-001', filePath, 'Placeholder Plan', async () => {});

    expect(result.error).toBeDefined();
    expect(result.error).toContain('structural issues');
    expect(result.error).toContain('Objective');
  });

  it('retries audit phase on retryable failure during resume() and completes if retry succeeds', async () => {
    const tmpDir = await makeTmpDir();
    const auditClean = '**Verdict:** Ready to approve.';

    // Call 0: audit attempt → retryable error, Call 1: audit retry → clean
    const runtime = makeRetryableRuntime(['error', auditClean]);
    const opts = await baseOpts(tmpDir, runtime);

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];
    const result = await orchestrator.resume('plan-001', filePath, 'Test Plan', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    expect(progress.some((p) => p.includes('stalled') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
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
    capabilities: new Set(['streaming_text' as const, 'sessions' as const]),
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
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
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
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const revisedPlan = draftPlan;
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft -> Audit (blocking) -> Revise -> Audit (clean)
    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditBlocking, revisedPlan, auditClean]);
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

// ---------------------------------------------------------------------------
// Auditor runtime tests
// ---------------------------------------------------------------------------

describe('auditorRuntime support', () => {
  it('auditorRuntime is used for audit calls when set', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterRuntime = makeMockRuntime([draftPlan]);

    // Separate auditor runtime
    const auditorInvocations: RuntimeInvokeParams[] = [];
    const auditorRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        auditorInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: auditClean };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, drafterRuntime, { auditorRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    // The auditor runtime should have been called
    expect(auditorInvocations).toHaveLength(1);
  });

  it('falls back to default runtime when auditorRuntime is undefined', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { auditorRuntime: undefined });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // Both drafter and auditor calls go to the same runtime
    expect(invocations).toHaveLength(2);
  });

  it('non-Claude auditor runtime receives empty model string when auditorModel not set', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterRuntime = makeMockRuntime([draftPlan]);

    const auditorInvocations: RuntimeInvokeParams[] = [];
    const auditorRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        auditorInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: auditClean };
        })();
      },
    };

    // auditorModel is not set, so it defaults to opts.model ('test-model')
    const opts = await baseOpts(tmpDir, drafterRuntime, { auditorRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // Non-Claude auditor should receive empty model (to fall back to adapter's defaultModel)
    expect(auditorInvocations[0]!.model).toBe('');
  });

  it('non-Claude auditor receives no tools, addDirs, or sessionKey', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterRuntime = makeMockRuntime([draftPlan]);

    const auditorInvocations: RuntimeInvokeParams[] = [];
    const auditorRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        auditorInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: auditClean };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, drafterRuntime, { auditorRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(auditorInvocations[0]!.tools).toEqual([]);
    expect(auditorInvocations[0]!.addDirs).toBeUndefined();
    expect(auditorInvocations[0]!.sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAuditorPrompt hasTools option
// ---------------------------------------------------------------------------

describe('buildAuditorPrompt hasTools option', () => {
  it('hasTools=false omits tool instructions', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1, undefined, { hasTools: false });
    expect(prompt).not.toContain('Read, Glob, and Grep tools');
    expect(prompt).not.toContain('Use them before raising concerns');
    expect(prompt).toContain('You do not have access to the codebase');
    expect(prompt).toContain('logical consistency');
  });

  it('hasTools=true (default) includes tool instructions', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('Read, Glob, and Grep tools');
    expect(prompt).toContain('Use them before raising concerns');
    expect(prompt).not.toContain('You do not have access to the codebase');
  });
});

// ---------------------------------------------------------------------------
// Drafter runtime tests
// ---------------------------------------------------------------------------

const MINIMAL_DRAFT_PLAN = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;

describe('drafterRuntime support', () => {
  it('drafterRuntime is used for draft calls when set', async () => {
    const tmpDir = await makeTmpDir();
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterInvocations: RuntimeInvokeParams[] = [];
    const drafterRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        drafterInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: MINIMAL_DRAFT_PLAN };
        })();
      },
    };

    const auditorRuntime = makeMockRuntime([auditClean]);
    const opts = await baseOpts(tmpDir, auditorRuntime, { drafterRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(drafterInvocations).toHaveLength(1);
  });

  it('drafterRuntime is used for revision calls when set', async () => {
    const tmpDir = await makeTmpDir();
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterInvocations: RuntimeInvokeParams[] = [];
    const drafterRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        drafterInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: MINIMAL_DRAFT_PLAN };
        })();
      },
    };

    const auditorRuntime = makeMockRuntime([auditBlocking, auditClean]);
    const opts = await baseOpts(tmpDir, auditorRuntime, { drafterRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    // call 0: draft, call 1: revision
    expect(drafterInvocations).toHaveLength(2);
  });

  it('falls back to default runtime when drafterRuntime is undefined', async () => {
    const tmpDir = await makeTmpDir();
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([MINIMAL_DRAFT_PLAN, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { drafterRuntime: undefined });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    // Both drafter and auditor calls go to the same runtime
    expect(invocations).toHaveLength(2);
  });

  it('non-Claude drafter runtime receives empty model string when drafterModel not set', async () => {
    const tmpDir = await makeTmpDir();
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterInvocations: RuntimeInvokeParams[] = [];
    const drafterRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        drafterInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: MINIMAL_DRAFT_PLAN };
        })();
      },
    };

    // drafterModel is not set — non-Claude runtime should receive empty model string
    const opts = await baseOpts(tmpDir, makeMockRuntime([auditClean]), { drafterRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(drafterInvocations[0]!.model).toBe('');
  });

  it('non-Claude drafter runtime receives no sessionKey', async () => {
    const tmpDir = await makeTmpDir();
    const auditClean = '**Verdict:** Ready to approve.';

    const drafterInvocations: RuntimeInvokeParams[] = [];
    const drafterRuntime: RuntimeAdapter = {
      id: 'openai' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(params) {
        drafterInvocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: MINIMAL_DRAFT_PLAN };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, makeMockRuntime([auditClean]), { drafterRuntime });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(drafterInvocations[0]!.sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ForgeOrchestrator onEvent threading
// ---------------------------------------------------------------------------

function makeMockRuntimeWithEvents(responseMap: Array<{ text: string; events?: EngineEvent[] }>): RuntimeAdapter {
  let callIndex = 0;
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      const entry = responseMap[callIndex] ?? { text: '(no response)' };
      callIndex++;
      return (async function* (): AsyncGenerator<EngineEvent> {
        for (const evt of entry.events ?? []) yield evt;
        yield { type: 'text_final', text: entry.text };
      })();
    },
  };
}

describe('ForgeOrchestrator onEvent threading', () => {
  it('onEvent spy receives events during draft phase', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntimeWithEvents([
      { text: draftPlan, events: [{ type: 'text_delta', text: 'drafting...' }] },
      { text: auditClean },
    ]);

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const received: EngineEvent[] = [];
    await orchestrator.run('Test feature', async () => {}, undefined, (evt) => received.push(evt));

    expect(received.some((e) => e.type === 'text_delta')).toBe(true);
    expect(received.some((e) => e.type === 'text_final')).toBe(true);
  });

  it('onEvent spy receives events during audit phase', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntimeWithEvents([
      { text: draftPlan },
      { text: auditClean, events: [{ type: 'text_delta', text: 'auditing...' }] },
    ]);

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const received: EngineEvent[] = [];
    await orchestrator.run('Test feature', async () => {}, undefined, (evt) => received.push(evt));

    expect(received.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('throwing onEvent does not abort forge execution', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {}, undefined, () => {
      throw new Error('callback exploded');
    });

    // Forge should complete successfully despite throwing onEvent
    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Post-loop structural check
// ---------------------------------------------------------------------------

describe('post-loop structural check', () => {
  it('warns when auditor approves a plan missing a required section after revision', async () => {
    const tmpDir = await makeTmpDir();
    // Complete draft with all required sections
    const draftPlan = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\nStuff.\n\n## Changes\n\n- src/foo.ts\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    // Revision strips ## Testing section
    const revisedPlanNoTesting = `# Plan: Test\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something better.\n\n## Scope\n\nStuff.\n\n## Changes\n\n- src/foo.ts — enhanced\n\n## Risks\n\n- None.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    // Draft -> Audit (blocking) -> Revise (missing Testing) -> Audit (clean)
    const runtime = makeMockRuntime([draftPlan, auditBlocking, revisedPlanNoTesting, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    // structuralWarning should be populated
    expect(result.structuralWarning).toBeDefined();
    expect(result.structuralWarning).toContain('Testing');

    // Progress message should include the warning
    const completeMsg = progress.find((p) => p.includes('Forge complete'));
    expect(completeMsg).toBeDefined();
    expect(completeMsg).toContain('Structural warning');
    expect(completeMsg).toContain('Testing');

    // Plan file should contain the structural warning note
    const planContent = await fs.readFile(result.filePath, 'utf-8');
    expect(planContent).toContain('Structural warning (automated)');
    expect(planContent).toContain('Testing');
  });

  it('no warning when auditor approves a structurally complete plan', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing with proper structure.\n\n## Scope\n\nIn scope: everything related to testing.\n\n## Changes\n\n### File-by-file breakdown\n\n#### \`src/foo.ts\`\n\nAdd bar function.\n\n## Risks\n\n- Low risk of breaking existing tests.\n\n## Testing\n\n- Unit tests for the new feature.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    // structuralWarning should be undefined
    expect(result.structuralWarning).toBeUndefined();

    // Progress message should NOT include structural warning
    const completeMsg = progress.find((p) => p.includes('Forge complete'));
    expect(completeMsg).toBeDefined();
    expect(completeMsg).not.toContain('Structural warning');
  });
});
