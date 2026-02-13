import fs from 'node:fs/promises';
import path from 'node:path';
import {
  findPlanFile,
  parsePlanFileHeader,
} from './plan-commands.js';
import type { HandlePlanCommandOpts } from './plan-commands.js';
import { appendAuditRound, parseAuditVerdict } from './forge-commands.js';
import type { AuditVerdict } from './forge-commands.js';

// ---------------------------------------------------------------------------
// Structural audit checks
// ---------------------------------------------------------------------------

type AuditConcern = {
  title: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
};

const REQUIRED_SECTIONS = ['Objective', 'Scope', 'Changes', 'Risks', 'Testing'];

function auditPlanContent(content: string): AuditConcern[] {
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
    const sectionMatch = content.match(
      new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---\\s*$|$)`, 'm'),
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
  const changesMatch = content.match(/## Changes\s*\n([\s\S]*?)(?=\n## |\n---\s*$|$)/m);
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

function formatAuditNotes(concerns: AuditConcern[]): string {
  if (concerns.length === 0) {
    return 'No concerns found.\n\n**Verdict:** Ready to approve.';
  }

  const lines: string[] = [];
  for (let i = 0; i < concerns.length; i++) {
    const c = concerns[i]!;
    lines.push(`**Concern ${i + 1}: ${c.title}**`);
    lines.push(c.description);
    lines.push(`**Severity: ${c.severity}**`);
    lines.push('');
  }

  const verdict = deriveVerdict(concerns);
  const verdictText = verdict.shouldLoop ? 'Needs revision.' : 'Ready to approve.';
  lines.push(`**Verdict:** ${verdictText}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Count existing audit rounds in a plan
// ---------------------------------------------------------------------------

function countAuditRounds(content: string): number {
  const matches = content.match(/### Review \d+/g);
  return matches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Run a standalone structural audit against an existing plan's current content
 * and append a new review entry to its Audit Log section.
 *
 * This performs a file-based completeness/structure check (no runtime invocation).
 * For AI-powered audits, use `!forge audit` instead.
 */
export async function handlePlanAudit(
  planId: string,
  opts: HandlePlanCommandOpts,
): Promise<string> {
  const plansDir = path.join(opts.workspaceCwd, 'plans');

  const found = await findPlanFile(plansDir, planId);
  if (!found) return `Plan not found: ${planId}`;

  const content = await fs.readFile(found.filePath, 'utf-8');

  // Run structural audit
  const concerns = auditPlanContent(content);
  const verdict = deriveVerdict(concerns);
  const auditNotes = formatAuditNotes(concerns);

  // Determine round number
  const existingRounds = countAuditRounds(content);
  const round = existingRounds + 1;

  // Append audit entry to the plan file
  const updated = appendAuditRound(content, round, auditNotes, verdict);
  await fs.writeFile(found.filePath, updated, 'utf-8');

  // Build response
  const verdictText = verdict.shouldLoop ? 'Needs revision' : 'Ready to approve';
  const concernCount = concerns.length;
  const severitySummary = concerns.length > 0
    ? ` (${concerns.filter((c) => c.severity === 'high').length} high, ${concerns.filter((c) => c.severity === 'medium').length} medium, ${concerns.filter((c) => c.severity === 'low').length} low)`
    : '';

  return [
    `Audit complete for **${found.header.planId}** (review ${round}).`,
    `**Verdict:** ${verdictText}${severitySummary}`,
    concernCount > 0
      ? `Found ${concernCount} concern${concernCount !== 1 ? 's' : ''}. See \`!plan show ${found.header.planId}\` for details.`
      : 'No concerns found.',
  ].join('\n');
}
