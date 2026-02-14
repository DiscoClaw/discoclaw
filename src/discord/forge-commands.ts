import fs from 'node:fs/promises';
import path from 'node:path';
import { handlePlanCommand, parsePlanFileHeader } from './plan-commands.js';
import { bdUpdate } from '../beads/bd-cli.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from './action-types.js';
import { collectRuntimeText } from './runtime-utils.js';
import { auditPlanStructure, maxReviewNumber } from './audit-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForgeCommand = {
  action: 'create' | 'help' | 'status' | 'cancel' | 'audit';
  args: string;
};

export type ForgeResult = {
  planId: string;
  filePath: string;
  finalVerdict: string;
  rounds: number;
  reachedMaxRounds: boolean;
  error?: string;
  planSummary?: string;
};

export type ForgeOrchestratorOpts = {
  runtime: RuntimeAdapter;
  model: string;
  cwd: string;
  workspaceCwd: string;
  beadsCwd: string;
  plansDir: string;
  maxAuditRounds: number;
  progressThrottleMs: number;
  timeoutMs: number;
  drafterModel?: string;
  auditorModel?: string;
  log?: LoggerLike;
};

type ProgressFn = (msg: string, opts?: { force?: boolean }) => Promise<void>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const RESERVED_SUBCOMMANDS = new Set(['status', 'cancel', 'help', 'audit']);

export function parseForgeCommand(content: string): ForgeCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('!forge')) return null;

  // Reject !forging, !forger, etc. — must be exactly "!forge" optionally followed by whitespace.
  const afterPrefix = trimmed.slice('!forge'.length);
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) return null;

  const rest = afterPrefix.trim();

  if (!rest) return { action: 'help', args: '' };

  const firstWord = rest.split(/\s+/)[0]!.toLowerCase();
  if (RESERVED_SUBCOMMANDS.has(firstWord)) {
    const subArgs = rest.slice(firstWord.length).trim();
    return { action: firstWord as ForgeCommand['action'], args: subArgs };
  }

  return { action: 'create', args: rest };
}

// ---------------------------------------------------------------------------
// Audit verdict parsing
// ---------------------------------------------------------------------------

export type AuditVerdict = {
  maxSeverity: 'high' | 'medium' | 'low' | 'none';
  shouldLoop: boolean;
};

export function parseAuditVerdict(auditText: string): AuditVerdict {
  if (!auditText || !auditText.trim()) {
    return { maxSeverity: 'none', shouldLoop: false };
  }

  const lower = auditText.toLowerCase();

  // Look for severity markers
  const hasHigh = /severity:\s*high/i.test(auditText) || /\*\*severity:\s*high/i.test(auditText);
  const hasMedium = /severity:\s*medium/i.test(auditText) || /\*\*severity:\s*medium/i.test(auditText);
  const hasLow = /severity:\s*low/i.test(auditText) || /\*\*severity:\s*low/i.test(auditText);

  if (hasHigh) return { maxSeverity: 'high', shouldLoop: true };
  if (hasMedium) return { maxSeverity: 'medium', shouldLoop: true };
  if (hasLow) return { maxSeverity: 'low', shouldLoop: false };

  // Fallback: look for "ready to approve" as a clean signal
  if (lower.includes('ready to approve')) {
    return { maxSeverity: 'low', shouldLoop: false };
  }

  // Malformed output — stop and let the human review
  return { maxSeverity: 'none', shouldLoop: false };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDrafterPrompt(
  description: string,
  templateContent: string,
  contextSummary: string,
): string {
  return [
    'You are a senior software engineer drafting a technical implementation plan.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Plan Template',
    '',
    'Fill in this template completely. Output the complete plan file content starting with `# Plan:` and ending with the Audit Log section. Output ONLY the plan markdown — no preamble, no explanation, no commentary.',
    '',
    '```',
    templateContent,
    '```',
    '',
    '## Project Context',
    '',
    contextSummary,
    '',
    '## Instructions',
    '',
    '- Read the codebase using your tools (Read, Glob, Grep) to understand the existing code before writing the plan.',
    '- Be specific in the file-by-file changes section — include actual file paths, function names, and type signatures.',
    '- Identify real risks and dependencies based on the actual codebase.',
    '- Write concrete, verifiable test cases.',
    '- Set the status to DRAFT.',
    '- Replace all {{PLACEHOLDER}} tokens with actual values. The plan ID and bead ID will be filled in by the system — use `(system)` as placeholders for those.',
    '- Output the complete plan markdown and nothing else.',
  ].join('\n');
}

export function buildAuditorPrompt(planContent: string, roundNumber: number, projectContext?: string): string {
  const sections = [
    'You are an adversarial senior engineer auditing a technical plan. Your job is to find flaws, gaps, and risks.',
    '',
  ];

  if (projectContext) {
    sections.push(
      '## Project Context',
      '',
      'These are standing constraints for this project. Respect them when auditing — do not flag concerns that contradict these constraints.',
      '',
      projectContext,
      '',
    );
  }

  sections.push(
    '## Plan to Audit',
    '',
    '```markdown',
    planContent,
    '```',
    '',
    `## This is audit round ${roundNumber}.`,
  );

  const instructions = [
    ...sections,
    '',
    '## Instructions',
    '',
  ];

  if (roundNumber > 1) {
    instructions.push(
      '### Prior Audit History',
      '',
      'The plan contains prior audit reviews (### Review N sections) with resolutions inline. These represent concerns that were already raised and addressed in earlier rounds.',
      '',
      '- **DO NOT re-raise concerns that were adequately resolved.** If a prior resolution is sound, move on.',
      '- **If a prior resolution is inadequate**, reference the specific prior review (e.g., "Review 1, Concern 3\'s resolution fails because...") and explain why it doesn\'t hold. This counts as a new concern.',
      '- **Focus on genuinely new issues** — things not yet examined, edge cases the prior rounds missed, or problems introduced by the revisions themselves.',
      '',
    );
  }

  instructions.push(
    'Review the plan for:',
    '1. Missing or underspecified details (vague scope, unclear file changes)',
    '2. Architectural issues (wrong abstraction, missing error handling, wrong patterns)',
    '3. Risk gaps (unidentified failure modes, missing rollback plans)',
    '4. Test coverage gaps (missing edge cases, untested error paths)',
    '5. Dependency issues (circular deps, version conflicts, missing imports)',
    '',
    '## Verification',
    '',
    'You have read-only access to the codebase via Read, Glob, and Grep tools. **Use them before raising concerns.** Specifically:',
    '- Before claiming a file is missing or incomplete, Glob/Read it.',
    '- Before claiming test coverage gaps, Grep for existing tests.',
    '- Before claiming missing error handling, Read the relevant code.',
    '- If your concern evaporates after checking the code, do not raise it.',
    '',
    '## Output Format',
    '',
    'For each concern, write:',
    '',
    '**Concern N: [title]**',
    'Description of the issue.',
    '**Severity: high | medium | low**',
    '',
    'Then write a verdict:',
    '',
    '**Verdict:** [one of:]',
    '- "Needs revision." — if any high or medium severity concerns exist',
    '- "Ready to approve." — if only low severity concerns remain',
    '',
    'Be thorough but fair. Don\'t nitpick style — focus on correctness, safety, and completeness.',
    'Output only the audit notes and verdict. No preamble.',
  );

  return instructions.join('\n');
}

export function buildRevisionPrompt(
  planContent: string,
  auditNotes: string,
  description: string,
  projectContext?: string,
): string {
  const sections = [
    'You are a senior software engineer revising a technical plan based on audit feedback.',
    '',
  ];

  if (projectContext) {
    sections.push(
      '## Project Context',
      '',
      'These are standing constraints for this project. Respect them when revising — do not re-introduce complexity that contradicts these constraints.',
      '',
      projectContext,
      '',
    );
  }

  sections.push(
    '## Original Description',
    '',
    description,
    '',
    '## Current Plan',
    '',
    '```markdown',
    planContent,
    '```',
    '',
    '## Audit Feedback',
    '',
    auditNotes,
    '',
    '## Instructions',
    '',
    '- Address all high and medium severity concerns from the audit.',
    '- Read the codebase using your tools if needed to resolve concerns.',
    '- Keep the same plan structure and format.',
    '- Preserve resolutions from prior audit rounds that were accepted — do not weaken, revert, or remove them unless the current audit explicitly challenges them.',
    '- Output the complete revised plan markdown starting with `# Plan:`. Output ONLY the plan markdown — no preamble, no explanation.',
  );

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Plan summary extraction
// ---------------------------------------------------------------------------

export function buildPlanSummary(planContent: string): string {
  const header = parsePlanFileHeader(planContent);

  // Extract objective (match content between ## Objective and next ## heading)
  const objMatch = planContent.match(/## Objective\n([\s\S]*?)(?=\n## )/);
  const objective = objMatch?.[1]?.trim() || '(no objective)';

  // Extract scope (just the "In:" section if present, otherwise the whole scope block)
  const scopeMatch = planContent.match(/## Scope\s*\n([\s\S]*?)(?=\n## )/);
  let scope = '';
  if (scopeMatch) {
    const scopeText = scopeMatch[1]!.trim();
    const inMatch = scopeText.match(/\*\*In:\*\*\s*\n([\s\S]*?)(?=\n\*\*Out:\*\*|$)/);
    scope = inMatch?.[1]?.trim() || scopeText;
  }

  // Extract changed files (look for file paths in the Changes section)
  const changesMatch = planContent.match(/## Changes\s*\n([\s\S]*?)(?=\n## )/);
  const files: string[] = [];
  if (changesMatch) {
    const fileMatches = changesMatch[1]!.matchAll(/####\s+`([^`]+)`/g);
    for (const m of fileMatches) {
      files.push(m[1]!);
    }
  }

  const lines: string[] = [];

  if (header) {
    lines.push(`**${header.planId}** — ${header.title}`);
    lines.push(`Status: ${header.status} | Bead: \`${header.beadId}\``);
    lines.push('');
  }

  lines.push(`**Objective:** ${objective}`);

  if (scope) {
    lines.push('');
    lines.push(`**Scope:**`);
    lines.push(scope);
  }

  if (files.length > 0) {
    lines.push('');
    lines.push(`**Files:** ${files.map((f) => `\`${f}\``).join(', ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Audit-round append (standalone, used by ForgeOrchestrator and !plan audit)
// ---------------------------------------------------------------------------

export function appendAuditRound(
  planContent: string,
  round: number,
  auditNotes: string,
  verdict: AuditVerdict,
): string {
  const date = new Date().toISOString().split('T')[0]!;
  const verdictText = verdict.shouldLoop ? 'Needs revision.' : 'Ready to approve.';

  const auditSection = [
    '',
    `### Review ${round} — ${date}`,
    `**Status:** COMPLETE`,
    '',
    auditNotes.trim(),
    '',
  ].join('\n');

  // Insert before Implementation Notes section
  const implNotesIdx = planContent.indexOf('## Implementation Notes');
  if (implNotesIdx !== -1) {
    return (
      planContent.slice(0, implNotesIdx) +
      auditSection +
      '\n---\n\n' +
      planContent.slice(implNotesIdx)
    );
  }

  // Fallback: append at end
  return planContent + '\n' + auditSection;
}

// ---------------------------------------------------------------------------
// ForgeOrchestrator
// ---------------------------------------------------------------------------

export class ForgeOrchestrator {
  private running = false;
  private cancelRequested = false;
  private currentPlanId: string | undefined;
  private opts: ForgeOrchestratorOpts;

  constructor(opts: ForgeOrchestratorOpts) {
    this.opts = opts;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activePlanId(): string | undefined {
    return this.running ? this.currentPlanId : undefined;
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  async run(
    description: string,
    onProgress: ProgressFn,
    context?: string,
  ): Promise<ForgeResult> {
    if (this.running) {
      throw new Error('A forge is already running');
    }
    this.running = true;
    this.cancelRequested = false;
    this.currentPlanId = undefined;
    const t0 = Date.now();

    let planId = '';
    let filePath = '';

    try {
      // 1. Create the plan file via handlePlanCommand
      // Pass context separately so bead title/slug stay clean (context goes in plan body).
      const createResult = await handlePlanCommand(
        { action: 'create', args: description, context },
        { workspaceCwd: this.opts.workspaceCwd, beadsCwd: this.opts.beadsCwd },
      );

      // Extract plan ID from the response
      const idMatch = createResult.match(/\*\*(plan-\d+)\*\*/);
      planId = idMatch?.[1] ?? '';

      if (!planId) {
        throw new Error(`Failed to create plan: ${createResult}`);
      }
      this.currentPlanId = planId;

      // Find the plan file
      const plansDir = this.opts.plansDir;
      const entries = await fs.readdir(plansDir);
      const planFile = entries.find((e) => e.startsWith(planId));
      if (!planFile) {
        throw new Error(`Plan file not found for ${planId}`);
      }
      filePath = path.join(plansDir, planFile);

      // Load the template for the drafter prompt
      let templateContent: string;
      try {
        templateContent = await fs.readFile(
          path.join(plansDir, '.plan-template.md'),
          'utf-8',
        );
      } catch {
        // Use a simple fallback
        templateContent = await fs.readFile(filePath, 'utf-8');
      }

      // Load project context once — used by drafter (via context summary), auditor, and reviser
      const projectContext = await this.loadProjectContext();

      // Build context summary from workspace files (includes project context)
      const contextSummary = await this.buildContextSummary(projectContext);

      return await this.auditLoop({
        planId,
        filePath,
        description: context ? `${description}\n\n${context}` : description,
        startRound: 1,
        onProgress,
        projectContext,
        // Draft-phase specifics (only used when startRound === 1)
        templateContent,
        contextSummary,
        t0,
      });
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      this.opts.log?.error({ err, planId }, 'forge:error');

      // Write partial state if we have a file
      if (filePath) {
        try {
          await this.updatePlanStatus(filePath, 'DRAFT');
        } catch {
          // best-effort
        }
      }

      await onProgress(
        `Forge failed${planId ? ` during ${planId}` : ''}: ${errorMsg}${filePath ? `. Partial plan saved: \`!plan show ${planId}\`` : ''}`,
        { force: true },
      );

      return {
        planId: planId || '(none)',
        filePath: filePath || '',
        finalVerdict: 'error',
        rounds: 0,
        reachedMaxRounds: false,
        error: errorMsg,
      };
    } finally {
      this.running = false;
      this.currentPlanId = undefined;
    }
  }

  async resume(
    planId: string,
    filePath: string,
    planTitle: string,
    onProgress: ProgressFn,
  ): Promise<ForgeResult> {
    if (this.running) {
      throw new Error('A forge is already running');
    }
    this.running = true;
    this.cancelRequested = false;
    this.currentPlanId = planId;
    const t0 = Date.now();

    let originalStatus = '';

    try {
      const planContent = await fs.readFile(filePath, 'utf-8');
      const header = parsePlanFileHeader(planContent);
      originalStatus = header?.status ?? '';

      // Validate plan status
      if (originalStatus === 'IMPLEMENTING') {
        throw new Error('Plan is currently being implemented. Use `!plan cancel` to stop it first.');
      }
      if (originalStatus === 'APPROVED') {
        throw new Error('Plan is approved — re-auditing would downgrade its status. Use `!plan audit` for a standalone audit instead.');
      }

      // Structural pre-flight: reject plans with high-severity structural issues
      const structuralConcerns = auditPlanStructure(planContent);
      const highSeverity = structuralConcerns.filter((c) => c.severity === 'high');
      if (highSeverity.length > 0) {
        const missing = highSeverity.map((c) => c.title).join(', ');
        throw new Error(`Plan has structural issues: ${missing}. Fix the plan file before re-auditing.`);
      }

      // Load project context
      const projectContext = await this.loadProjectContext();

      // Determine start round from existing reviews
      const startRound = maxReviewNumber(planContent) + 1;

      return await this.auditLoop({
        planId,
        filePath,
        description: planTitle,
        startRound,
        onProgress,
        projectContext,
        t0,
      });
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      this.opts.log?.error({ err, planId }, 'forge:resume:error');

      // Best-effort: restore original status if we changed it
      if (filePath && originalStatus) {
        try {
          await this.updatePlanStatus(filePath, originalStatus);
        } catch {
          // best-effort
        }
      }

      await onProgress(
        `Forge resume failed for ${planId}: ${errorMsg}`,
        { force: true },
      );

      return {
        planId,
        filePath,
        finalVerdict: 'error',
        rounds: 0,
        reachedMaxRounds: false,
        error: errorMsg,
      };
    } finally {
      this.running = false;
      this.currentPlanId = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async auditLoop(params: {
    planId: string;
    filePath: string;
    description: string;
    startRound: number;
    onProgress: ProgressFn;
    projectContext?: string;
    // Draft-phase specifics (only present when startRound === 1, i.e. from run())
    templateContent?: string;
    contextSummary?: string;
    t0?: number;
  }): Promise<ForgeResult> {
    const {
      planId,
      filePath,
      description,
      startRound,
      onProgress,
      projectContext,
      templateContent,
      contextSummary,
    } = params;
    const t0 = params.t0 ?? Date.now();

    const drafterModel = this.opts.drafterModel ?? this.opts.model;
    const auditorModel = this.opts.auditorModel ?? this.opts.model;
    const readOnlyTools = ['Read', 'Glob', 'Grep'];
    const addDirs = [this.opts.cwd];

    let round = startRound - 1; // will be incremented at top of loop
    let planContent = await fs.readFile(filePath, 'utf-8');
    let lastAuditNotes = '';
    let lastVerdict: AuditVerdict = { maxSeverity: 'none', shouldLoop: false };

    // The effective max round number is startRound + maxAuditRounds - 1
    const maxRound = startRound + this.opts.maxAuditRounds - 1;

    while (round < maxRound) {
      if (this.cancelRequested) {
        await this.updatePlanStatus(filePath, 'CANCELLED');
        return {
          planId,
          filePath,
          finalVerdict: 'CANCELLED',
          rounds: round - startRound + 1,
          reachedMaxRounds: false,
        };
      }

      round++;

      // Draft phase (only on first round of a fresh forge, not resume)
      if (round === 1 && startRound === 1 && templateContent && contextSummary) {
        await onProgress(`Forging ${planId}... Drafting (reading codebase)`);

        const drafterPrompt = buildDrafterPrompt(
          description,
          templateContent,
          contextSummary,
        );

        const draftOutput = await collectRuntimeText(
          this.opts.runtime,
          drafterPrompt,
          drafterModel,
          this.opts.cwd,
          readOnlyTools,
          addDirs,
          this.opts.timeoutMs,
        );

        // Write the draft — preserve the header (planId, beadId) from the created file
        planContent = this.mergeDraftWithHeader(planContent, draftOutput);
        await this.atomicWrite(filePath, planContent);

        // Update bead title to match the drafter's Plan title (raw user input is often messy).
        const drafterTitleMatch = draftOutput.match(/^# Plan:\s*(.+)$/m);
        const mergedHeader = parsePlanFileHeader(planContent);
        const drafterTitle = drafterTitleMatch?.[1]?.trim();
        if (mergedHeader?.beadId && drafterTitle && drafterTitle !== description) {
          try {
            await bdUpdate(mergedHeader.beadId, { title: drafterTitle }, this.opts.beadsCwd);
          } catch {
            // best-effort — bead title update failure shouldn't block the forge
          }
        }
      } else if (round > startRound) {
        await onProgress(
          `Forging ${planId}... Revision complete. Audit round ${round}/${maxRound}...`,
        );
      }

      // Audit phase
      await onProgress(
        round === startRound && startRound === 1
          ? `Forging ${planId}... Draft complete. Audit round ${round}/${maxRound}...`
          : `Forging ${planId}... Audit round ${round}/${maxRound}...`,
      );

      const auditorPrompt = buildAuditorPrompt(planContent, round, projectContext);
      const auditOutput = await collectRuntimeText(
        this.opts.runtime,
        auditorPrompt,
        auditorModel,
        this.opts.cwd,
        readOnlyTools,
        addDirs,
        this.opts.timeoutMs,
      );

      lastAuditNotes = auditOutput;
      lastVerdict = parseAuditVerdict(auditOutput);

      // Append audit notes to the plan file
      planContent = appendAuditRound(planContent, round, auditOutput, lastVerdict);
      await this.atomicWrite(filePath, planContent);

      // Check if we should loop
      if (!lastVerdict.shouldLoop) {
        await this.updatePlanStatus(filePath, 'REVIEW');
        // Re-read to get updated status in the summary
        planContent = await fs.readFile(filePath, 'utf-8');
        const summary = buildPlanSummary(planContent);
        const elapsed = Math.round((Date.now() - t0) / 1000);
        await onProgress(
          `Forge complete. Plan ${planId} ready for review (${round - startRound + 1} round${round - startRound + 1 > 1 ? 's' : ''}, ${elapsed}s)`,
          { force: true },
        );
        return {
          planId,
          filePath,
          finalVerdict: lastVerdict.maxSeverity,
          rounds: round - startRound + 1,
          reachedMaxRounds: false,
          planSummary: summary,
        };
      }

      // Check if we've hit the cap
      if (round >= maxRound) {
        break;
      }

      // Revision phase
      await onProgress(
        `Forging ${planId}... Audit round ${round} found ${lastVerdict.maxSeverity} concerns. Revising...`,
      );

      const revisionPrompt = buildRevisionPrompt(
        planContent,
        auditOutput,
        description,
        projectContext,
      );

      const revisionOutput = await collectRuntimeText(
        this.opts.runtime,
        revisionPrompt,
        drafterModel,
        this.opts.cwd,
        readOnlyTools,
        addDirs,
        this.opts.timeoutMs,
      );

      planContent = this.mergeDraftWithHeader(planContent, revisionOutput);
      await this.atomicWrite(filePath, planContent);
    }

    // Cap reached
    planContent = planContent.replace(
      /(\n---\n\n## Implementation Notes)/,
      `\n\nVERDICT: CAP_REACHED\n$1`,
    );
    await this.atomicWrite(filePath, planContent);
    await this.updatePlanStatus(filePath, 'REVIEW');
    // Re-read to get updated status in the summary
    planContent = await fs.readFile(filePath, 'utf-8');
    const summary = buildPlanSummary(planContent);

    const elapsed = Math.round((Date.now() - t0) / 1000);
    await onProgress(
      `Forge stopped after ${this.opts.maxAuditRounds} audit rounds — concerns remain. Review manually: \`!plan show ${planId}\``,
      { force: true },
    );

    return {
      planId,
      filePath,
      finalVerdict: lastVerdict.maxSeverity,
      rounds: round - startRound + 1,
      reachedMaxRounds: true,
      planSummary: summary,
    };
  }

  private async buildContextSummary(projectContext?: string): Promise<string> {
    const contextFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'];
    const sections: string[] = [];
    for (const name of contextFiles) {
      const p = path.join(this.opts.workspaceCwd, name);
      try {
        const content = await fs.readFile(p, 'utf-8');
        sections.push(`--- ${name} ---\n${content.trimEnd()}`);
      } catch {
        // skip missing files
      }
    }

    // Append project context if already loaded
    if (projectContext) {
      sections.push(`--- project.md (repo) ---\n${projectContext.trimEnd()}`);
    }

    if (sections.length === 0) {
      return '(No workspace context files found.)';
    }
    return sections.join('\n\n');
  }

  private async loadProjectContext(): Promise<string | undefined> {
    const projectContextPath = path.join(this.opts.cwd, '.context', 'project.md');
    try {
      const content = await fs.readFile(projectContextPath, 'utf-8');
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Merge drafter output into the plan file, preserving the system-generated header
   * (plan ID, bead ID, created date) from the original file.
   */
  private mergeDraftWithHeader(originalContent: string, draftOutput: string): string {
    // Extract the header from the original file (up to and including the first ---)
    const headerMatch = originalContent.match(/^([\s\S]*?\*\*Project:\*\*[^\n]*\n)/);
    if (!headerMatch) return draftOutput;

    const header = headerMatch[1];

    // Strip any header the drafter may have generated
    const draftBody = draftOutput.replace(/^[\s\S]*?\*\*Project:\*\*[^\n]*\n/, '');

    // If the drafter didn't include a header, just prepend the original one
    if (draftBody === draftOutput) {
      // The drafter output doesn't have the header pattern — prepend the original header
      const planTitleMatch = draftOutput.match(/^# Plan:[^\n]*\n/);
      if (planTitleMatch) {
        // Has a plan title but different header format — replace just the metadata
        const titleLine = planTitleMatch[0];
        const afterTitle = draftOutput.slice(titleLine.length);
        const originalTitle = header.match(/^# Plan:[^\n]*\n/)?.[0] ?? '';
        return header.replace(originalTitle, titleLine) + afterTitle;
      }
      return header + '\n---\n\n' + draftOutput;
    }

    return header + draftBody;
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private async updatePlanStatus(filePath: string, newStatus: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const updated = content.replace(
      /^\*\*Status:\*\*\s*.+$/m,
      `**Status:** ${newStatus}`,
    );
    await this.atomicWrite(filePath, updated);
  }
}
