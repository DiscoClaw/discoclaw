import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskStore } from '../tasks/store.js';
import {
  decomposePlan,
  serializePhases,
  deserializePhases,
  getNextPhase,
  updatePhaseStatus,
  checkStaleness,
  writePhasesFile,
} from './plan-manager.js';
import type { PlanPhase, PlanPhases } from './plan-manager.js';
import type { LoggerLike } from './action-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanCommand = {
  action: 'help' | 'create' | 'list' | 'show' | 'approve' | 'close' | 'cancel' | 'phases' | 'run' | 'run-one' | 'skip' | 'audit';
  args: string;
  context?: string;
  /** When set, reuse this bead instead of creating a new one (e.g. when issued in a bead forum thread). */
  existingBeadId?: string;
};

export type PlanFileHeader = {
  planId: string;
  beadId: string;
  status: string;
  title: string;
  project: string;
  created: string;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const RESERVED_SUBCOMMANDS = new Set(['list', 'show', 'approve', 'close', 'cancel', 'help', 'phases', 'run', 'run-one', 'skip', 'audit']);

export function parsePlanCommand(content: string): PlanCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('!plan')) return null;

  const rest = trimmed.slice('!plan'.length).trim();

  // No args → help
  if (!rest) return { action: 'help', args: '' };

  // Check reserved subcommands
  const firstWord = rest.split(/\s+/)[0]!.toLowerCase();
  if (RESERVED_SUBCOMMANDS.has(firstWord)) {
    const subArgs = rest.slice(firstWord.length).trim();
    return { action: firstWord as PlanCommand['action'], args: subArgs };
  }

  // Everything else is a create description
  return { action: 'create', args: rest };
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

export function toSlug(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Plan file header parsing
// ---------------------------------------------------------------------------

export function parsePlanFileHeader(content: string): PlanFileHeader | null {
  const titleMatch = content.match(/^# Plan:\s*(.+)$/m);
  const idMatch = content.match(/^\*\*ID:\*\*\s*(.+)$/m);
  const taskMatch = content.match(/^\*\*Task:\*\*\s*(.+)$/m);
  const beadMatch = content.match(/^\*\*Bead:\*\*\s*(.+)$/m);
  const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/m);
  const projectMatch = content.match(/^\*\*Project:\*\*\s*(.+)$/m);
  const createdMatch = content.match(/^\*\*Created:\*\*\s*(.+)$/m);

  if (!idMatch) return null;

  return {
    planId: idMatch[1]!.trim(),
    beadId: taskMatch?.[1]?.trim() ?? beadMatch?.[1]?.trim() ?? '',
    status: statusMatch?.[1]?.trim() ?? '',
    title: titleMatch?.[1]?.trim() ?? '',
    project: projectMatch?.[1]?.trim() ?? '',
    created: createdMatch?.[1]?.trim() ?? '',
  };
}

// ---------------------------------------------------------------------------
// Plan file utilities
// ---------------------------------------------------------------------------

async function ensurePlansDir(plansDir: string): Promise<void> {
  await fs.mkdir(plansDir, { recursive: true });
}

async function getNextPlanNumber(plansDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(plansDir);
  } catch {
    return 1;
  }

  let max = 0;
  for (const entry of entries) {
    const match = entry.match(/^plan-(\d+)/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

/**
 * Normalize a bare number or unpadded plan-N string to canonical plan-NNN format.
 * Returns null if the input doesn't look like a plan ID reference.
 */
export function normalizePlanId(id: string): string | null {
  // Bare number: "031" or "31" → "plan-031"
  const bareNum = id.match(/^(\d+)$/);
  if (bareNum) return `plan-${bareNum[1]!.padStart(3, '0')}`;

  // Unpadded plan-N: "plan-31" → "plan-031"
  const planNum = id.match(/^plan-(\d+)$/);
  if (planNum) return `plan-${planNum[1]!.padStart(3, '0')}`;

  return null;
}

/**
 * Check if a raw string looks like a plan-ID reference (bare number or plan-N pattern).
 * Used to gate plan-ID lookups vs. new plan creation in the forge dispatch path.
 */
export function looksLikePlanId(id: string): boolean {
  return /^\d+$/.test(id) || /^plan-\d+$/.test(id);
}

export async function findPlanFile(plansDir: string, id: string): Promise<{ filePath: string; header: PlanFileHeader } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(plansDir);
  } catch {
    return null;
  }

  const normalizedId = normalizePlanId(id);

  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry.startsWith('.')) continue;
    const filePath = path.join(plansDir, entry);
    const content = await fs.readFile(filePath, 'utf-8');
    const header = parsePlanFileHeader(content);
    if (!header) continue;
    if (header.planId === id || header.beadId === id || (normalizedId && header.planId === normalizedId)) {
      return { filePath, header };
    }
  }
  return null;
}

/**
 * Update the status field in a plan file. Callers must hold the workspace writer lock.
 */
export async function updatePlanFileStatus(filePath: string, newStatus: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  const updated = content.replace(
    /^\*\*Status:\*\*\s*.+$/m,
    `**Status:** ${newStatus}`,
  );
  await fs.writeFile(filePath, updated, 'utf-8');
}

/**
 * List all plan files in the plans directory, returning parsed headers with file paths.
 * Errors on individual files are caught and skipped.
 */
export async function listPlanFiles(plansDir: string): Promise<Array<{ filePath: string; header: PlanFileHeader }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(plansDir);
  } catch {
    return [];
  }

  const results: Array<{ filePath: string; header: PlanFileHeader }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry.startsWith('.')) continue;
    try {
      const filePath = path.join(plansDir, entry);
      const content = await fs.readFile(filePath, 'utf-8');
      const header = parsePlanFileHeader(content);
      if (header) results.push({ filePath, header });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Inline fallback template (used when .plan-template.md is missing)
// ---------------------------------------------------------------------------

const FALLBACK_TEMPLATE = `# Plan: {{TITLE}}

**ID:** {{PLAN_ID}}
**Bead:** {{BEAD_ID}}
**Created:** {{DATE}}
**Status:** DRAFT
**Project:** {{PROJECT}}

---

## Objective

_Describe the objective here._

## Scope

_Define what's in and out of scope._

## Changes

_List file-by-file changes._

## Risks

_Identify risks._

## Testing

_How to verify._

---

## Audit Log

_Audit notes go here._

---

## Implementation Notes

_Filled in during/after implementation._
`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type HandlePlanCommandOpts = {
  workspaceCwd: string;
  taskStore: TaskStore;
  maxContextFiles?: number;
};

export async function handlePlanCommand(
  cmd: PlanCommand,
  opts: HandlePlanCommandOpts,
): Promise<string> {
  const plansDir = path.join(opts.workspaceCwd, 'plans');

  try {
    if (cmd.action === 'help') {
      return [
        '**!plan commands:**',
        '- `!plan <description>` — create a new plan',
        '- `!plan list` — list active plans',
        '- `!plan show <plan-id|bead-id>` — show plan details',
        '- `!plan approve <plan-id|bead-id>` — approve for implementation',
        '- `!plan close <plan-id|bead-id>` — close/abandon a plan',
        '- `!plan phases <plan-id>` — show/generate phase checklist',
        '- `!plan run <plan-id>` — execute all remaining phases',
        '- `!plan run-one <plan-id>` — execute next pending phase only',
        '- `!plan skip <plan-id>` — skip a failed/in-progress phase',
        '- `!plan audit <plan-id>` — run a standalone audit against a plan',
      ].join('\n');
    }

    if (cmd.action === 'create') {
      if (!cmd.args) return 'Usage: `!plan <description>`';

      await ensurePlansDir(plansDir);

      const num = await getNextPlanNumber(plansDir);
      const planId = `plan-${String(num).padStart(3, '0')}`;
      const slug = toSlug(cmd.args);
      const fileName = `${planId}-${slug}.md`;
      const filePath = path.join(plansDir, fileName);
      const date = new Date().toISOString().split('T')[0]!;
      const trimmedContext = cmd.context?.trim();

      // Create backing bead — or reuse existing one from bead thread context
      let beadId: string;
      if (cmd.existingBeadId) {
        beadId = cmd.existingBeadId;
        // Ensure the reused bead has the 'plan' label for label-based filtering
        try {
          opts.taskStore.addLabel(beadId, 'plan');
        } catch {
          // best-effort — label addition failure shouldn't block plan creation
        }
      } else {
        try {
          // Dedup: if an open bead with a matching title already exists, reuse it
          const normalizedTitle = cmd.args.trim().toLowerCase();
          const existingBeads = opts.taskStore.list({ label: 'plan' });
          const match = existingBeads.find(
            (b) => b.status !== 'closed' && b.title.trim().toLowerCase() === normalizedTitle,
          );

          if (match) {
            beadId = match.id;
          } else {
            const bead = opts.taskStore.create(
              {
                title: cmd.args,
                labels: ['plan'],
                ...(trimmedContext ? { description: trimmedContext.slice(0, 1800) } : {}),
              },
            );
            beadId = bead.id;
          }
        } catch (err) {
          return `Failed to create backing bead: ${String(err)}`;
        }
      }

      // Load template or use fallback
      let template: string;
      const templatePath = path.join(plansDir, '.plan-template.md');
      try {
        template = await fs.readFile(templatePath, 'utf-8');
      } catch {
        template = FALLBACK_TEMPLATE;
      }

      // Fill template
      const content = template
        .replace(/\{\{TITLE\}\}/g, cmd.args)
        .replace(/\{\{PLAN_ID\}\}/g, planId)
        .replace(/\{\{BEAD_ID\}\}/g, beadId)
        .replace(/\{\{TASK_ID\}\}/g, beadId)
        .replace(/\{\{DATE\}\}/g, date)
        .replace(/\{\{PROJECT\}\}/g, 'discoclaw')
        // Set status to DRAFT (remove the options list)
        .replace(
          /\*\*Status:\*\*\s*DRAFT\s*\|[^\n]*/,
          '**Status:** DRAFT',
        );

      // Append reply context below the template body (keeps slug/bead/title clean)
      const contextSection = trimmedContext ? `\n## Context\n\n${trimmedContext}\n` : '';
      const finalContent = content + contextSection;

      await fs.writeFile(filePath, finalContent, 'utf-8');

      return [
        `Plan created: **${planId}** (bead: \`${beadId}\`)`,
        `File: \`workspace/plans/${fileName}\``,
        `Description: ${cmd.args}`,
      ].join('\n');
    }

    if (cmd.action === 'list') {
      let entries: string[];
      try {
        entries = await fs.readdir(plansDir);
      } catch {
        return 'No plans directory found.';
      }

      const plans: PlanFileHeader[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.md') || entry.startsWith('.')) continue;
        try {
          const content = await fs.readFile(path.join(plansDir, entry), 'utf-8');
          const header = parsePlanFileHeader(content);
          if (header) plans.push(header);
        } catch {
          // skip unreadable files
        }
      }

      if (plans.length === 0) return 'No plans found.';

      // Sort by planId
      plans.sort((a, b) => a.planId.localeCompare(b.planId));

      const lines = plans.map(
        (p) => `- \`${p.planId}\` [${p.status}] — ${p.title}${p.beadId ? ` (bead: \`${p.beadId}\`)` : ''}`,
      );
      return lines.join('\n');
    }

    if (cmd.action === 'show') {
      if (!cmd.args) return 'Usage: `!plan show <plan-id|bead-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      const content = await fs.readFile(found.filePath, 'utf-8');

      // Extract objective section
      const objMatch = content.match(/## Objective\s*\n([\s\S]*?)(?=\n## |\n---)/);
      const objective = objMatch?.[1]?.trim() || '(no objective)';

      // Extract latest audit verdict — scope to the Audit Log section to
      // avoid false positives from **Verdict:** appearing in plan body prose.
      const auditLogMatch = content.match(/## Audit Log\s*\n([\s\S]*?)(?=\n## [^#]|\n---\s*\n## |$)/);
      // Strip fenced code blocks so **Verdict:** inside examples/snippets isn't matched.
      const auditSection = (auditLogMatch?.[1] ?? '').replace(/```[\s\S]*?```/g, '');

      // Current format: **Verdict:** <text> on the same line, anchored to line start
      const boldVerdicts = [...auditSection.matchAll(/^\*\*Verdict:\*\*\s*(.+)/gm)];
      // Legacy format (older plans): #### Verdict heading with text on next line(s)
      const headingVerdicts = [...auditSection.matchAll(/#### Verdict\s*\n+([\s\S]*?)(?=\n###|\n---|\n$)/g)];

      const allVerdicts = [...boldVerdicts, ...headingVerdicts];
      const latestVerdict = allVerdicts.length > 0
        ? allVerdicts.reduce((a, b) => (a.index! > b.index! ? a : b))[1]!.trim()
        : '(no audit yet)';

      return [
        `**${found.header.planId}** — ${found.header.title}`,
        `Status: ${found.header.status}`,
        `Bead: \`${found.header.beadId}\``,
        `Project: ${found.header.project}`,
        `Created: ${found.header.created}`,
        '',
        `**Objective:** ${objective}`,
        '',
        `**Latest audit:** ${latestVerdict}`,
      ].join('\n');
    }

    if (cmd.action === 'approve') {
      if (!cmd.args) return 'Usage: `!plan approve <plan-id|bead-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      if (found.header.status === 'IMPLEMENTING') return `Plan is currently being implemented. Use \`!plan cancel ${found.header.planId}\` to stop it first.`;

      await updatePlanFileStatus(found.filePath, 'APPROVED');

      // Update backing bead to in_progress
      if (found.header.beadId) {
        try {
          opts.taskStore.update(found.header.beadId, { status: 'in_progress' });
        } catch {
          // best-effort — bead update failure shouldn't block approval
        }
      }

      return `Plan **${found.header.planId}** approved for implementation.`;
    }

    if (cmd.action === 'close') {
      if (!cmd.args) return 'Usage: `!plan close <plan-id|bead-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      if (found.header.status === 'IMPLEMENTING') return `Plan is currently being implemented. Use \`!plan cancel ${found.header.planId}\` to stop it first.`;

      await updatePlanFileStatus(found.filePath, 'CLOSED');

      // Close backing bead
      if (found.header.beadId) {
        try {
          opts.taskStore.close(found.header.beadId, 'Plan closed');
        } catch {
          // best-effort
        }
      }

      return `Plan **${found.header.planId}** closed.`;
    }

    if (cmd.action === 'phases') {
      if (!cmd.args) return 'Usage: `!plan phases <plan-id>`';

      // Parse --regenerate flag
      const regenerate = cmd.args.includes('--regenerate');
      const planIdArg = cmd.args.replace('--regenerate', '').trim();
      if (!planIdArg) return 'Usage: `!plan phases <plan-id>`';

      const found = await findPlanFile(plansDir, planIdArg);
      if (!found) return `Plan not found: ${planIdArg}`;

      const phasesFileName = `${found.header.planId}-phases.md`;
      const phasesFilePath = path.join(plansDir, phasesFileName);

      let phases: PlanPhases;

      const phasesFileExists = fsSync.existsSync(phasesFilePath);
      if (!phasesFileExists || regenerate) {
        // Generate phases
        const planContent = await fs.readFile(found.filePath, 'utf-8');
        const planRelPath = `workspace/plans/${path.basename(found.filePath)}`;
        phases = decomposePlan(planContent, found.header.planId, planRelPath, opts.maxContextFiles);
        writePhasesFile(phasesFilePath, phases);
      } else {
        // Read existing phases
        const content = fsSync.readFileSync(phasesFilePath, 'utf-8');
        phases = deserializePhases(content);
      }

      // Format checklist
      return formatPhasesChecklist(phases);
    }

    // Note: 'run' and 'skip' are intercepted by discord.ts before reaching here.

    return 'Unknown plan command. Try `!plan` for help.';
  } catch (err) {
    return `Plan command error: ${String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Phase status emoji
// ---------------------------------------------------------------------------

const STATUS_EMOJI: Record<string, string> = {
  'pending': '[ ]',
  'in-progress': '[~]',
  'done': '[x]',
  'failed': '[!]',
  'skipped': '[-]',
};

function formatPhasesChecklist(phases: PlanPhases): string {
  const lines: string[] = [];
  lines.push(`**Phases for ${phases.planId}** (hash: \`${phases.planContentHash}\`)`);
  lines.push('');

  for (const phase of phases.phases) {
    const emoji = STATUS_EMOJI[phase.status] ?? '[ ]';
    const deps = phase.dependsOn.length > 0 ? ` (depends: ${phase.dependsOn.join(', ')})` : '';
    lines.push(`${emoji} **${phase.id}:** ${phase.title} [${phase.kind}]${deps}`);
    if (phase.error) lines.push(`  Error: ${phase.error}`);
    if (phase.gitCommit) lines.push(`  Commit: \`${phase.gitCommit}\``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exported helpers for discord.ts
// ---------------------------------------------------------------------------

export async function handlePlanSkip(
  planId: string,
  opts: HandlePlanCommandOpts,
): Promise<string> {
  const plansDir = path.join(opts.workspaceCwd, 'plans');
  const found = await findPlanFile(plansDir, planId);
  if (!found) return `Plan not found: ${planId}`;

  const phasesFileName = `${found.header.planId}-phases.md`;
  const phasesFilePath = path.join(plansDir, phasesFileName);

  if (!fsSync.existsSync(phasesFilePath)) {
    return `No phases file found for ${planId}. Run \`!plan phases ${planId}\` first.`;
  }

  const content = fsSync.readFileSync(phasesFilePath, 'utf-8');
  let phases: PlanPhases;
  try {
    phases = deserializePhases(content);
  } catch (err) {
    return `Failed to read phases file: ${String(err)}`;
  }

  // Find the first in-progress or failed phase
  const target = phases.phases.find((p) => p.status === 'in-progress' || p.status === 'failed');
  if (!target) return 'Nothing to skip.';

  phases = updatePhaseStatus(phases, target.id, 'skipped');
  writePhasesFile(phasesFilePath, phases);

  return `Skipped **${target.id}**: ${target.title} (was ${target.status})`;
}

export const NO_PHASES_SENTINEL = 'No phases to run';

export type PreparePlanRunResult =
  | { phasesFilePath: string; planFilePath: string; planContent: string; nextPhase: PlanPhase }
  | { error: string };

const RUNNABLE_STATUSES = new Set(['APPROVED', 'IMPLEMENTING']);

export async function preparePlanRun(
  planId: string,
  opts: HandlePlanCommandOpts,
): Promise<PreparePlanRunResult> {
  const plansDir = path.join(opts.workspaceCwd, 'plans');
  const found = await findPlanFile(plansDir, planId);
  if (!found) return { error: `Plan not found: ${planId}` };

  // Status gate: only run phases on approved or implementing plans
  if (!RUNNABLE_STATUSES.has(found.header.status)) {
    return { error: `Plan ${found.header.planId} has status ${found.header.status} — must be APPROVED or IMPLEMENTING to run.` };
  }

  const phasesFileName = `${found.header.planId}-phases.md`;
  const phasesFilePath = path.join(plansDir, phasesFileName);

  // Generate phases if needed
  if (!fsSync.existsSync(phasesFilePath)) {
    const planContent = await fs.readFile(found.filePath, 'utf-8');
    const planRelPath = `workspace/plans/${path.basename(found.filePath)}`;
    const phases = decomposePlan(planContent, found.header.planId, planRelPath, opts.maxContextFiles);
    writePhasesFile(phasesFilePath, phases);
  }

  // Read and validate
  let phases: PlanPhases;
  try {
    const phasesContent = fsSync.readFileSync(phasesFilePath, 'utf-8');
    phases = deserializePhases(phasesContent);
  } catch (err) {
    return { error: `Failed to read phases file: ${String(err)}` };
  }

  const planContent = await fs.readFile(found.filePath, 'utf-8');
  const staleness = checkStaleness(phases, planContent);
  if (staleness.stale) return { error: staleness.message };

  const nextPhase = getNextPhase(phases);
  // NOTE: The multi-phase loop in discord.ts depends on NO_PHASES_SENTINEL only here
  // (initial validation before the loop starts). The loop itself uses runNextPhase's
  // `nothing_to_run` discriminated union result — not this sentinel string. If this
  // error message is refactored, only the initial "already all done" detection breaks,
  // and the failure mode is benign (user sees an error instead of "all done").
  if (!nextPhase) return { error: `${NO_PHASES_SENTINEL} — all done or dependencies unmet.` };

  return {
    phasesFilePath,
    planFilePath: found.filePath,
    planContent,
    nextPhase,
  };
}

// ---------------------------------------------------------------------------
// Auto-close plan when all phases are terminal
// ---------------------------------------------------------------------------

const CLOSEABLE_STATUSES = new Set(['APPROVED', 'IMPLEMENTING']);
const TERMINAL_PHASE_STATUSES = new Set(['done', 'skipped']);

export async function closePlanIfComplete(
  phasesFilePath: string,
  planFilePath: string,
  taskStore: TaskStore,
  acquireLock: () => Promise<() => void>,
  log?: LoggerLike,
): Promise<{ closed: boolean; reason: string }> {
  let beadId: string | undefined;
  const releaseLock = await acquireLock();
  try {
    // Read and deserialize phases
    let phasesContent: string;
    try {
      phasesContent = await fs.readFile(phasesFilePath, 'utf-8');
    } catch (err) {
      log?.warn({ err, phasesFilePath }, 'closePlanIfComplete: failed to read phases file');
      return { closed: false, reason: 'read_error' };
    }

    let phases: PlanPhases;
    try {
      phases = deserializePhases(phasesContent);
    } catch (err) {
      log?.warn({ err, phasesFilePath }, 'closePlanIfComplete: failed to deserialize phases');
      return { closed: false, reason: 'read_error' };
    }

    // Check whether every phase has a terminal status (done or skipped)
    const allComplete = phases.phases.every((p) => TERMINAL_PHASE_STATUSES.has(p.status));
    if (!allComplete) {
      return { closed: false, reason: 'not_all_complete' };
    }

    // Read plan file header
    let planContent: string;
    try {
      planContent = await fs.readFile(planFilePath, 'utf-8');
    } catch (err) {
      log?.warn({ err, planFilePath }, 'closePlanIfComplete: failed to read plan file');
      return { closed: false, reason: 'read_error' };
    }

    const header = parsePlanFileHeader(planContent);
    if (!header) {
      log?.warn({ planFilePath }, 'closePlanIfComplete: failed to parse plan file header');
      return { closed: false, reason: 'read_error' };
    }

    // Plan-status gate: only auto-close plans that were approved for execution
    if (!CLOSEABLE_STATUSES.has(header.status)) {
      return { closed: false, reason: 'wrong_status' };
    }

    beadId = header.beadId || undefined;

    // Close the plan (under lock, as updatePlanFileStatus requires)
    await updatePlanFileStatus(planFilePath, 'CLOSED');
  } finally {
    releaseLock();
  }

  // Best-effort bead close (no lock needed)
  if (beadId) {
    try {
      taskStore.close(beadId, 'All phases complete');
    } catch (err) {
      log?.warn({ err, beadId }, 'closePlanIfComplete: failed to close bead (best-effort)');
    }
  }

  return { closed: true, reason: 'all_phases_complete' };
}
