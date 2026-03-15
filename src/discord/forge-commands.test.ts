import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  AUDIT_CRITERIA_LINES,
} from './forge-commands.js';
import type { ForgeOrchestratorOpts } from './forge-commands.js';
import type { RuntimeAdapter, EngineEvent, RuntimeInvokeParams } from '../runtime/types.js';
import { TaskStore } from '../tasks/store.js';
import { wrapRuntimeWithGlobalPolicies } from '../index.runtime.js';
import { ROOT_POLICY, TRACKED_DEFAULTS_PREAMBLE } from './prompt-common.js';
import { _resetForTest, setForgePlanMetadata } from './forge-plan-registry.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
}

function seedResumeMetadata(planId: string, candidatePaths: string[] = ['src/foo.ts']): void {
  setForgePlanMetadata(planId, {
    phaseState: {
      currentPhase: 'audit',
      researchComplete: true,
    },
    candidateBounds: {
      candidatePaths,
      allowlistPaths: candidatePaths,
    },
    fallbackPolicy: {
      onOutOfBounds: 're_research',
      reResearchPhase: 'revision_research',
    },
  });
}

function ensureConcretePlanPath(text: string): string {
  if (!text.startsWith('# Plan:')) return text;
  if (text.includes('src/') || text.includes('docs/') || text.includes('scripts/')) return text;
  return text.replace(
    /## Changes\s*\n\n/,
    '## Changes\n\n- `src/foo.ts` — add the implementation detail.\n\n',
  );
}

function makeMockRuntime(responses: string[]): RuntimeAdapter {
  let callIndex = 0;
  return {
    id: 'claude_code' as const,
    capabilities: new Set(['streaming_text' as const]),
    invoke(_params) {
      const text = ensureConcretePlanPath(responses[callIndex] ?? '(no response)');
      callIndex++;
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
        yield { type: 'done' };
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
      const text = ensureConcretePlanPath(responses[idx] ?? '(no response)');
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
        yield { type: 'done' };
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

async function seedCodexCandidateFiles(tmpDir: string): Promise<void> {
  const files = [
    ['src/discord/forge-commands.ts', 'export const forgeMarker = "forge codex auditor";\n'],
    ['src/runtime/codex-app-server.ts', 'export const appServerMarker = "codex app server";\n'],
    ['src/runtime/codex-cli.ts', 'export const cliMarker = "codex cli";\n'],
  ] as const;

  for (const [relativePath, content] of files) {
    const absolutePath = path.join(tmpDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }
}

async function seedCodexNativeWriteContextFiles(tmpDir: string): Promise<void> {
  const workspaceFiles = [
    ['SOUL.md', '# SOUL.md\ncodex native soul context\n'],
    ['IDENTITY.md', '# IDENTITY.md\ncodex native identity context\n'],
    ['USER.md', '# USER.md\ncodex native user context\n'],
    ['AGENTS.md', '# AGENTS.md\ncodex native agents context\n'],
    ['TOOLS.md', '# TOOLS.md\ncodex native tools context\n'],
  ] as const;

  for (const [relativePath, content] of workspaceFiles) {
    await fs.writeFile(path.join(tmpDir, relativePath), content, 'utf8');
  }

  await fs.mkdir(path.join(tmpDir, '.context'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, '.context', 'project.md'),
    '# Project Context\ncodex native project context\n',
    'utf8',
  );
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'compound-lessons.md'),
    '# Compound Lessons\n\n## Lessons\n\n- codex native compound lesson\n',
    'utf8',
  );
}

beforeEach(() => {
  _resetForTest();
});

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
      const text = ensureConcretePlanPath(entry);
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
        yield { type: 'done' };
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

  it('text containing "Severity: none" -> none, no loop', () => {
    const text = '**Severity: none**\nNo concerns found.\n\n**Verdict:** Ready to approve.';
    expect(parseAuditVerdict(text)).toEqual({ maxSeverity: 'none', shouldLoop: false });
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

  it('matches native Codex app-server disconnects', () => {
    expect(isRetryableError('codex app-server websocket closed')).toBe(true);
    expect(isRetryableError('codex app-server websocket is closed')).toBe(true);
  });

  it('matches drafter echoed the template', () => {
    expect(isRetryableError('drafter echoed the template')).toBe(true);
  });

  it('matches plan output prefix contract failures', () => {
    expect(isRetryableError('draft output must start with # Plan:')).toBe(true);
    expect(isRetryableError('revision output must start with # Plan:')).toBe(true);
  });

  it('matches grounding output contract failures', () => {
    expect(isRetryableError('draft grounding output must be repo-relative file paths only')).toBe(true);
    expect(isRetryableError('revision grounding output must be repo-relative file paths or NONE')).toBe(true);
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
    expect(prompt).toContain('name the exact enforcement mechanism');
    expect(prompt).toContain('docs/compound-lessons.md');
    expect(prompt).toContain('single checked-in durable artifact');
    expect(prompt).toContain('entry format, ownership, update/promotion rules, and review expectations');
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

  it('tells the drafter to update existing lessons before adding materially distinct new ones', () => {
    const prompt = buildDrafterPrompt(
      'Codify a reusable pattern',
      '# Plan: {{TITLE}}\n\n---\n\n## Objective',
      'ctx',
    );

    expect(prompt).toContain('Check the existing `docs/compound-lessons.md` entries before proposing a lesson.');
    expect(prompt).toContain('update the existing entry if it already covers the pattern');
    expect(prompt).toContain('only when the lesson is materially distinct');
  });

  it('tells the drafter that postmortems and task or chat context are first-class lesson sources with a mandatory review gate', () => {
    const prompt = buildDrafterPrompt(
      'Codify a reusable pattern',
      '# Plan: {{TITLE}}\n\n---\n\n## Objective',
      'ctx',
    );

    expect(prompt).toContain('postmortems');
    expect(prompt).toContain('task threads');
    expect(prompt).toContain('implementation chat');
    expect(prompt).toContain('mandatory before-merge promotion decision and dedup check');
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
    expect(prompt).toContain('omits the raw audit log to reduce repetition');
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

  it('requires auditors to verify restriction claims against a real enforcement primitive', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('restricted subset of a broader capability');
    expect(prompt).toContain('exact gating primitive');
    expect(prompt).toContain('only describes the restriction in prose, that is a blocking concern');
  });

  it('requires auditors to verify durable lesson plans against the compound lessons artifact', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    expect(prompt).toContain('docs/compound-lessons.md');
    expect(prompt).toContain('recurring workflow/process/quality gap');
    expect(prompt).toContain('format, ownership, update rules, and review expectations');
    expect(prompt).toContain('explicit promotion decision');
    expect(prompt).toContain('dedup check before merge');
    expect(prompt).toContain('postmortems');
    expect(prompt).toContain('task threads');
  });

  it('includes criteria near the start of the prompt before ## Plan to Audit', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    const planToAuditIdx = prompt.indexOf('## Plan to Audit');
    const keyCriteriaIdx = prompt.indexOf('## Key Audit Criteria');
    expect(keyCriteriaIdx).toBeGreaterThan(-1);
    expect(keyCriteriaIdx).toBeLessThan(planToAuditIdx);
    // Verify a sample criterion appears before ## Plan to Audit
    const earlySection = prompt.slice(0, planToAuditIdx);
    expect(earlySection).toContain('Missing or underspecified details');
    expect(earlySection).toContain('Structural integrity');
  });

  it('includes criteria after the final output format instructions', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    const outputOnlyIdx = prompt.indexOf('Output only the JSON block');
    const reminderIdx = prompt.indexOf('## Reminder: Audit Criteria');
    expect(reminderIdx).toBeGreaterThan(outputOnlyIdx);
    expect(prompt).toContain('Every concern you raise must map to one of these criteria.');
    // Verify criteria items appear after the reminder heading
    const tailSection = prompt.slice(reminderIdx);
    expect(tailSection).toContain('Missing or underspecified details');
    expect(tailSection).toContain('Structural integrity');
  });

  it('has all three occurrences of each criterion', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1);
    // Each criterion appears 3 times: Key Audit Criteria, Instructions, Reminder
    for (const line of AUDIT_CRITERIA_LINES) {
      const count = prompt.split(line).length - 1;
      expect(count).toBe(3);
    }
  });

  it('criteria repetition works for hasTools: false', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1, undefined, { hasTools: false });
    const keyCriteriaIdx = prompt.indexOf('## Key Audit Criteria');
    const planToAuditIdx = prompt.indexOf('## Plan to Audit');
    const reminderIdx = prompt.indexOf('## Reminder: Audit Criteria');
    const outputOnlyIdx = prompt.indexOf('Output only the JSON block');

    expect(keyCriteriaIdx).toBeGreaterThan(-1);
    expect(keyCriteriaIdx).toBeLessThan(planToAuditIdx);
    expect(reminderIdx).toBeGreaterThan(outputOnlyIdx);
    expect(prompt).toContain('Every concern you raise must map to one of these criteria.');

    for (const line of AUDIT_CRITERIA_LINES) {
      const count = prompt.split(line).length - 1;
      expect(count).toBe(3);
    }
  });

  it('criteria repetition works for hasTools: true', () => {
    const prompt = buildAuditorPrompt('# Plan: Test', 1, undefined, { hasTools: true });
    const keyCriteriaIdx = prompt.indexOf('## Key Audit Criteria');
    const reminderIdx = prompt.indexOf('## Reminder: Audit Criteria');

    expect(keyCriteriaIdx).toBeGreaterThan(-1);
    expect(reminderIdx).toBeGreaterThan(-1);

    for (const line of AUDIT_CRITERIA_LINES) {
      const count = prompt.split(line).length - 1;
      expect(count).toBe(3);
    }
  });

  it('strips raw audit log content and includes summarized prior concerns', () => {
    const plan = [
      '# Plan: Test',
      '',
      '**ID:** plan-123',
      '**Task:** ws-123',
      '**Created:** 2026-03-09',
      '**Status:** REVIEW',
      '**Project:** discoclaw',
      '',
      '---',
      '',
      '## Objective',
      '',
      'Do the thing.',
      '',
      '## Scope',
      '',
      'Keep it tight.',
      '',
      '## Changes',
      '',
      '#### `src/test.ts`',
      'Update behavior.',
      '',
      '## Risks',
      '',
      'Some risk.',
      '',
      '## Testing',
      '',
      'One test.',
      '',
      '---',
      '',
      '## Audit Log',
      '',
      '### Review 1 — 2026-03-09',
      '**Status:** COMPLETE',
      '',
      '**Concern 1: Old blocker**',
      'Old audit detail that should not be re-injected verbatim.',
      '**Severity: blocking**',
      '',
      '---',
      '',
      '## Implementation Notes',
      '',
      '_Filled in during/after implementation._',
    ].join('\n');

    const prompt = buildAuditorPrompt(plan, 2);
    expect(prompt).toContain('Summary of prior reviews:');
    expect(prompt).toContain('Review 1: Old blocker [blocking]');
    expect(prompt).not.toContain('Old audit detail that should not be re-injected verbatim.');
    expect(prompt).toContain('Prefer the smallest correct unblocker');
    expect(prompt).toContain('Report at most 3 blocking concerns');
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

  it('requires revisions to name concrete enforcement mechanisms for restriction claims', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).toContain('If you keep or add a restriction claim');
    expect(prompt).toContain('rewrite it to name the exact enforcement mechanism');
  });

  it('routes durable lesson work through the compound lessons artifact during revision', () => {
    const prompt = buildRevisionPrompt('# Plan: Test', 'Concern 1: bad', 'Add feature');
    expect(prompt).toContain('docs/compound-lessons.md');
    expect(prompt).toContain('single checked-in durable artifact');
    expect(prompt).toContain('format, ownership, update rules, and mandatory review gate');
    expect(prompt).toContain('search/dedup expectations');
    expect(prompt).toContain('explicit promotion decision');
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

  it('keeps raw audit log prose out of the revision prompt', () => {
    const plan = [
      '# Plan: Test',
      '',
      '**ID:** plan-123',
      '**Task:** ws-123',
      '**Created:** 2026-03-09',
      '**Status:** REVIEW',
      '**Project:** discoclaw',
      '',
      '---',
      '',
      '## Objective',
      '',
      'Do the thing.',
      '',
      '## Scope',
      '',
      'Keep it tight.',
      '',
      '## Changes',
      '',
      '#### `src/test.ts`',
      'Update behavior.',
      '',
      '## Risks',
      '',
      'Some risk.',
      '',
      '## Testing',
      '',
      'One test.',
      '',
      '---',
      '',
      '## Audit Log',
      '',
      '### Review 1 — 2026-03-09',
      '**Status:** COMPLETE',
      '',
      '**Concern 1: Old blocker**',
      'Old audit detail that should not be copied forward.',
      '**Severity: blocking**',
      '',
      '---',
      '',
      '## Implementation Notes',
      '',
      '_Filled in during/after implementation._',
    ].join('\n');

    const prompt = buildRevisionPrompt(plan, 'Concern 1: bad', 'Add feature');
    expect(prompt).not.toContain('Old audit detail that should not be copied forward.');
    expect(prompt).toContain('Prefer the smallest change that resolves the blocker');
    expect(prompt).toContain('rewrite the plan to match the real guarantee');
    expect(prompt).toContain('Do not copy old audit-log prose back into the revised plan');
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

describe('ForgeOrchestrator.buildContextSummary', () => {
  it('includes the repo compound lessons content from the Lessons section onward when the file exists', async () => {
    const tmpDir = await makeTmpDir();
    const workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'docs', 'compound-lessons.md'),
      [
        '# Compound Lessons',
        '',
        'Preamble that should not be injected.',
        '',
        '## Promotion Rules',
        '',
        'Rules that should also be skipped.',
        '',
        '## Lessons',
        '',
        '### Keep prompt context grounded',
        '- Reuse prior lessons before inventing new ones.',
      ].join('\n'),
    );

    const opts = await baseOpts(tmpDir, makeMockRuntime([]), { workspaceCwd: workspaceDir });
    const orchestrator = new ForgeOrchestrator(opts);
    const summary = await (orchestrator as unknown as {
      buildContextSummary: (projectContext?: string) => Promise<string>;
    }).buildContextSummary();

    expect(summary).toContain('--- compound-lessons.md (repo) ---');
    expect(summary).toContain('## Lessons');
    expect(summary).toContain('### Keep prompt context grounded');
    expect(summary).not.toContain('Preamble that should not be injected.');
    expect(summary).not.toContain('## Promotion Rules');
  });

  it('skips compound lessons cleanly when the file is missing', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([]));
    const orchestrator = new ForgeOrchestrator(opts);
    const summary = await (orchestrator as unknown as {
      buildContextSummary: (projectContext?: string) => Promise<string>;
    }).buildContextSummary();

    expect(summary).not.toContain('--- compound-lessons.md (repo) ---');
    expect(summary).not.toContain('## Lessons');
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

  it('wires env heartbeat policy into forge heartbeat controller', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = makePlanContent({ planId: 'plan-test-001', status: 'DRAFT' });
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { planForgeHeartbeatIntervalMs: 12_000 });
    const heartbeat = await import('./phase-status-heartbeat.js');
    const createHeartbeatSpy = vi.spyOn(heartbeat, 'createPhaseStatusHeartbeatController');
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(createHeartbeatSpy).toHaveBeenCalledWith(expect.objectContaining({
      policy: expect.objectContaining({ enabled: true, intervalMs: 12_000 }),
    }));
    createHeartbeatSpy.mockRestore();
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
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
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
    expect([
      'loop-entry',
      'draft_research',
      'draft_artifact',
      'audit',
      'revision_research',
      'revision_artifact',
    ]).toContain(lastCancelled[0].phase);
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

  it('cancel during draft phase logs a draft_* phase', async () => {
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
          yield { type: 'done' };
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
    expect(cancelledCalls[0]![0].phase).toMatch(/^draft/);
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
          yield { type: 'done' };
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
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

  it('does not append repo .context/tools.md to forge prompts', async () => {
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.run('Test', async () => {});

    // Forge prompts should rely on tracked TOOLS.md + optional workspace overrides,
    // not a second repo-owned tools layer from .context/tools.md.
    expect(prompts[0]).not.toContain('Browser escalation: WebFetch');
    expect(prompts[0]).not.toContain('tools.md (repo)');
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.run('Test', async () => {});

    const drafterPrompt = prompts[0] ?? '';
    expect(drafterPrompt).toContain('--- SYSTEM_DEFAULTS.md (tracked defaults) ---');
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
        const text = ensureConcretePlanPath(responses[invocations.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
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

  it('does not update bead title when the plan title line is empty and the next heading is ## Objective', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan:

**ID:** plan-test-001
**Task:** task-test-001
**Created:** 2026-01-01
**Status:** DRAFT
**Project:** discoclaw

---

## Objective

Build it.

## Scope

## Changes

## Risks

## Testing

---

## Audit Log

---

## Implementation Notes

_Filled in during/after implementation._
`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const updateSpy = vi.spyOn(opts.taskStore, 'update');
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does not update bead title when the plan title itself is a markdown heading', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: ## Objective

**ID:** plan-test-001
**Task:** task-test-001
**Created:** 2026-01-01
**Status:** DRAFT
**Project:** discoclaw

---

## Objective

Build it.

## Scope

## Changes

## Risks

## Testing

---

## Audit Log

---

## Implementation Notes

_Filled in during/after implementation._
`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const updateSpy = vi.spyOn(opts.taskStore, 'update');
    const orchestrator = new ForgeOrchestrator(opts);

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
          yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
          yield { type: 'done' };
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

  it('filters leading narration before # Plan: and completes draft without retry', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const steerCalls: Array<{ sessionKey: string; message: string }> = [];
    const systemPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        systemPrompts.push(params.systemPrompt ?? '');
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_delta', text: 'Inspecting the forge routing first.' };
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
      async steer(sessionKey: string, message: string) {
        steerCalls.push({ sessionKey, message });
        return true;
      },
    };

    const opts = await baseOpts(
      tmpDir,
      wrapRuntimeWithGlobalPolicies({
        runtime,
        maxConcurrentInvocations: 3,
        globalSupervisorEnabled: true,
        env: { DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED: '1' } as NodeJS.ProcessEnv,
      }),
    );
    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];

    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(2);
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0]?.sessionKey).toContain('forge:plan-');
    expect(steerCalls[0]?.message).toContain('Restart your answer now.');
    expect(systemPrompts[0]).toContain('Use tools silently when needed');
    expect(progress.some((p) => p.includes('retrying'))).toBe(false);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('omits the forge plan system prompt for codex draft and revision turns', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const revisedPlan = `# Plan: Test feature revised\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something better.\n\n## Scope\n\n## Changes\n\n- \`src/foo.ts\` — refine the implementation.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Add coverage.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const systemPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        systemPrompts.push(params.systemPrompt ?? '');
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: auditBlocking };
            yield { type: 'done' };
            return;
          }
          if (idx === 2) {
            yield { type: 'text_final', text: ensureConcretePlanPath(revisedPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(4);
    expect(systemPrompts[0]).toBe('');
    expect(systemPrompts[1]).toBe('');
    expect(systemPrompts[2]).toBe('');
    expect(systemPrompts[3]).toBe('');
  });

  it('steers silent tool-only draft turns before the native no-text stall window', async () => {
    vi.useFakeTimers();
    try {
      const tmpDir = await makeTmpDir();
      const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
      const auditClean = '**Verdict:** Ready to approve.';

      let callIndex = 0;
      let releaseDraft: (() => void) | undefined;
      let signalDraftInvokeStarted: (() => void) | undefined;
      const draftInvokeStarted = new Promise<void>((resolve) => {
        signalDraftInvokeStarted = resolve;
      });
      const draftReleased = new Promise<void>((resolve) => {
        releaseDraft = resolve;
      });
      const steerCalls: Array<{ sessionKey: string; message: string }> = [];

      const runtime: RuntimeAdapter = {
        id: 'codex' as const,
        capabilities: new Set(['streaming_text' as const, 'sessions' as const]),
        invoke(_params: RuntimeInvokeParams) {
          const idx = callIndex++;
          if (idx === 0) {
            signalDraftInvokeStarted?.();
          }
          return (async function* (): AsyncGenerator<EngineEvent> {
            if (idx === 0) {
              yield {
                type: 'tool_start',
                name: 'command_execution',
                input: { command: 'rg -n "forge"' },
              };
              await draftReleased;
              yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
              yield { type: 'done' };
              return;
            }
            yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
            yield { type: 'done' };
          })();
        },
        async steer(sessionKey: string, message: string) {
          steerCalls.push({ sessionKey, message });
          releaseDraft?.();
          return true;
        },
      };

      const opts = await baseOpts(tmpDir, runtime, { timeoutMs: 120_000 });
      const orchestrator = new ForgeOrchestrator(opts);
      const progress: string[] = [];

      const runPromise = orchestrator.run('Test feature', async (msg) => {
        progress.push(msg);
      });

      await draftInvokeStarted;
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await runPromise;

      expect(result.error).toBeUndefined();
      expect(callIndex).toBe(2);
      expect(steerCalls).toHaveLength(1);
      expect(steerCalls[0]?.sessionKey).toContain('forge:plan-');
      expect(steerCalls[0]?.message).toContain('Stop using tools once you have enough context.');
      expect(progress.some((p) => p.includes('retrying'))).toBe(false);
      expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries draft phase with a fresh session when output never reaches # Plan:', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const prompts: string[] = [];
    const sessionKeys: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        prompts.push(params.prompt);
        sessionKeys.push(params.sessionKey ?? '');
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_delta', text: 'Inspecting the forge routing first.' };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(
      tmpDir,
      wrapRuntimeWithGlobalPolicies({
        runtime,
        maxConcurrentInvocations: 3,
        globalSupervisorEnabled: true,
        env: { DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED: '1' } as NodeJS.ProcessEnv,
      }),
    );
    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];

    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(3);
    expect(prompts[1]).toContain('Your previous attempt started with narration');
    expect(prompts[1]).toContain('The very first line of your response MUST begin with `# Plan:`.');
    expect(sessionKeys[0]).not.toBe('');
    expect(sessionKeys[1]).toBe(`${sessionKeys[0]}:draft-retry`);
    expect(progress.some((p) => p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('drops tools on plan retry after a native no-text progress stall', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const prompts: string[] = [];
    const sessionKeys: Array<string | undefined> = [];
    const toolsSeen: Array<string[] | undefined> = [];
    const addDirsSeen: Array<string[] | undefined> = [];
    const nativeBypassSeen: Array<boolean | undefined> = [];
    const systemPrompts: string[] = [];
    const supervisors: Array<RuntimeInvokeParams['supervisor']> = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        prompts.push(params.prompt);
        sessionKeys.push(params.sessionKey ?? undefined);
        toolsSeen.push(params.tools);
        addDirsSeen.push(params.addDirs);
        nativeBypassSeen.push(params.disableNativeAppServer);
        systemPrompts.push(params.systemPrompt ?? '');
        supervisors.push(params.supervisor);
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield {
              type: 'error',
              message: 'progress stall: no runtime progress for 180000ms (native turn produced no text output)',
            };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];

    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(3);
    expect(toolsSeen[0]).toEqual(['Read', 'Glob', 'Grep']);
    expect(addDirsSeen[0]).toEqual([tmpDir]);
    expect(toolsSeen[1]).toBeUndefined();
    expect(addDirsSeen[1]).toBeUndefined();
    expect(nativeBypassSeen[1]).toBe(true);
    expect(sessionKeys[1]).toBeUndefined();
    expect(supervisors[1]).toEqual(expect.objectContaining({
      limits: expect.objectContaining({ maxCycles: 2, maxRetries: 1 }),
    }));
    expect(prompts[1]).toContain('Do NOT use tools on this retry.');
    expect(prompts[1]).toContain('You are salvaging a stalled plan draft.');
    expect(prompts[1]).not.toContain('Read the codebase using your tools (Read, Glob, Grep) first');
    expect(prompts[1]).not.toContain('## Project Context');
    expect(systemPrompts[1]).toContain('Do not use tools on this retry.');
    expect(progress.some((p) => p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
  });

  it('drops tools on codex retry after the draft prefix guard rejects leading narration', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const prompts: string[] = [];
    const sessionKeys: Array<string | undefined> = [];
    const toolsSeen: Array<string[] | undefined> = [];
    const addDirsSeen: Array<string[] | undefined> = [];
    const nativeBypassSeen: Array<boolean | undefined> = [];
    const systemPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        prompts.push(params.prompt);
        sessionKeys.push(params.sessionKey ?? undefined);
        toolsSeen.push(params.tools);
        addDirsSeen.push(params.addDirs);
        nativeBypassSeen.push(params.disableNativeAppServer);
        systemPrompts.push(params.systemPrompt ?? '');
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_delta', text: 'I am reading the repo first.' };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(3);
    expect(systemPrompts[0]).toBe('');
    expect(toolsSeen[0]).toEqual(['Read', 'Glob', 'Grep']);
    expect(addDirsSeen[0]).toEqual([tmpDir]);
    expect(toolsSeen[1]).toBeUndefined();
    expect(addDirsSeen[1]).toBeUndefined();
    expect(nativeBypassSeen[1]).toBe(true);
    expect(sessionKeys[1]).toBeUndefined();
    expect(prompts[1]).toContain('Do NOT use tools on this retry.');
    expect(prompts[1]).toContain('You are salvaging a stalled plan draft.');
    expect(systemPrompts[1]).toContain('Do not use tools on this retry.');
  });

  it('retries draft research in a fresh bounded session before the artifact turn', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    const groundedPaths = [
      '`src/discord/forge-commands.ts`',
      '`src/runtime/codex-app-server.ts`',
    ].join('\n');
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const prompts: string[] = [];
    const sessionKeys: Array<string | undefined> = [];
    const toolsSeen: Array<string[] | undefined> = [];
    const addDirsSeen: Array<string[] | undefined> = [];
    const nativeBypassSeen: Array<boolean | undefined> = [];
    const supervisors: Array<RuntimeInvokeParams['supervisor']> = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        prompts.push(params.prompt);
        sessionKeys.push(params.sessionKey ?? undefined);
        toolsSeen.push(params.tools);
        addDirsSeen.push(params.addDirs);
        nativeBypassSeen.push(params.disableNativeAppServer);
        supervisors.push(params.supervisor);
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_delta', text: 'I’m locating the forge auditor and Codex app-server wiring, then' };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: groundedPaths };
            yield { type: 'done' };
            return;
          }
          if (idx === 2) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(
      tmpDir,
      wrapRuntimeWithGlobalPolicies({
        runtime,
        maxConcurrentInvocations: 3,
        globalSupervisorEnabled: true,
        env: { DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED: '1' } as NodeJS.ProcessEnv,
      }),
    );
    const orchestrator = new ForgeOrchestrator(opts);
    const progress: string[] = [];

    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(4);
    expect(supervisors[0]).toEqual(expect.objectContaining({
      limits: expect.objectContaining({
        maxCycles: 1,
        maxRetries: 0,
      }),
    }));
    if (prompts[0]!.includes('## Candidate File Paths')) {
      expect(prompts[0]).toContain('`src/discord/forge-commands.ts`');
      expect(toolsSeen[0]).toEqual([]);
      expect(addDirsSeen[0]).toBeUndefined();
    } else {
      expect(prompts[0]).toContain('You are gathering only the concrete repo file paths needed for a later plan-writing turn.');
      expect(toolsSeen[0]).toEqual(['Read', 'Glob', 'Grep']);
      expect(addDirsSeen[0]).toEqual([tmpDir]);
    }
    expect(sessionKeys[0]).toMatch(/^forge:plan-\d+:test-model:drafter$/);
    expect(sessionKeys[1]).toBe(`${sessionKeys[0]}:draft-research-retry`);
    expect(supervisors[1]).toEqual(expect.objectContaining({
      limits: expect.objectContaining({ maxCycles: 1, maxRetries: 0 }),
    }));
    expect(nativeBypassSeen[0]).toBeUndefined();
    expect(nativeBypassSeen[1]).toBeUndefined();
    expect(prompts[1]).toContain('repo-relative file paths');
    expect(prompts[2]).toContain('## Grounded Repo Inputs');
    expect(toolsSeen[2]).toEqual([]);
    expect(addDirsSeen[2]).toBeUndefined();
    expect(nativeBypassSeen[2]).toBe(true);
    expect(sessionKeys[2]).toBe(sessionKeys[0]);
    expect(sessionKeys[3]).toMatch(/^forge:plan-\d+:test-model:auditor$/);
    expect(nativeBypassSeen[3]).toBeUndefined();
    expect(progress.some((p) => p.includes('retrying'))).toBe(true);
  });

  it('uses fresh sessionless salvage retries so revision fallback does not resume the draft retry thread', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const sessionKeys: Array<string | undefined> = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        sessionKeys.push(params.sessionKey ?? undefined);
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0 || idx === 3) {
            yield {
              type: 'error',
              message: 'progress stall: no runtime progress for 180000ms (native turn produced no text output)',
            };
            return;
          }
          if (idx === 1 || idx === 4) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: idx === 2 ? auditBlocking : auditClean };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(6);
    expect(sessionKeys[0]).toMatch(/^forge:plan-\d+:test-model:drafter$/);
    expect(sessionKeys[1]).toBeUndefined();
    expect(sessionKeys[2]).toMatch(/^forge:plan-\d+:test-model:auditor$/);
    expect(sessionKeys[3]).toBe(sessionKeys[0]);
    expect(sessionKeys[4]).toBeUndefined();
    expect(sessionKeys[1]).toBe(sessionKeys[4]);
    expect(sessionKeys[5]).toBe(sessionKeys[2]);
  });

  it('uses a compact no-tools prompt when revision salvage retries after a native no-text stall', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const revisedPlan = `# Plan: Test feature revised\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something better.\n\n## Scope\n\n## Changes\n\n- \`src/foo.ts\` — refine the implementation.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Add coverage.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Issue**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const prompts: string[] = [];
    const sessionKeys: Array<string | undefined> = [];
    const toolsSeen: Array<string[] | undefined> = [];
    const addDirsSeen: Array<string[] | undefined> = [];
    const nativeBypassSeen: Array<boolean | undefined> = [];
    const systemPrompts: string[] = [];
    const supervisors: Array<RuntimeInvokeParams['supervisor']> = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params: RuntimeInvokeParams) {
        const idx = callIndex++;
        prompts.push(params.prompt);
        sessionKeys.push(params.sessionKey ?? undefined);
        toolsSeen.push(params.tools);
        addDirsSeen.push(params.addDirs);
        nativeBypassSeen.push(params.disableNativeAppServer);
        systemPrompts.push(params.systemPrompt ?? '');
        supervisors.push(params.supervisor);
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'text_final', text: auditBlocking };
            yield { type: 'done' };
            return;
          }
          if (idx === 2) {
            yield {
              type: 'error',
              message: 'progress stall: no runtime progress for 180000ms (native turn produced no text output)',
            };
            return;
          }
          if (idx === 3) {
            yield { type: 'text_final', text: ensureConcretePlanPath(revisedPlan) };
            yield { type: 'done' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(5);
    expect(toolsSeen[2]).toEqual(['Read', 'Glob', 'Grep']);
    expect(addDirsSeen[2]).toEqual([tmpDir]);
    expect(toolsSeen[3]).toBeUndefined();
    expect(addDirsSeen[3]).toBeUndefined();
    expect(nativeBypassSeen[3]).toBe(true);
    expect(sessionKeys[3]).toBeUndefined();
    expect(supervisors[3]).toEqual(expect.objectContaining({
      limits: expect.objectContaining({ maxCycles: 2, maxRetries: 1 }),
    }));
    expect(prompts[3]).toContain('You are salvaging a stalled plan revision.');
    expect(prompts[3]).toContain('Do NOT use tools on this retry. Revise from the provided plan and audit feedback only.');
    expect(prompts[3]).toContain('The first line of your answer must be `# Plan: <title>`');
    expect(prompts[3]).not.toContain('## Project Context');
    expect(prompts[3]).not.toContain('Read the codebase using your tools if needed to resolve concerns.');
    expect(systemPrompts[3]).toContain('Do not use tools on this retry.');
  });

  it('emits a diagnostic event before failing the plan prefix contract', async () => {
    const tmpDir = await makeTmpDir();
    const invalidLead = 'I checked the repo and here is the plan summary before the artifact starts. '
      + 'This should trigger the prefix guard once it runs long enough.';
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'sessions' as const]),
      invoke() {
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_delta', text: invalidLead };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);
    const events: EngineEvent[] = [];

    const result = await orchestrator.run(
      'Test feature',
      async () => {},
      undefined,
      (evt) => {
        events.push(evt);
      },
    );

    expect(result.error).toContain('draft output must start with # Plan:');
    const diagnostic = events.find((evt) =>
      evt.type === 'log_line'
      && evt.stream === 'stderr'
      && evt.line.includes('"source":"forge_plan_prefix_guard"'),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toMatchObject({
      type: 'log_line',
      stream: 'stderr',
    });
    const payload = JSON.parse((diagnostic as Extract<EngineEvent, { type: 'log_line' }>).line) as Record<string, unknown>;
    expect(payload.source).toBe('forge_plan_prefix_guard');
    expect(payload.phase).toBe('draft');
    expect(payload.reason).toBe('invalid_leading_text');
    expect(payload.preview).toContain('I checked the repo');
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

  it('retries forge draft once on native Codex app-server disconnects', async () => {
    const tmpDir = await makeTmpDir();
    let callCount = 0;
    const draftPlan = '# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n';
    const auditClean = '**Verdict:** Ready to approve.';
    const runtime: RuntimeAdapter = {
      id: 'claude_code' as const,
      capabilities: new Set(['streaming_text' as const]),
      invoke(_params) {
        callCount++;
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (callCount === 1) {
            yield { type: 'error', message: 'codex app-server websocket closed' };
            yield { type: 'done' };
            return;
          }
          yield {
            type: 'text_final',
            text: ensureConcretePlanPath(callCount === 2 ? draftPlan : auditClean),
          };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const progress: string[] = [];
    const result = await orchestrator.run('Test feature', async (msg) => {
      progress.push(msg);
    });

    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1);
    expect(callCount).toBe(3);
    expect(progress.some((p) => p.includes('Draft') && p.includes('retrying'))).toBe(true);
    expect(progress.some((p) => p.includes('Forge complete'))).toBe(true);
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
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
        const text = ensureConcretePlanPath(responses[prompts.length - 1] ?? '(no response)');
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
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

function makePlanContent(overrides: { status?: string; title?: string; planId?: string; reviews?: number; includeChanges?: boolean; heartbeat?: string } = {}): string {
  const status = overrides.status ?? 'REVIEW';
  const title = overrides.title ?? 'Test Plan';
  const planId = overrides.planId ?? 'plan-001';
  const includeChanges = overrides.includeChanges ?? true;
  const reviews = overrides.reviews ?? 0;
  const heartbeat = overrides.heartbeat;

  const lines = [
    `# Plan: ${title}`,
    '',
    `**ID:** ${planId}`,
    `**Task:** ws-test-001`,
    `**Created:** 2026-01-01`,
    `**Status:** ${status}`,
    `**Project:** discoclaw`,
    ...(heartbeat !== undefined ? [`**Heartbeat:** ${heartbeat}`] : []),
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
  it('loads an existing REVIEW plan and runs the audit loop without drafting again', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([
      // Only audit output — no draft call
      '**Verdict:** Ready to approve.',
    ]));
    seedResumeMetadata('plan-001');

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

  it('loads an existing DRAFT plan and enters the audit loop without re-drafting it', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(tmpDir, makeMockRuntime([
      '**Verdict:** Ready to approve.',
    ]));
    seedResumeMetadata('plan-001');

    const planContent = makePlanContent({ planId: 'plan-001', status: 'DRAFT' });
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
    expect(progress.some((p) => p.includes('Audit round 1'))).toBe(true);
    expect(progress.some((p) => p.includes('Drafting'))).toBe(false);
  });

  it('wires per-plan Heartbeat metadata into resumed forge heartbeat controller', async () => {
    const tmpDir = await makeTmpDir();
    const opts = await baseOpts(
      tmpDir,
      makeMockRuntime(['**Verdict:** Ready to approve.']),
      { planForgeHeartbeatIntervalMs: 12_000 },
    );
    seedResumeMetadata('plan-001');
    const heartbeat = await import('./phase-status-heartbeat.js');
    const createHeartbeatSpy = vi.spyOn(heartbeat, 'createPhaseStatusHeartbeatController');

    const planContent = makePlanContent({ planId: 'plan-001', status: 'REVIEW', heartbeat: 'off' });
    const filePath = path.join(opts.plansDir, 'plan-001-test.md');
    await fs.writeFile(filePath, planContent, 'utf-8');

    const orchestrator = new ForgeOrchestrator(opts);
    await orchestrator.resume('plan-001', filePath, 'Test Plan', async () => {});

    expect(createHeartbeatSpy).toHaveBeenCalledWith(expect.objectContaining({
      policy: expect.objectContaining({ enabled: false, intervalMs: 12_000 }),
    }));
    createHeartbeatSpy.mockRestore();
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
    seedResumeMetadata('plan-001');

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
    seedResumeMetadata('plan-001');

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
    seedResumeMetadata('plan-001');

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
    seedResumeMetadata('plan-001');

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
      const text = ensureConcretePlanPath(responses[callIndex] ?? '(no response)');
      callIndex++;
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text };
        yield { type: 'done' };
      })();
    },
  };
  return { runtime, invocations };
}

describe('Forge session keys', () => {
  it('uses a two-stage native Codex draft flow with shared drafter session state', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    await seedCodexNativeWriteContextFiles(tmpDir);
    const groundedPaths = [
      '`src/discord/forge-commands.ts`',
      '`src/runtime/codex-app-server.ts`',
    ].join('\n');
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — confirm native turn behavior.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke(params) {
        invocations.push(params);
        const text = invocations.length === 1
          ? groundedPaths
          : invocations.length === 2
            ? draftPlan
            : auditClean;
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(invocations).toHaveLength(3);
    if (invocations[0]!.prompt.includes('## Candidate File Paths')) {
      expect(invocations[0]!.prompt).toContain('Choose the 1-5 most relevant repo-relative file paths from the candidate list only.');
      expect(invocations[0]!.prompt).toContain('`src/discord/forge-commands.ts`');
      expect(invocations[0]!.tools).toEqual([]);
      expect(invocations[0]!.addDirs).toBeUndefined();
    } else {
      expect(invocations[0]!.prompt).toContain('You are gathering only the concrete repo file paths needed for a later plan-writing turn.');
      expect(invocations[0]!.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(invocations[0]!.addDirs).toEqual([tmpDir]);
    }
    expect(invocations[1]!.prompt).toContain('## Grounded Repo Inputs');
    expect(invocations[1]!.prompt).toContain('`src/discord/forge-commands.ts`');
    expect(invocations[1]!.prompt).not.toContain(ROOT_POLICY.slice(0, 80));
    expect(invocations[1]!.prompt).not.toContain(TRACKED_DEFAULTS_PREAMBLE.slice(0, 80));
    expect(invocations[1]!.prompt).toContain('codex native soul context');
    expect(invocations[1]!.prompt).toContain('codex native identity context');
    expect(invocations[1]!.prompt).toContain('codex native user context');
    expect(invocations[1]!.prompt).toContain('codex native tools context');
    expect(invocations[1]!.prompt).not.toContain('codex native agents context');
    expect(invocations[1]!.prompt).not.toContain('codex native project context');
    expect(invocations[1]!.prompt).not.toContain('codex native compound lesson');
    expect(invocations[1]!.tools).toEqual([]);
    expect(invocations[1]!.addDirs).toBeUndefined();
    expect(invocations[1]!.sessionKey).toBe(invocations[0]!.sessionKey);
    expect(invocations[2]!.sessionKey).toContain(':auditor');
    expect(invocations[2]!.sessionKey).not.toBe(invocations[0]!.sessionKey);
    expect(invocations[0]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[1]!.disableNativeAppServer).toBe(true);
    expect(invocations[2]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[0]!.systemPrompt).toBeUndefined();
    expect(invocations[1]!.systemPrompt).toBeUndefined();
  });

  it('routes codex-like wrapped runtimes by forge phase', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    await seedCodexNativeWriteContextFiles(tmpDir);
    const groundedPaths = [
      '`src/discord/forge-commands.ts`',
      '`src/runtime/codex-app-server.ts`',
    ].join('\n');
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — confirm native turn behavior.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other' as const,
      capabilities: new Set([
        'streaming_text' as const,
        'tools_fs' as const,
        'tools_exec' as const,
        'tools_web' as const,
        'sessions' as const,
        'workspace_instructions' as const,
        'mcp' as const,
        'mid_turn_steering' as const,
      ]),
      invoke(params) {
        invocations.push(params);
        const text = invocations.length === 1
          ? groundedPaths
          : invocations.length === 2
            ? draftPlan
            : auditClean;
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(invocations).toHaveLength(3);
    if (invocations[0]!.prompt.includes('## Candidate File Paths')) {
      expect(invocations[0]!.prompt).toContain('Choose the 1-5 most relevant repo-relative file paths from the candidate list only.');
      expect(invocations[0]!.prompt).toContain('`src/discord/forge-commands.ts`');
      expect(invocations[0]!.tools).toEqual([]);
      expect(invocations[0]!.addDirs).toBeUndefined();
    } else {
      expect(invocations[0]!.prompt).toContain('You are gathering only the concrete repo file paths needed for a later plan-writing turn.');
      expect(invocations[0]!.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(invocations[0]!.addDirs).toEqual([tmpDir]);
    }
    expect(invocations[1]!.prompt).toContain('## Grounded Repo Inputs');
    expect(invocations[2]!.sessionKey).toContain(':auditor');
    expect(invocations[0]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[1]!.disableNativeAppServer).toBe(true);
    expect(invocations[2]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[0]!.systemPrompt).toBeUndefined();
    expect(invocations[1]!.systemPrompt).toBeUndefined();
  });

  it('fails closed when bounded draft research deviates from the grounded path contract', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);

    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke(params) {
        invocations.push(params);
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text: '`src/not-in-candidates.ts`' };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeDefined();
    expect(
      result.error?.includes('outside the bounded candidate allowlist')
      || result.error?.includes('draft output must start with # Plan:'),
    ).toBe(true);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps audit retries on the audit phase route instead of escalating to CLI salvage', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';
    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const]),
      invoke(params) {
        invocations.push(params);
        const idx = invocations.length - 1;
        return (async function* (): AsyncGenerator<EngineEvent> {
          if (idx === 0) {
            yield { type: 'text_final', text: ensureConcretePlanPath(draftPlan) };
            yield { type: 'done' };
            return;
          }
          if (idx === 1) {
            yield { type: 'error', message: 'timed out waiting for audit response' };
            return;
          }
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(invocations).toHaveLength(3);
    expect(invocations[0]!.disableNativeAppServer).toBe(true);
    expect(invocations[1]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[2]!.disableNativeAppServer).toBeUndefined();
  });

  it('prioritizes src candidates ahead of noisy script and env files for Codex draft grounding', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'scripts', 'forge-native-repro.ts'), 'console.log("forge native repro");\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env.example'), 'CODEX_APP_SERVER_URL=ws://127.0.0.1:4321\n', 'utf8');

    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke(params) {
        invocations.push(params);
        const text = invocations.length === 1
          ? '`src/runtime/codex-app-server.ts`\n`src/discord/forge-commands.ts`'
          : invocations.length === 2
            ? `# Plan: Restore forge auditor to Codex after ws-1222\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nRestore the forge auditor.\n\n## Scope\n\n## Changes\n\n- \`src/runtime/codex-app-server.ts\` — adjust native handling.\n- \`src/discord/forge-commands.ts\` — refine forge routing.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`
            : '**Verdict:** Ready to approve.';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Restore forge auditor to Codex after ws-1222', async () => {});

    expect(result.error).toBeUndefined();
    const candidatePrompt = invocations[0]!.prompt;
    if (candidatePrompt.includes('## Candidate File Paths')) {
      expect(candidatePrompt.indexOf('`src/runtime/codex-app-server.ts`')).toBeGreaterThan(-1);
      expect(candidatePrompt.indexOf('`src/discord/forge-commands.ts`')).toBeGreaterThan(-1);
      expect(candidatePrompt.indexOf('`scripts/forge-native-repro.ts`')).toBeGreaterThan(-1);
      expect(candidatePrompt.indexOf('`.env.example`')).toBeGreaterThan(-1);
      expect(candidatePrompt.indexOf('`src/runtime/codex-app-server.ts`'))
        .toBeLessThan(candidatePrompt.indexOf('`scripts/forge-native-repro.ts`'));
      expect(candidatePrompt.indexOf('`src/discord/forge-commands.ts`'))
        .toBeLessThan(candidatePrompt.indexOf('`.env.example`'));
      expect(invocations[0]!.tools).toEqual([]);
      expect(invocations[0]!.addDirs).toBeUndefined();
    } else {
      expect(candidatePrompt).toContain('You are gathering only the concrete repo file paths needed for a later plan-writing turn.');
      expect(invocations[0]!.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(invocations[0]!.addDirs).toEqual([tmpDir]);
    }
  });

  it('uses a two-stage native Codex revision flow with shared drafter session state', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    await seedCodexNativeWriteContextFiles(tmpDir);
    const groundedDraftPaths = [
      '`src/discord/forge-commands.ts`',
      '`src/runtime/codex-app-server.ts`',
    ].join('\n');
    const groundedRevisionPaths = 'NONE';
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — confirm native turn behavior.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const revisedPlan = `# Plan: Test feature revised\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing better.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — document native turn behavior assumptions.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const invocations: RuntimeInvokeParams[] = [];
    const responses = [
      groundedDraftPaths,
      draftPlan,
      auditBlocking,
      groundedRevisionPaths,
      revisedPlan,
      auditClean,
    ];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke(params) {
        invocations.push(params);
        const text = responses[invocations.length - 1] ?? '(missing response)';
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(invocations).toHaveLength(6);
    expect(invocations[0]!.sessionKey).toContain(':drafter');
    expect(invocations[1]!.sessionKey).toBe(invocations[0]!.sessionKey);
    expect(invocations[2]!.sessionKey).toContain(':auditor');
    expect(invocations[3]!.sessionKey).toBe(invocations[0]!.sessionKey);
    expect(invocations[4]!.sessionKey).toBe(invocations[0]!.sessionKey);
    expect(invocations[5]!.sessionKey).toBe(invocations[2]!.sessionKey);
    expect(invocations[3]!.prompt).toContain('## Candidate File Paths');
    expect(invocations[3]!.prompt).toContain('Reply with `NONE` exactly if no additional repo-relative file paths are needed.');
    expect(invocations[3]!.tools).toEqual([]);
    expect(invocations[3]!.addDirs).toBeUndefined();
    expect(invocations[4]!.prompt).toContain('## Existing Plan File Paths');
    expect(invocations[4]!.prompt).toContain('`src/discord/forge-commands.ts`');
    expect(invocations[4]!.prompt).toContain('NONE');
    expect(invocations[4]!.prompt).toContain('codex native soul context');
    expect(invocations[4]!.prompt).toContain('codex native identity context');
    expect(invocations[4]!.prompt).toContain('codex native user context');
    expect(invocations[4]!.prompt).toContain('codex native tools context');
    expect(invocations[4]!.prompt).not.toContain('codex native agents context');
    expect(invocations[4]!.prompt).not.toContain('codex native project context');
    expect(invocations[4]!.prompt).not.toContain('codex native compound lesson');
    expect(invocations[4]!.tools).toEqual([]);
    expect(invocations[4]!.addDirs).toBeUndefined();
    expect(invocations[0]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[1]!.disableNativeAppServer).toBe(true);
    expect(invocations[2]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[3]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[4]!.disableNativeAppServer).toBe(true);
    expect(invocations[5]!.disableNativeAppServer).toBeUndefined();
    expect(invocations[3]!.systemPrompt).toBeUndefined();
    expect(invocations[4]!.systemPrompt).toBeUndefined();
  });

  it('steers native Codex grounding turns back to path-only output when they start narrating', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — confirm native turn behavior.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let groundingSteered = false;
    const steerMessages: string[] = [];
    const invocations: RuntimeInvokeParams[] = [];
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      steer(_sessionKey, message) {
        groundingSteered = true;
        steerMessages.push(message);
        return Promise.resolve(true);
      },
      invoke(params) {
        invocations.push(params);
        if (invocations.length === 1) {
          return (async function* (): AsyncGenerator<EngineEvent> {
            yield { type: 'text_delta', text: 'I' };
            await Promise.resolve();
            if (groundingSteered) {
              yield {
                type: 'text_delta',
                text: '`src/discord/forge-commands.ts`\n`src/runtime/codex-app-server.ts`',
              };
            }
            yield { type: 'done' };
          })();
        }

        const text = invocations.length === 2 ? draftPlan : auditClean;
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(invocations).toHaveLength(3);
    expect(steerMessages).toHaveLength(1);
    expect(steerMessages[0]).toContain('repo-relative file paths');
    expect(steerMessages[0]).toContain('Do not narrate');
  });

  it('accepts native Codex grounding output when deltas are followed by a full text_final payload', async () => {
    const tmpDir = await makeTmpDir();
    await seedCodexCandidateFiles(tmpDir);
    const groundedPaths = [
      '`src/discord/forge-commands.ts`',
      '`src/runtime/codex-app-server.ts`',
    ].join('\n');
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- \`src/discord/forge-commands.ts\` — add two-stage native draft orchestration.\n- \`src/runtime/codex-app-server.ts\` — confirm native turn behavior.\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    let callIndex = 0;
    const runtime: RuntimeAdapter = {
      id: 'codex' as const,
      capabilities: new Set(['streaming_text' as const, 'tools_fs' as const, 'sessions' as const, 'mid_turn_steering' as const]),
      invoke() {
        const idx = callIndex++;
        if (idx === 0) {
          return (async function* (): AsyncGenerator<EngineEvent> {
            yield { type: 'text_delta', text: '`src/discord/forge-commands.ts`\n' };
            yield { type: 'text_final', text: groundedPaths };
            yield { type: 'done' };
          })();
        }

        const text = idx === 1 ? draftPlan : auditClean;
        return (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'text_final', text };
          yield { type: 'done' };
        })();
      },
    };

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});

    expect(result.error).toBeUndefined();
    expect(callIndex).toBe(3);
  });

  it('applies plan-phase supervisor policy and shorter stall windows to forge prompt steps', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nBuild the thing.\n\n## Scope\n\nIn scope: everything.\n\n## Changes\n\n### File-by-file breakdown\n\n- src/foo.ts — add bar\n\n## Risks\n\n- None.\n\n## Testing\n\n- Unit tests.\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const { runtime, invocations } = makeCaptureRuntime([draftPlan, auditClean]);
    const opts = await baseOpts(tmpDir, runtime, { timeoutMs: 30_000 });
    const orchestrator = new ForgeOrchestrator(opts);

    await orchestrator.run('Test feature', async () => {});

    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.streamStallTimeoutMs).toBe(30_000);
    expect(invocations[0]!.progressStallTimeoutMs).toBe(30_000);
    expect(invocations[0]!.supervisor).toEqual({
      profile: 'plan_phase',
      treatAbortedAsRetryable: true,
      maxSignatureRepeats: 3,
      limits: {
        maxCycles: 6,
        maxRetries: 5,
        maxEscalationLevel: 4,
      },
    });
    expect(invocations[1]!.streamStallTimeoutMs).toBe(30_000);
    expect(invocations[1]!.progressStallTimeoutMs).toBe(30_000);
    expect(invocations[1]!.supervisor).toEqual(invocations[0]!.supervisor);
  });

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
    seedResumeMetadata('plan-001');

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
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
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
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
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
          yield { type: 'text_final', text: ensureConcretePlanPath(auditClean) };
          yield { type: 'done' };
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
          yield { type: 'done' };
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
          yield { type: 'done' };
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
          yield { type: 'done' };
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
          yield { type: 'done' };
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
        yield { type: 'text_final', text: ensureConcretePlanPath(entry.text) };
        yield { type: 'done' };
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
      { text: ensureConcretePlanPath(draftPlan), events: [{ type: 'text_delta', text: '# Plan:' }] },
      { text: ensureConcretePlanPath(auditClean) },
    ]);

    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const received: EngineEvent[] = [];
    await orchestrator.run('Test feature', async () => {}, undefined, (evt) => received.push(evt));

    expect(received.some((e) => e.type === 'text_delta')).toBe(true);
    expect(received.some((e) => e.type === 'text_final')).toBe(true);
  });

  it('onEvent spy receives draft events through the global supervisor wrapper', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature\n\n**ID:** plan-test-001\n**Task:** task-test-001\n**Created:** 2026-01-01\n**Status:** DRAFT\n**Project:** discoclaw\n\n---\n\n## Objective\n\nDo something.\n\n## Scope\n\n## Changes\n\n## Risks\n\n## Testing\n\n---\n\n## Audit Log\n\n---\n\n## Implementation Notes\n\n_Filled in during/after implementation._\n`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = wrapRuntimeWithGlobalPolicies({
      runtime: makeMockRuntimeWithEvents([
        { text: ensureConcretePlanPath(draftPlan), events: [{ type: 'text_delta', text: '# Plan:' }] },
        { text: ensureConcretePlanPath(auditClean) },
      ]),
      maxConcurrentInvocations: 3,
      globalSupervisorEnabled: true,
      env: { DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED: '1' } as NodeJS.ProcessEnv,
    });

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
      { text: ensureConcretePlanPath(draftPlan) },
      { text: ensureConcretePlanPath(auditClean), events: [{ type: 'text_delta', text: 'auditing...' }] },
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

describe('plan persistence during draft and revision salvage', () => {
  it('preserves template tail sections when draft output omits them', async () => {
    const tmpDir = await makeTmpDir();
    const compactDraft = `# Plan: Test feature

## Objective

Build the thing.

## Scope

In scope: everything.

## Changes

- src/foo.ts — add bar

## Risks

- None.

## Testing

- Unit tests.
`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([compactDraft, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});
    const planContent = await fs.readFile(result.filePath, 'utf-8');

    expect(planContent).toContain('**Project:** discoclaw');
    expect(planContent).toContain('\n---\n\n## Objective');
    expect(planContent).toContain('## Audit Log');
    expect(planContent).toContain('## Implementation Notes');
  });

  it('preserves existing audit history when revision output omits tail sections', async () => {
    const tmpDir = await makeTmpDir();
    const draftPlan = `# Plan: Test feature

**ID:** plan-test-001
**Task:** task-test-001
**Created:** 2026-01-01
**Status:** DRAFT
**Project:** discoclaw

---

## Objective

Build the thing.

## Scope

In scope: everything.

## Changes

- src/foo.ts — add bar

## Risks

- None.

## Testing

- Unit tests.

---

## Audit Log

---

## Implementation Notes

_Filled in during/after implementation._
`;
    const auditBlocking = '**Concern 1: Missing details**\n**Severity: blocking**\n\n**Verdict:** Needs revision.';
    const compactRevision = `# Plan: Test feature

## Objective

Build the thing better.

## Scope

In scope: everything.

## Changes

- src/foo.ts — add better bar

## Risks

- None.

## Testing

- Unit tests.
`;
    const auditClean = '**Verdict:** Ready to approve.';

    const runtime = makeMockRuntime([draftPlan, auditBlocking, compactRevision, auditClean]);
    const opts = await baseOpts(tmpDir, runtime);
    const orchestrator = new ForgeOrchestrator(opts);

    const result = await orchestrator.run('Test feature', async () => {});
    const planContent = await fs.readFile(result.filePath, 'utf-8');

    expect(planContent).toContain('## Audit Log');
    expect(planContent).toContain('## Implementation Notes');
    expect(planContent).toContain('### Review 1');
    expect(planContent).toContain('### Review 2');
  });
});
