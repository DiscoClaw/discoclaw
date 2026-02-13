import fs from 'node:fs/promises';
import path from 'node:path';
import {
  findPlanFile,
  parsePlanFileHeader,
} from './plan-commands.js';
import { appendAuditRound, buildAuditorPrompt, parseAuditVerdict } from './forge-commands.js';
import type { AuditVerdict } from './forge-commands.js';
import { collectRuntimeText } from './runtime-utils.js';
import type { RuntimeAdapter } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanAuditResult =
  | { ok: true; planId: string; round: number; verdict: AuditVerdict }
  | { ok: false; error: string };

export type PlanAuditOpts = {
  planId: string;
  plansDir: string;
  workspaceCwd: string;
  runtime: RuntimeAdapter;
  auditorModel: string;
  timeoutMs: number;
  acquireWriterLock: () => Promise<() => void>;
};

type AuditConcern = {
  title: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
};

// ---------------------------------------------------------------------------
// Structural audit checks (fast pre-flight gate)
// ---------------------------------------------------------------------------

const REQUIRED_SECTIONS = ['Objective', 'Scope', 'Changes', 'Risks', 'Testing'];

export function auditPlanStructure(content: string): AuditConcern[] {
  const concerns: AuditConcern[] = [];

  // Check for required sections
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^## ${section}\\b`, 'm');
    if (!pattern.test(content)) {
      concerns.push({
        title: `Missing section: ${section}`,
        description: `The plan is missing the required "## ${section}" section.`,
        severity: 'high',
      });
      continue;
    }

    // Check if the section has meaningful content (not just placeholder text)
    // Note: no 'm' flag — we need $ to match end-of-string, not end-of-line,
    // so the lazy [\s\S]*? doesn't stop at the first newline.
    const sectionMatch = content.match(
      new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`),
    );
    const body = sectionMatch?.[1]?.trim() ?? '';
    if (!body || /^_.*_$/.test(body) || body.startsWith('(') || body.length < 10) {
      concerns.push({
        title: `Empty or placeholder: ${section}`,
        description: `The "${section}" section appears to contain only placeholder text.`,
        severity: 'medium',
      });
    }
  }

  // Check for a Changes section with file paths
  const changesMatch = content.match(/## Changes\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/);
  if (changesMatch) {
    const changesBody = changesMatch[1]!.trim();
    const hasFilePaths = /`[^`]+\.[a-z]+`/.test(changesBody);
    if (changesBody.length > 10 && !hasFilePaths) {
      concerns.push({
        title: 'Changes section lacks file paths',
        description: 'The Changes section does not reference specific file paths. Plans should list concrete file-by-file changes.',
        severity: 'medium',
      });
    }
  }

  // Check plan status
  const header = parsePlanFileHeader(content);
  if (header && header.status === 'CLOSED') {
    concerns.push({
      title: 'Plan is closed',
      description: 'This plan has been closed. Auditing a closed plan is unusual.',
      severity: 'low',
    });
  }

  return concerns;
}

function deriveVerdict(concerns: AuditConcern[]): AuditVerdict {
  const hasHigh = concerns.some((c) => c.severity === 'high');
  const hasMedium = concerns.some((c) => c.severity === 'medium');

  if (hasHigh) return { maxSeverity: 'high', shouldLoop: true };
  if (hasMedium) return { maxSeverity: 'medium', shouldLoop: true };
  if (concerns.length > 0) return { maxSeverity: 'low', shouldLoop: false };
  return { maxSeverity: 'none', shouldLoop: false };
}

function formatStructuralNotes(concerns: AuditConcern[]): string {
  if (concerns.length === 0) return '';

  const lines: string[] = ['## Structural Pre-flight', ''];
  for (let i = 0; i < concerns.length; i++) {
    const c = concerns[i]!;
    lines.push(`**Concern ${i + 1}: ${c.title}**`);
    lines.push(c.description);
    lines.push(`**Severity: ${c.severity}**`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Max review number extraction (avoids duplicate round numbers)
// ---------------------------------------------------------------------------

export function maxReviewNumber(content: string): number {
  const matches = content.matchAll(/### Review (\d+)/g);
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Project context loader (inlined from ForgeOrchestrator pattern)
// ---------------------------------------------------------------------------

async function loadProjectContext(workspaceCwd: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(workspaceCwd, '.context', 'project.md'), 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Run a standalone audit against an existing plan: structural pre-flight
 * followed by an AI-powered deep review. Appends a new review entry to
 * the plan's Audit Log section.
 *
 * The writer lock is only held during the final write phase (not during
 * the AI agent call) to avoid blocking other plan operations.
 */
export async function handlePlanAudit(opts: PlanAuditOpts): Promise<PlanAuditResult> {
  // 1. Find the plan file
  const found = await findPlanFile(opts.plansDir, opts.planId);
  if (!found) return { ok: false, error: `Plan not found: ${opts.planId}` };

  const planContent = await fs.readFile(found.filePath, 'utf-8');

  // 2. Validate Audit Log section exists
  if (!planContent.includes('## Audit Log')) {
    return { ok: false, error: 'Plan file is missing an Audit Log section — cannot append audit.' };
  }

  // 3. Structural pre-flight (instant)
  const structuralConcerns = auditPlanStructure(planContent);
  const structuralVerdict = deriveVerdict(structuralConcerns);

  // If structural audit finds high/medium issues, stop — no point burning tokens
  if (structuralVerdict.shouldLoop) {
    const structuralNotes = formatStructuralNotes(structuralConcerns);
    const verdictLine = `**Verdict:** Needs revision.`;
    const fullNotes = structuralNotes + verdictLine;

    // Write under lock
    const releaseLock = await opts.acquireWriterLock();
    try {
      const freshContent = await fs.readFile(found.filePath, 'utf-8');
      const round = maxReviewNumber(freshContent) + 1;
      const updated = appendAuditRound(freshContent, round, fullNotes, structuralVerdict);
      const tmpPath = found.filePath + '.tmp';
      await fs.writeFile(tmpPath, updated, 'utf-8');
      await fs.rename(tmpPath, found.filePath);
      return { ok: true, planId: found.header.planId, round, verdict: structuralVerdict };
    } finally {
      releaseLock();
    }
  }

  // 4. Load project context for the auditor
  const projectContext = await loadProjectContext(opts.workspaceCwd);

  // 5. Determine preliminary round number (for the auditor prompt)
  const preliminaryRound = maxReviewNumber(planContent) + 1;

  // 6. Invoke AI auditor agent (outside the lock)
  let auditOutput: string;
  try {
    const auditorPrompt = buildAuditorPrompt(planContent, preliminaryRound, projectContext);
    auditOutput = await collectRuntimeText(
      opts.runtime,
      auditorPrompt,
      opts.auditorModel,
      opts.workspaceCwd,
      [], // auditor gets no tools
      [],
      opts.timeoutMs,
    );
  } catch (err) {
    return { ok: false, error: `Auditor agent failed: ${String(err instanceof Error ? err.message : err)}` };
  }

  // 7. Parse the AI verdict
  const aiVerdict = parseAuditVerdict(auditOutput);

  // 8. Combine structural notes (low-severity only, since we passed the gate) with AI output
  const structuralPrefix = formatStructuralNotes(structuralConcerns);
  const combinedNotes = structuralPrefix
    ? structuralPrefix + '## AI Audit\n\n' + auditOutput.trim()
    : auditOutput.trim();

  // The AI verdict is the one that matters (structural passed the gate)
  const finalVerdict = aiVerdict;

  // 9. Acquire lock, re-read, and write atomically
  const releaseLock = await opts.acquireWriterLock();
  try {
    const freshContent = await fs.readFile(found.filePath, 'utf-8');
    const round = maxReviewNumber(freshContent) + 1;
    const updated = appendAuditRound(freshContent, round, combinedNotes, finalVerdict);
    const tmpPath = found.filePath + '.tmp';
    await fs.writeFile(tmpPath, updated, 'utf-8');
    await fs.rename(tmpPath, found.filePath);
    return { ok: true, planId: found.header.planId, round, verdict: finalVerdict };
  } finally {
    releaseLock();
  }
}
