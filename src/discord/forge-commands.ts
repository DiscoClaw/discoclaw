import fs from 'node:fs/promises';
import path from 'node:path';
import { createPlan, parsePlanFileHeader, resolvePlanHeaderTaskId } from './plan-commands.js';
import type { TaskStore } from '../tasks/store.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { runPipeline } from '../pipeline/engine.js';
import { auditPlanStructure, deriveVerdict, maxReviewNumber } from './audit-handler.js';
import { resolveModel } from '../runtime/model-tiers.js';
import { parseAuditVerdict } from './forge-audit-verdict.js';
import type { AuditVerdict } from './forge-audit-verdict.js';
import { getSection, parsePlan } from './plan-parser.js';
import { PHASE_SAFETY_REMINDER } from '../runtime/strategies/claude-strategy.js';
import { matchesDestructivePattern } from '../runtime/tool-call-gate.js';
export { parseAuditVerdict };
export type { AuditVerdict };

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
  drafterRuntime?: RuntimeAdapter;
  auditorRuntime?: RuntimeAdapter;
  model: string;
  cwd: string;
  workspaceCwd: string;
  taskStore: TaskStore;
  plansDir: string;
  maxAuditRounds: number;
  progressThrottleMs: number;
  timeoutMs: number;
  drafterModel?: string;
  auditorModel?: string;
  log?: LoggerLike;
  /** When set, reuse this task instead of creating a new one (e.g. when issued in a task forum thread). */
  existingTaskId?: string;
  /** Optional summary of the task description to expose to the drafter. */
  taskDescription?: string;
  /** Optional pinned-thread summary to expose to the drafter. */
  pinnedThreadSummary?: string;
};

type ProgressFn = (msg: string, opts?: { force?: boolean }) => Promise<void>;
type EventFn = (evt: EngineEvent) => void;

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
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDrafterPrompt(
  description: string,
  templateContent: string,
  contextSummary: string,
): string {
  return [
    PHASE_SAFETY_REMINDER,
    '',
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
    '- **`## Changes` is a required top-level section.** List every file that will be created, modified, or deleted with concrete file paths. Do not place file change information inside a `## Phases` section or any other section — changes belong exclusively in `## Changes`. If you need to describe implementation sequencing, use a separate `## Phases` section.',
    '- Be specific in the `## Changes` section — include actual file paths, function names, and type signatures.',
    '- Identify real risks and dependencies based on the actual codebase.',
    '- Write concrete, verifiable test cases.',
    '- Include documentation updates in the Changes section when adding new features, config options, or public APIs. Consider: docs/*.md, .env.example files, README.md, INVENTORY.md, and inline code comments.',
    '- Set the status to DRAFT.',
    '- Replace all {{PLACEHOLDER}} tokens with actual values. The plan ID and task ID will be filled in by the system — use `(system)` as placeholders for those.',
    '- Output the complete plan markdown and nothing else.',
  ].join('\n');
}

export function buildAuditorPrompt(
  planContent: string,
  roundNumber: number,
  projectContext?: string,
  opts?: { hasTools?: boolean },
): string {
  const sections = [
    PHASE_SAFETY_REMINDER,
    '',
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

  const hasTools = opts?.hasTools ?? true;

  instructions.push(
    'Review the plan for:',
    '1. Missing or underspecified details (vague scope, unclear file changes)',
    '2. Structural integrity — the plan MUST have a `## Changes` section with concrete file paths. If file changes are described only inside a `## Phases` section (or any section other than `## Changes`), flag it as **blocking**.',
    '3. Architectural issues (wrong abstraction, missing error handling, wrong patterns)',
    '4. Risk gaps (unidentified failure modes, missing rollback plans)',
    '5. Test coverage gaps (missing edge cases, untested error paths)',
    '6. Dependency issues (circular deps, version conflicts, missing imports)',
    '7. Documentation gaps (does the plan update relevant docs, README, .env.example, INVENTORY.md, or inline comments for new/changed features, config options, or public APIs? Missing doc updates are medium severity.)',
    '',
  );

  if (hasTools) {
    instructions.push(
      '## Verification',
      '',
      'You have read-only access to the codebase via Read, Glob, and Grep tools. **Use them before raising concerns.** Specifically:',
      '- Before claiming a file is missing or incomplete, Glob/Read it.',
      '- Before claiming test coverage gaps, Grep for existing tests.',
      '- Before claiming missing error handling, Read the relevant code.',
      '- If your concern evaporates after checking the code, do not raise it.',
      '',
    );
  } else {
    instructions.push(
      '## Verification',
      '',
      'You do not have access to the codebase. Audit the plan based on its text alone.',
      '- If you are uncertain whether a file exists or a function signature is correct, note it as a concern rather than stating it as fact.',
      '- Focus on logical consistency, completeness, and architectural soundness.',
      '',
    );
  }

  instructions.push(
    '## Output Format',
    '',
    'Start with a fenced JSON verdict block (this is required):',
    '```json',
    '{"maxSeverity":"blocking|medium|minor|suggestion|none","shouldLoop":true|false,"summary":"brief summary","concerns":[{"title":"...","severity":"blocking|medium|minor|suggestion"}]}',
    '```',
    'Rules:',
    '- `maxSeverity` must reflect the highest severity in the concerns list.',
    '- `shouldLoop` must be true only when `maxSeverity` is `blocking`.',
    '- Keep `summary` concise and factual.',
    '',
    'After the JSON block, include human-readable notes.',
    '',
    'For each concern, use this EXACT format:',
    '',
    '**Concern N: [title]**',
    'Description of the issue.',
    '**Severity: blocking | medium | minor | suggestion**',
    '',
    'Severity level definitions:',
    '- **blocking** — Correctness bugs, security issues, architectural flaws, missing critical functionality. The plan cannot ship with this unresolved.',
    '- **medium** — Substantive improvements that would make the plan better but aren\'t showstoppers. Missing edge case handling, incomplete error paths.',
    '- **minor** — Small issues: naming, style, minor clarity gaps. Worth noting, not worth looping over.',
    '- **suggestion** — Ideas for future improvement. Not problems with the current plan.',
    '',
    'IMPORTANT: Each concern MUST have its own **Severity: X** line on a separate line. Do NOT use tables, summary grids, or any other format for severity ratings — the automated revision loop parses these markers to decide whether to trigger revisions.',
    '',
    'Then write a verdict:',
    '',
    '**Verdict:** [one of:]',
    '- "Needs revision." — if any blocking severity concerns exist',
    '- "Ready to approve." — if no blocking concerns (medium/minor/suggestion are fine)',
    '',
    'Be thorough but fair. Don\'t nitpick style — focus on correctness, safety, and completeness.',
    'Output only the JSON block plus audit notes and verdict. No preamble.',
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
    PHASE_SAFETY_REMINDER,
    '',
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
    '- Address all blocking severity concerns. Consider medium concerns if the fix is straightforward, but do not loop over them.',
    '- Read the codebase using your tools if needed to resolve concerns.',
    '- Keep the same plan structure and format.',
    '- Preserve resolutions from prior audit rounds that were accepted — do not weaken, revert, or remove them unless the current audit explicitly challenges them.',
    '- **Push back on re-raised concerns.** If a concern is a refinement or restatement of something already resolved in a prior round, you may note it as "previously addressed" in the resolution and decline to make further changes. The auditor should raise genuinely new issues, not re-litigate resolved ones from a slightly different angle.',
    '- **Reject perfectionism beyond the plan\'s goal.** If a concern demands a standard higher than what the plan set out to achieve (e.g., provably decodable payloads when the goal is "reject obviously broken ones"), acknowledge the concern but explain why the current approach is sufficient. Not every valid observation requires a code change.',
    '- Output the complete revised plan markdown starting with `# Plan:`. Output ONLY the plan markdown — no preamble, no explanation.',
  );

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Plan summary extraction
// ---------------------------------------------------------------------------

export function buildPlanSummary(planContent: string): string {
  const header = parsePlanFileHeader(planContent);
  const parsedPlan = parsePlan(planContent);

  const objective = getSection(parsedPlan, 'Objective') || '(no objective)';

  // Extract scope (just the "In:" section if present, otherwise the whole scope block)
  const scopeBlock = getSection(parsedPlan, 'Scope');
  let scope = '';
  if (scopeBlock) {
    const scopeText = scopeBlock.trim();
    const inMatch = scopeText.match(/\*\*In:\*\*\s*\n([\s\S]*?)(?=\n\*\*Out:\*\*|$)/);
    scope = inMatch?.[1]?.trim() || scopeText;
  }

  // Extract changed files (look for file paths in the Changes section)
  const changesBlock = getSection(parsedPlan, 'Changes');
  const files: string[] = [];
  if (changesBlock) {
    const fileMatches = changesBlock.matchAll(/####\s+`([^`]+)`/g);
    for (const m of fileMatches) {
      files.push(m[1]!);
    }
  }

  const lines: string[] = [];

  if (header) {
    lines.push(`**${header.planId}** — ${header.title}`);
    lines.push(`Status: ${header.status} | Task: \`${resolvePlanHeaderTaskId(header)}\``);
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
// Runtime event-forwarding wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a RuntimeAdapter so every emitted EngineEvent is optionally forwarded
 * to `onEvent` before being yielded to the pipeline engine. Errors thrown by
 * `onEvent` are swallowed to prevent UI callbacks from aborting execution.
 *
 * When `onDestructive` is provided, every `tool_start` event is checked against
 * the destructive-pattern registry and the callback is invoked on the first match.
 */
function wrapWithEventForwarding(
  rt: RuntimeAdapter,
  onEvent: ((evt: EngineEvent) => void) | undefined,
  onDestructive?: (reason: string) => void,
): RuntimeAdapter {
  return {
    id: rt.id,
    capabilities: rt.capabilities,
    invoke(params) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        for await (const evt of rt.invoke(params)) {
          if (onDestructive && evt.type === 'tool_start') {
            const { matched, reason } = matchesDestructivePattern(evt.name, evt.input);
            if (matched) onDestructive(reason);
          }
          if (onEvent) {
            try { onEvent(evt); } catch { /* UI callback errors must not abort execution */ }
          }
          yield evt;
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the error message indicates a transient hang, stall, or
 * unexpected crash that is safe to retry automatically.
 *
 * Pattern origins:
 *  - 'hang detected'               — hang detector timeout in subprocess watcher
 *  - 'stream stall'                — pipeline stream inactivity watchdog
 *  - 'progress stall'              — pipeline progress inactivity watchdog
 *  - 'timed out'                   — general timeout (e.g. AbortController deadline)
 *  - 'process exited unexpectedly' — subprocess crash before completing output
 *  - 'stdin write failed'          — broken pipe writing to subprocess stdin
 */
export function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('hang detected') ||
    lower.includes('stream stall') ||
    lower.includes('progress stall') ||
    lower.includes('timed out') ||
    lower.includes('process exited unexpectedly') ||
    lower.includes('stdin write failed')
  );
}

// ---------------------------------------------------------------------------
// ForgeOrchestrator
// ---------------------------------------------------------------------------

export class ForgeOrchestrator {
  private running = false;
  private cancelRequested = false;
  private destructiveDetected = false;
  private destructiveReason = '';
  private abortController = new AbortController();
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
    this.abortController.abort();
  }

  async run(
    description: string,
    onProgress: ProgressFn,
    context?: string,
    onEvent?: EventFn,
  ): Promise<ForgeResult> {
    if (this.running) {
      throw new Error('A forge is already running');
    }
    this.running = true;
    this.cancelRequested = false;
    this.abortController = new AbortController();
    this.currentPlanId = undefined;
    const t0 = Date.now();

    let planId = '';
    let filePath = '';

    try {
      // 1. Create the plan file with a typed response.
      // Pass context separately so task title/slug stay clean (context goes in plan body).
      const created = await createPlan(
        {
          description,
          context,
          existingTaskId: this.opts.existingTaskId,
        },
        {
          workspaceCwd: this.opts.workspaceCwd,
          taskStore: this.opts.taskStore,
          plansDir: this.opts.plansDir,
        },
      );
      planId = created.planId;
      filePath = created.filePath;
      this.currentPlanId = planId;

      const plansDir = this.opts.plansDir;

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

      // Build context summary from workspace files (includes project context and additional thread info)
      const contextSummary = await this.buildContextSummary(projectContext, {
        taskDescription: this.opts.taskDescription,
        pinnedThreadSummary: this.opts.pinnedThreadSummary,
      });

      return await this.auditLoop({
        planId,
        filePath,
        description: context ? `${description}\n\n${context}` : description,
        startRound: 1,
        onProgress,
        onEvent,
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
    onEvent?: EventFn,
  ): Promise<ForgeResult> {
    if (this.running) {
      throw new Error('A forge is already running');
    }
    this.running = true;
    this.cancelRequested = false;
    this.abortController = new AbortController();
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

      // Structural pre-flight: reject plans with high or medium structural issues
      const structuralConcerns = auditPlanStructure(planContent);
      const structuralVerdict = deriveVerdict(structuralConcerns);
      if (structuralVerdict.shouldLoop) {
        const gating = structuralConcerns.filter((c) => c.severity === 'high' || c.severity === 'medium');
        const missing = gating.map((c) => c.title).join(', ');
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
        onEvent,
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
    onEvent?: EventFn;
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
      onEvent,
      projectContext,
      templateContent,
      contextSummary,
    } = params;
    const t0 = params.t0 ?? Date.now();

    this.destructiveDetected = false;
    this.destructiveReason = '';
    const onDestructive = (reason: string): void => {
      this.destructiveDetected = true;
      this.destructiveReason = reason;
    };

    const rawDrafterModel = this.opts.drafterModel ?? this.opts.model;
    const rawAuditorModel = this.opts.auditorModel ?? this.opts.model;
    const drafterRt = this.opts.drafterRuntime ?? this.opts.runtime;
    const isClaudeDrafter = drafterRt.id === 'claude_code';
    const hasExplicitDrafterModel = Boolean(this.opts.drafterModel);
    const drafterModel = isClaudeDrafter
      ? resolveModel(rawDrafterModel, drafterRt.id)
      : (hasExplicitDrafterModel ? resolveModel(rawDrafterModel, drafterRt.id) : '');
    const readOnlyTools = ['Read', 'Glob', 'Grep'];
    const addDirs = [this.opts.cwd];

    // Stable session keys — one per role — enable multi-turn reuse across
    // the audit-revise loop.  Keys use raw (pre-resolution) tier names so
    // they remain stable if the tier→model mapping changes.
    const drafterSessionKey = `forge:${planId}:${rawDrafterModel}:drafter`;
    const auditorSessionKey = `forge:${planId}:${rawAuditorModel}:auditor`;

    // Wrap drafter runtime to forward events and detect destructive tool calls.
    const effectiveDrafterRt = wrapWithEventForwarding(drafterRt, onEvent, onDestructive);

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

      if (this.destructiveDetected) {
        await this.updatePlanStatus(filePath, 'CANCELLED');
        await onProgress(
          `Forge halted — destructive tool call blocked (${this.destructiveReason}). Plan saved: \`!plan show ${planId}\``,
          { force: true },
        );
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

        const draftPipelineResult = await this.runWithRetry({
          steps: [{
            kind: 'prompt',
            prompt: drafterPrompt,
            runtime: effectiveDrafterRt,
            model: drafterModel,
            tools: readOnlyTools,
            addDirs,
            timeoutMs: this.opts.timeoutMs,
            sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
          }],
          runtime: this.opts.runtime,
          cwd: this.opts.cwd,
          model: this.opts.model,
          signal: this.abortController.signal,
        }, 'Draft', onProgress);
        if (!draftPipelineResult) {
          await this.updatePlanStatus(filePath, 'CANCELLED');
          return {
            planId,
            filePath,
            finalVerdict: 'CANCELLED',
            rounds: round - startRound + 1,
            reachedMaxRounds: false,
          };
        }
        const draftOutput = draftPipelineResult.outputs[0] ?? '';

        // Write the draft — preserve the header (planId, taskId) from the created file.
        planContent = this.mergeDraftWithHeader(planContent, draftOutput);
        await this.atomicWrite(filePath, planContent);

        // Update task title to match the drafter's Plan title (raw user input is often messy).
        const drafterTitleMatch = draftOutput.match(/^# Plan:\s*(.+)$/m);
        const mergedHeader = parsePlanFileHeader(planContent);
        const drafterTitle = drafterTitleMatch?.[1]?.trim();
        const taskId = mergedHeader ? resolvePlanHeaderTaskId(mergedHeader) : '';
        if (taskId && drafterTitle && drafterTitle !== description) {
          try {
            this.opts.taskStore.update(taskId, { title: drafterTitle });
          } catch {
            // best-effort — task title update failure shouldn't block the forge
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

      const auditorRt = this.opts.auditorRuntime ?? this.opts.runtime;
      const isClaudeAuditor = auditorRt.id === 'claude_code';
      const auditorHasFileTools = auditorRt.capabilities.has('tools_fs');
      const hasExplicitAuditorModel = Boolean(this.opts.auditorModel);
      const effectiveAuditorModel = isClaudeAuditor
        ? resolveModel(rawAuditorModel, auditorRt.id)
        : (hasExplicitAuditorModel ? resolveModel(rawAuditorModel, auditorRt.id) : '');

      const auditorPrompt = buildAuditorPrompt(
        planContent,
        round,
        projectContext,
        { hasTools: auditorHasFileTools },
      );
      const effectiveAuditorRt = wrapWithEventForwarding(auditorRt, onEvent, onDestructive);
      const auditPipelineResult = await this.runWithRetry({
        steps: [{
          kind: 'prompt',
          prompt: auditorPrompt,
          runtime: effectiveAuditorRt,
          model: effectiveAuditorModel,
          tools: auditorHasFileTools ? readOnlyTools : [],
          ...(auditorHasFileTools ? { addDirs } : {}),
          timeoutMs: this.opts.timeoutMs,
          sessionKey: auditorRt.capabilities.has('sessions') ? auditorSessionKey : undefined,
        }],
        runtime: this.opts.runtime,
        cwd: this.opts.cwd,
        model: this.opts.model,
        signal: this.abortController.signal,
      }, `Audit round ${round}`, onProgress);
      if (!auditPipelineResult) {
        await this.updatePlanStatus(filePath, 'CANCELLED');
        return {
          planId,
          filePath,
          finalVerdict: 'CANCELLED',
          rounds: round - startRound + 1,
          reachedMaxRounds: false,
        };
      }
      const auditOutput = auditPipelineResult.outputs[0] ?? '';

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

      const revisionPipelineResult = await this.runWithRetry({
        steps: [{
          kind: 'prompt',
          prompt: revisionPrompt,
          runtime: effectiveDrafterRt,
          model: drafterModel,
          tools: readOnlyTools,
          addDirs,
          timeoutMs: this.opts.timeoutMs,
          sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
        }],
        runtime: this.opts.runtime,
        cwd: this.opts.cwd,
        model: this.opts.model,
        signal: this.abortController.signal,
      }, `Revision after round ${round}`, onProgress);
      if (!revisionPipelineResult) {
        await this.updatePlanStatus(filePath, 'CANCELLED');
        return {
          planId,
          filePath,
          finalVerdict: 'CANCELLED',
          rounds: round - startRound + 1,
          reachedMaxRounds: false,
        };
      }
      const revisionOutput = revisionPipelineResult.outputs[0] ?? '';

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

  private async buildContextSummary(
    projectContext?: string,
    opts?: {
      taskDescription?: string;
      pinnedThreadSummary?: string;
    },
  ): Promise<string> {
    const contextFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md'];
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

    // Append tools context from repo .context/ directory
    try {
      const toolsContextPath = path.join(this.opts.cwd, '.context', 'tools.md');
      const toolsContent = await fs.readFile(toolsContextPath, 'utf-8');
      sections.push(`--- tools.md (repo) ---\n${toolsContent.trimEnd()}`);
    } catch {
      // skip if missing
    }

    const taskDescription = opts?.taskDescription;
    if (taskDescription) {
      sections.push(`--- task-description (thread) ---\n${taskDescription.trim()}`);
    }

    if (opts?.pinnedThreadSummary) {
      sections.push(`--- pinned-thread summary ---\n${opts.pinnedThreadSummary.trim()}`);
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
   * (plan ID, task ID, created date) from the original file.
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

  /**
   * Runs `runPipeline` with the abort signal attached. Returns null if the run
   * was cancelled (either the pipeline threw while `cancelRequested` was set, or
   * it returned normally but `cancelRequested` was set before outputs are used).
   */
  private async runCancellable(
    def: Parameters<typeof runPipeline>[0],
  ): Promise<{ outputs: string[] } | null> {
    try {
      const result = await runPipeline(def);
      if (this.cancelRequested) return null;
      return result;
    } catch (err) {
      if (this.cancelRequested) return null;
      throw err;
    }
  }

  /**
   * Runs a pipeline phase with one automatic retry on transient failures.
   * Only retries when `isRetryableError` matches the first error message.
   * If the first error is NOT retryable, throws immediately with phase context.
   * Posts a phase-specific stall notice to Discord via onProgress before retrying.
   * Returns null if the run was cancelled; throws with a phase-specific message
   * if the error is non-retryable or both attempts fail.
   */
  private async runWithRetry(
    def: Parameters<typeof runPipeline>[0],
    phase: string,
    onProgress: ProgressFn,
  ): Promise<{ outputs: string[] } | null> {
    try {
      return await this.runCancellable(def);
    } catch (firstErr) {
      if (this.cancelRequested) return null;
      const firstMsg = String(firstErr instanceof Error ? firstErr.message : firstErr);
      if (!isRetryableError(firstMsg)) {
        throw new Error(`${phase} failed: ${firstMsg}`);
      }
      this.opts.log?.warn({ err: firstErr, phase }, 'forge:retry');
      await onProgress(`Forge ${phase} stalled — retrying...`, { force: true });
      try {
        return await this.runCancellable(def);
      } catch (secondErr) {
        if (this.cancelRequested) return null;
        const secondMsg = String(secondErr instanceof Error ? secondErr.message : secondErr);
        throw new Error(`${phase} failed after retry: ${secondMsg}`);
      }
    }
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

export const legacyPlanImplementationCta = (planId: string): string =>
  `Reply \`!plan approve ${planId}\` to approve, then \`!plan run ${planId}\` to start implementation. Or \`!plan show ${planId}\` to review first.`;

export function buildPlanImplementationMessage(
  skipReason: string | undefined,
  planId: string,
): string {
  const cta = legacyPlanImplementationCta(planId);
  if (!skipReason) return cta;
  if (skipReason.includes(cta)) return skipReason;
  return `${skipReason}\n\n${cta}`;
}
