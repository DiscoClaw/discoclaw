import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskStore } from '../tasks/store.js';
import {
  decomposePlan,
  readPhasesFile,
  getNextPhase,
  updatePhaseStatus,
  checkStaleness,
  writePhasesFile,
} from './plan-manager.js';
import type { PlanPhase, PlanPhases } from './plan-manager.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { getLatestAuditVerdictFromSection, getSection, parsePlan } from './plan-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanCommand = {
  action: 'help' | 'create' | 'list' | 'show' | 'approve' | 'close' | 'cancel' | 'phases' | 'run' | 'run-one' | 'skip' | 'audit';
  args: string;
  context?: string;
  /** When set, reuse this task instead of creating a new one (e.g. when issued in a task forum thread). */
  existingTaskId?: string;
};

export type PlanFileHeader = {
  planId: string;
  /** Canonical backing task identifier. */
  taskId?: string;
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
  const parsed = parsePlan(content);
  const planId = parsed.metadata.get('ID')?.trim() ?? '';
  if (!planId) return null;
  const taskId = parsed.metadata.get('Task')?.trim() ?? '';

  return {
    planId,
    taskId,
    status: parsed.metadata.get('Status')?.trim() ?? '',
    title: parsed.title.trim(),
    project: parsed.metadata.get('Project')?.trim() ?? '',
    created: parsed.metadata.get('Created')?.trim() ?? '',
  };
}

export function resolvePlanHeaderTaskId(header: PlanFileHeader): string {
  return header.taskId?.trim() || '';
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
    const taskId = resolvePlanHeaderTaskId(header);
    if (header.planId === id || taskId === id || (normalizedId && header.planId === normalizedId)) {
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
**Task:** {{TASK_ID}}
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
  plansDir?: string;
  maxContextFiles?: number;
};

export type CreatePlanOpts = {
  description: string;
  context?: string;
  existingTaskId?: string;
};

export type CreatePlanResult = {
  planId: string;
  taskId: string;
  filePath: string;
  fileName: string;
  description: string;
  displayMessage: string;
};

function resolvePlansDir(opts: HandlePlanCommandOpts): string {
  return opts.plansDir ?? path.join(opts.workspaceCwd, 'plans');
}

export async function createPlan(
  createOpts: CreatePlanOpts,
  opts: HandlePlanCommandOpts,
): Promise<CreatePlanResult> {
  const description = createOpts.description.trim();
  if (!description) throw new Error('Usage: `!plan <description>`');

  const plansDir = resolvePlansDir(opts);
  await ensurePlansDir(plansDir);

  const num = await getNextPlanNumber(plansDir);
  const planId = `plan-${String(num).padStart(3, '0')}`;
  const slug = toSlug(description);
  const fileName = `${planId}-${slug}.md`;
  const filePath = path.join(plansDir, fileName);
  const date = new Date().toISOString().split('T')[0]!;
  const trimmedContext = createOpts.context?.trim();

  // Create backing task — or reuse existing one from task thread context.
  let taskId: string;
  const existingTaskId = createOpts.existingTaskId;
  if (existingTaskId) {
    taskId = existingTaskId;
    // Ensure the reused task has the 'plan' label for label-based filtering.
    try {
      opts.taskStore.addLabel(taskId, 'plan');
    } catch {
      // best-effort — label addition failure shouldn't block plan creation.
    }
  } else {
    try {
      // Dedup: if an open task with a matching title already exists, reuse it.
      const normalizedTitle = description.toLowerCase();
      const existingTasks = opts.taskStore.list({ label: 'plan' });
      const match = existingTasks.find(
        (task) => task.status !== 'closed' && task.title.trim().toLowerCase() === normalizedTitle,
      );

      if (match) {
        taskId = match.id;
      } else {
        const task = opts.taskStore.create(
          {
            title: description,
            labels: ['plan'],
            ...(trimmedContext ? { description: trimmedContext.slice(0, 1800) } : {}),
          },
        );
        taskId = task.id;
      }
    } catch (err) {
      throw new Error(`Failed to create backing task: ${String(err)}`);
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
    .replace(/\{\{TITLE\}\}/g, description)
    .replace(/\{\{PLAN_ID\}\}/g, planId)
    .replace(/\{\{TASK_ID\}\}/g, taskId)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{PROJECT\}\}/g, 'discoclaw')
    // Set status to DRAFT (remove the options list)
    .replace(
      /\*\*Status:\*\*\s*DRAFT\s*\|[^\n]*/,
      '**Status:** DRAFT',
    );

  // Append reply context below the template body (keeps slug/task/title clean).
  const contextSection = trimmedContext ? `\n## Context\n\n${trimmedContext}\n` : '';
  const finalContent = content + contextSection;

  await fs.writeFile(filePath, finalContent, 'utf-8');

  const displayMessage = [
    `Plan created: **${planId}** (task: \`${taskId}\`)`,
    `File: \`workspace/plans/${fileName}\``,
    `Description: ${description}`,
  ].join('\n');

  return { planId, taskId, filePath, fileName, description, displayMessage };
}

export async function handlePlanCommand(
  cmd: PlanCommand,
  opts: HandlePlanCommandOpts,
): Promise<string> {
  const plansDir = resolvePlansDir(opts);

  try {
    if (cmd.action === 'help') {
      return [
        '**!plan commands:**',
        '- `!plan <description>` — create a new plan',
        '- `!plan list` — list active plans',
        '- `!plan show <plan-id|task-id>` — show plan details',
        '- `!plan approve <plan-id|task-id>` — approve for implementation',
        '- `!plan close <plan-id|task-id>` — close/abandon a plan',
        '- `!plan phases <plan-id>` — show/generate phase checklist',
        '- `!plan run <plan-id>` — execute all remaining phases',
        '- `!plan run-one <plan-id>` — execute next pending phase only',
        '- `!plan skip <plan-id>` — skip a failed/in-progress phase',
        '- `!plan audit <plan-id>` — run a standalone audit against a plan',
      ].join('\n');
    }

    if (cmd.action === 'create') {
      try {
        const created = await createPlan(
          {
            description: cmd.args,
            context: cmd.context,
            existingTaskId: cmd.existingTaskId,
          },
          opts,
        );
        return created.displayMessage;
      } catch (err) {
        return String(err instanceof Error ? err.message : err);
      }
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
        (p) => {
          const taskId = resolvePlanHeaderTaskId(p);
          return `- \`${p.planId}\` [${p.status}] — ${p.title}${taskId ? ` (task: \`${taskId}\`)` : ''}`;
        },
      );
      return lines.join('\n');
    }

    if (cmd.action === 'show') {
      if (!cmd.args) return 'Usage: `!plan show <plan-id|task-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      const content = await fs.readFile(found.filePath, 'utf-8');
      const parsedPlan = parsePlan(content);

      const objective = getSection(parsedPlan, 'Objective') || '(no objective)';

      const auditSection = getSection(parsedPlan, 'Audit Log');
      const latestVerdict = getLatestAuditVerdictFromSection(auditSection) ?? '(no audit yet)';

      return [
        `**${found.header.planId}** — ${found.header.title}`,
        `Status: ${found.header.status}`,
        `Task: \`${resolvePlanHeaderTaskId(found.header)}\``,
        `Project: ${found.header.project}`,
        `Created: ${found.header.created}`,
        '',
        `**Objective:** ${objective}`,
        '',
        `**Latest audit:** ${latestVerdict}`,
      ].join('\n');
    }

    if (cmd.action === 'approve') {
      if (!cmd.args) return 'Usage: `!plan approve <plan-id|task-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      if (found.header.status === 'IMPLEMENTING') return `Plan is currently being implemented. Use \`!plan cancel ${found.header.planId}\` to stop it first.`;

      await updatePlanFileStatus(found.filePath, 'APPROVED');

      // Update backing task to in_progress.
      const taskId = resolvePlanHeaderTaskId(found.header);
      if (taskId) {
        try {
          opts.taskStore.update(taskId, { status: 'in_progress' });
        } catch {
          // best-effort — task update failure shouldn't block approval.
        }
      }

      return `Plan **${found.header.planId}** approved for implementation.`;
    }

    if (cmd.action === 'close') {
      if (!cmd.args) return 'Usage: `!plan close <plan-id|task-id>`';

      const found = await findPlanFile(plansDir, cmd.args);
      if (!found) return `Plan not found: ${cmd.args}`;

      if (found.header.status === 'IMPLEMENTING') return `Plan is currently being implemented. Use \`!plan cancel ${found.header.planId}\` to stop it first.`;

      await updatePlanFileStatus(found.filePath, 'CLOSED');

      // Close backing task.
      const taskId = resolvePlanHeaderTaskId(found.header);
      if (taskId) {
        try {
          opts.taskStore.close(taskId, 'Plan closed');
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
        phases = readPhasesFile(phasesFilePath);
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
  const plansDir = resolvePlansDir(opts);
  const found = await findPlanFile(plansDir, planId);
  if (!found) return `Plan not found: ${planId}`;

  const phasesFileName = `${found.header.planId}-phases.md`;
  const phasesFilePath = path.join(plansDir, phasesFileName);

  if (!fsSync.existsSync(phasesFilePath)) {
    return `No phases file found for ${planId}. Run \`!plan phases ${planId}\` first.`;
  }

  let phases: PlanPhases;
  try {
    phases = readPhasesFile(phasesFilePath);
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
  const plansDir = resolvePlansDir(opts);
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
    phases = readPhasesFile(phasesFilePath);
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
  let taskId: string | undefined;
  const releaseLock = await acquireLock();
  try {
    let phases: PlanPhases;
    try {
      phases = readPhasesFile(phasesFilePath, { log });
    } catch (err) {
      log?.warn({ err, phasesFilePath }, 'closePlanIfComplete: failed to read phases state');
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

    taskId = resolvePlanHeaderTaskId(header) || undefined;

    // Close the plan (under lock, as updatePlanFileStatus requires)
    await updatePlanFileStatus(planFilePath, 'CLOSED');
  } finally {
    releaseLock();
  }

  // Best-effort task close (no lock needed).
  if (taskId) {
    try {
      taskStore.close(taskId, 'All phases complete');
    } catch (err) {
      log?.warn({ err, taskId }, 'closePlanIfComplete: failed to close task (best-effort)');
    }
  }

  return { closed: true, reason: 'all_phases_complete' };
}
