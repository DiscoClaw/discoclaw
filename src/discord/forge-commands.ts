import fs from 'node:fs/promises';
import path from 'node:path';
import { createPlan, parsePlanFileHeader, resolvePlanHeaderTaskId } from './plan-commands.js';
import type { TaskStore } from '../tasks/store.js';
import type { RuntimeAdapter, EngineEvent, RuntimeSupervisorPolicy } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { runPipeline } from '../pipeline/engine.js';
import { auditPlanStructure, deriveVerdict, maxReviewNumber } from './audit-handler.js';
import { resolveModel, resolveReasoningEffort } from '../runtime/model-tiers.js';
import { parseAuditVerdict } from './forge-audit-verdict.js';
import type { AuditVerdict } from './forge-audit-verdict.js';
import { getSection, parsePlan } from './plan-parser.js';
import { PHASE_SAFETY_REMINDER } from '../runtime/strategies/claude-strategy.js';
import { buildPromptPreamble } from './prompt-common.js';
import { createPhaseStatusHeartbeatController, resolvePlanHeaderHeartbeatPolicy } from './phase-status-heartbeat.js';
export { parseAuditVerdict };
export type { AuditVerdict };

const COMPOUND_LESSONS_PATH = 'docs/compound-lessons.md';
const FORGE_STREAM_STALL_TIMEOUT_MS = 2 * 60_000;
const FORGE_PROGRESS_STALL_TIMEOUT_MS = 3 * 60_000;
const FORGE_PLAN_PHASE_SUPERVISOR_POLICY: RuntimeSupervisorPolicy = {
  profile: 'plan_phase',
  treatAbortedAsRetryable: true,
  maxSignatureRepeats: 3,
  limits: {
    maxCycles: 6,
    maxRetries: 5,
    maxEscalationLevel: 4,
  },
};
const FORGE_GROUNDING_PHASE_SUPERVISOR_POLICY: RuntimeSupervisorPolicy = {
  profile: 'plan_phase',
  treatAbortedAsRetryable: true,
  maxSignatureRepeats: 1,
  limits: {
    maxCycles: 1,
    maxRetries: 0,
  },
};

// ---------------------------------------------------------------------------
// Audit criteria — single source of truth, referenced at top/middle/bottom of
// the auditor prompt to counteract primacy bias and "lost in the middle" effects.
// ---------------------------------------------------------------------------

export const AUDIT_CRITERIA_LINES: string[] = [
  '1. Missing or underspecified details (vague scope, unclear file changes)',
  '2. Structural integrity — the plan MUST have a `## Changes` section with concrete file paths. If file changes are described only inside a `## Phases` section (or any section other than `## Changes`), flag it as **blocking**.',
  '3. Enforceability of restrictions — if the plan claims a limited capability ("read-only", "post-only", "only these actions"), it must name the concrete enforcement mechanism in the current codebase or explicitly add one. If the mechanism does not exist, flag it as **blocking**.',
  '4. Architectural issues (wrong abstraction, missing error handling, wrong patterns)',
  '5. Risk gaps (unidentified failure modes, missing rollback plans)',
  '6. Test coverage gaps (missing edge cases, untested error paths)',
  '7. Dependency issues (circular deps, version conflicts, missing imports)',
  `8. Documentation gaps (does the plan update relevant docs, README, .env.example, INVENTORY.md, inline comments, or \`${COMPOUND_LESSONS_PATH}\` when the work codifies a durable engineering lesson? Trigger sources include audits, forge runs, postmortems, incidents, task/chat context, and repeated workflow failures. Trigger-driven changes must record a lesson-promotion decision: update an existing \`${COMPOUND_LESSONS_PATH}\` entry, add a materially distinct new entry, or explicitly explain why no promotion is needed. Review steps must include a dedup check before merge. Missing doc updates are medium severity.)`,
];

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
  structuralWarning?: string;
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
  planForgeHeartbeatIntervalMs?: number;
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

const FORGE_PROGRESS_ICON = {
  draft: '📝',
  audit: '🔍',
  revise: '✏️',
  retry: '🔄',
  success: '✅',
  cancelled: '🛑',
  failed: '❌',
  warning: '⚠️',
} as const;

function withForgeIcon(icon: string, message: string): string {
  return `${icon} ${message}`;
}

function resolveForgePhaseLiveness(timeoutMs: number | undefined): {
  streamStallTimeoutMs: number | undefined;
  progressStallTimeoutMs: number | undefined;
} {
  const boundedTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
  return {
    streamStallTimeoutMs: boundedTimeoutMs === undefined
      ? FORGE_STREAM_STALL_TIMEOUT_MS
      : Math.min(FORGE_STREAM_STALL_TIMEOUT_MS, boundedTimeoutMs),
    progressStallTimeoutMs: boundedTimeoutMs === undefined
      ? FORGE_PROGRESS_STALL_TIMEOUT_MS
      : Math.min(FORGE_PROGRESS_STALL_TIMEOUT_MS, boundedTimeoutMs),
  };
}

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
// Template helpers
// ---------------------------------------------------------------------------

/**
 * Strips the header (everything up to and including the first `---` separator)
 * from a plan template, returning only the body sections (## Objective, ## Scope, etc.).
 * If no `---` separator is found, returns the full content unchanged.
 */
export function stripTemplateHeader(template: string): string {
  const separatorIdx = template.indexOf('\n---\n');
  if (separatorIdx === -1) return template;
  return template.slice(separatorIdx + '\n---\n'.length).trimStart();
}

/**
 * Detects when drafter output looks like an unfilled template rather than a
 * genuine draft. Returns true if the output contains mustache tokens (`{{...}}`),
 * `(system)` as a metadata value, or known FALLBACK_TEMPLATE placeholder phrases.
 * Checks against body text only, ignoring fenced code blocks.
 */
export function isTemplateEchoed(output: string): boolean {
  // Strip fenced code blocks so we only inspect prose/body text
  const bodyText = output.replace(/```[\s\S]*?```/g, '');

  // Check for mustache tokens
  if (/\{\{[A-Z_]+\}\}/.test(bodyText)) return true;

  // Check for (system) as a metadata value (e.g. **ID:** (system))
  if (/\(system\)/i.test(bodyText)) return true;

  // Check for FALLBACK_TEMPLATE placeholder phrases (single hit sufficient —
  // these italic markdown phrases are distinctive enough to be conclusive).
  const fallbackPhrases = [
    '_Describe the objective here._',
    '_Define what\'s in and out of scope._',
    '_List file-by-file changes._',
  ];
  for (const phrase of fallbackPhrases) {
    if (bodyText.includes(phrase)) return true;
  }

  // Check for .plan-template.md example phrases. Require 2+ hits so a
  // single matching line doesn't trigger false positives in genuine plans.
  const templatePhrases = [
    // Legacy template examples (kept for compatibility with older plans)
    '`path/to/file.ts` — what changes and why',
    '`path/to/other.ts` — what changes and why',
    '`path/to/new.ts` — purpose',
    '`path/to/old.ts` — why it\'s safe to remove',
    // Current template examples
    '`src/discord/plan-commands.ts` — what changes and why',
    '`src/discord/plan-manager.ts` — what changes and why',
    '`src/discord/plan-helpers.ts` — purpose',
    '`src/discord/legacy-plan-parser.ts` — why it\'s safe to remove',
  ];
  let templateHits = 0;
  for (const phrase of templatePhrases) {
    if (bodyText.includes(phrase)) templateHits++;
  }
  if (templateHits >= 2) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Template-echo retry prefix
// ---------------------------------------------------------------------------

const TEMPLATE_ECHO_RETRY_PREFIX = [
  'IMPORTANT: Your previous attempt returned the template verbatim instead of a real plan.',
  'You MUST read the codebase using your tools (Read, Glob, Grep) and produce substantive',
  'analysis based on the actual code. Do NOT echo the template structure with placeholder text.',
  '',
  '',
].join('\n');

const PLAN_OUTPUT_RETRY_PREFIX = [
  'IMPORTANT: Your previous attempt started with narration or other text outside the plan.',
  'Restart cleanly and output only the final plan markdown.',
  'The very first line of your response MUST begin with `# Plan:`.',
  'Do NOT describe what you are inspecting, reading, or about to do.',
  '',
  '',
].join('\n');
const PLAN_OUTPUT_NO_TOOLS_RETRY_PREFIX = [
  'IMPORTANT: Your previous attempt spent too long using tools without producing plan text.',
  'Do NOT use tools on this retry.',
  'Answer from the provided context only and output the final plan markdown immediately.',
  '',
  '',
].join('\n');

const PLAN_MARKDOWN_PREFIX = '# Plan:';
const GROUNDING_OUTPUT_MAX_LEADING_CHARS = 64;
const PLAN_OUTPUT_STEER_MESSAGE = [
  'Restart your answer now.',
  'Stop using tools once you have enough context.',
  'Do not narrate your process.',
  'Output only the final plan markdown.',
  'The first line must begin with `# Plan:`.',
].join(' ');
const PLAN_OUTPUT_MAX_LEADING_CHARS = 96;
const PLAN_OUTPUT_SILENT_STEER_DELAY_MS = 60_000;
const PLAN_OUTPUT_DIAGNOSTIC_PREVIEW_CHARS = 160;
const DRAFTER_CODEBASE_TOOLS_INSTRUCTION = '- **Read the codebase using your tools (Read, Glob, Grep) first**, then write the plan. Do not guess — base every section on what you find in the actual code.';
const DRAFTER_NO_TOOLS_RETRY_INSTRUCTION = '- Do NOT use tools on this retry. Base the plan on the task description, template, and provided context only. Write the best concrete plan you can from that material.';
const FORGE_PLAN_SYSTEM_PROMPT = [
  'You are producing a durable plan artifact, not an interactive status update.',
  'Use tools silently when needed, but do not narrate your investigation, tool usage, or intent.',
  'Keep tool use minimal. Once you have enough context, stop and emit the final plan immediately.',
  'Emit only the final plan markdown once you are ready to answer.',
  'The first line must begin with `# Plan:` and no prose may appear before it.',
].join('\n');

function materializePlanTemplateBody(templateContent: string): string {
  const rawBody = stripTemplateHeader(templateContent);
  const today = new Date().toISOString().split('T')[0]!;
  return rawBody.replace(/\{\{[A-Z_]+\}\}/g, today);
}

function formatConcretePlanPaths(paths: readonly string[]): string {
  if (paths.length === 0) return '- None supplied.';
  return paths.map((filePath) => `- \`${filePath}\``).join('\n');
}

function extractConcretePlanPaths(planContent: string): string[] {
  const planForPrompt = stripAuditLogForPrompt(planContent);
  const matches = [...planForPrompt.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((value) => value.includes('/'));
  return [...new Set(matches)];
}

function shouldUseTwoStageCodexPlanFlow(runtime: RuntimeAdapter): boolean {
  return runtime.id === 'codex'
    && runtime.capabilities.has('sessions')
    && runtime.capabilities.has('mid_turn_steering');
}

function resolveForgePlanSystemPrompt(rt: RuntimeAdapter): string | undefined {
  // Native Codex draft/revision turns can suppress answer streaming when the
  // forge plan system prompt is present. The prompt body already enforces the
  // plan contract, so omit the extra system prompt for Codex turns.
  return rt.id === 'codex' ? undefined : FORGE_PLAN_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Degenerate description resolution
// ---------------------------------------------------------------------------

/**
 * Detects degenerate descriptions (pronouns/deictics like "this", "that", "it")
 * and substitutes the task title when available.  This prevents the drafter from
 * receiving `## Task\n\nthis` as its primary instruction.
 */
const DEICTIC_RE = /^(this|that|it|the task|the issue|above|same)$/i;

export function resolveForgeDescription(
  description: string,
  taskStore?: TaskStore,
  existingTaskId?: string,
): string {
  const trimmed = description.trim();
  if (!DEICTIC_RE.test(trimmed)) return description;
  if (!taskStore || !existingTaskId) return description;
  const task = taskStore.get(existingTaskId);
  if (!task?.title) return description;
  return task.title;
}

function stripAuditLogForPrompt(planContent: string): string {
  const auditLogMarker = '\n---\n\n## Audit Log';
  const idx = planContent.indexOf(auditLogMarker);
  return (idx === -1 ? planContent : planContent.slice(0, idx)).trimEnd();
}

function extractCompoundLessonsForPrompt(content: string): string | undefined {
  const lessonsHeading = content.match(/^## Lessons\b[\t ]*$/m);
  if (lessonsHeading?.index === undefined) return undefined;
  const lessons = content.slice(lessonsHeading.index).trim();
  return lessons || undefined;
}

function summarizePriorAuditHistory(planContent: string): string | undefined {
  const auditLogHeading = '\n## Audit Log';
  const implNotesHeading = '\n## Implementation Notes';
  const auditStart = planContent.indexOf(auditLogHeading);
  if (auditStart === -1) return undefined;

  const bodyStart = auditStart + auditLogHeading.length;
  const implStart = planContent.indexOf(implNotesHeading, bodyStart);
  const auditBody = (implStart === -1
    ? planContent.slice(bodyStart)
    : planContent.slice(bodyStart, implStart)).trim();

  if (!auditBody || /^_Audit notes go here\._?$/m.test(auditBody)) return undefined;

  const reviewMatches = [...auditBody.matchAll(/^### Review\s+(\d+)\s+—\s+([^\n]+)$/gm)];
  if (reviewMatches.length === 0) return undefined;

  const summaries: string[] = [];
  for (let i = 0; i < reviewMatches.length; i++) {
    const match = reviewMatches[i]!;
    const sectionStart = match.index ?? 0;
    const sectionEnd = reviewMatches[i + 1]?.index ?? auditBody.length;
    const section = auditBody.slice(sectionStart, sectionEnd);
    const reviewNumber = match[1]!;

    const concerns = [...section.matchAll(
      /\*\*Concern [^:]*:\s*([\s\S]*?)\*\*[\s\S]*?\*\*Severity:\s*(blocking|medium|minor|suggestion)\*\*/g,
    )]
      .map((concernMatch) => {
        const title = concernMatch[1]!.replace(/\s+/g, ' ').trim();
        const severity = concernMatch[2]!;
        return `${title} [${severity}]`;
      });

    if (concerns.length > 0) {
      summaries.push(`- Review ${reviewNumber}: ${concerns.join('; ')}`);
    }
  }

  return summaries.length > 0 ? summaries.join('\n') : undefined;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDrafterPrompt(
  description: string,
  templateContent: string,
  contextSummary: string,
): string {
  const templateBody = materializePlanTemplateBody(templateContent);

  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are a senior software engineer drafting a technical implementation plan.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Instructions',
    '',
    DRAFTER_CODEBASE_TOOLS_INSTRUCTION,
    '- **`## Changes` is a required top-level section.** List every file that will be created, modified, or deleted with concrete repo-relative file paths (for example, `src/discord/forge-commands.ts`). Do not place file change information inside a `## Phases` section or any other section — changes belong exclusively in `## Changes`. If you need to describe implementation sequencing, use a separate `## Phases` section.',
    '- In `## Changes`, each file entry must include a backtick-wrapped path and specific planned edits (function names and type signatures when relevant). Do not use placeholder paths like `path/to/file.ts`.',
    '- If you claim a restriction on what the system can do ("read-only", "post-only", "only these actions", etc.), name the exact enforcement mechanism that makes it true in the current codebase or as part of this plan. Do not rely on policy prose alone.',
    '- Identify real risks and dependencies based on the actual codebase.',
    '- Write concrete, verifiable test cases.',
    '- Include documentation updates in the Changes section when adding new features, config options, or public APIs. Consider: docs/*.md, .env.example files, README.md, INVENTORY.md, and inline code comments.',
    `- Check the existing \`${COMPOUND_LESSONS_PATH}\` entries before proposing a lesson. When the task reveals a reusable pattern, update the existing entry if it already covers the pattern. Add a new \`${COMPOUND_LESSONS_PATH}\` entry to the plan's \`## Changes\` section only when the lesson is materially distinct.`,
    `- When the task codifies a reusable engineering lesson from audits, forge runs, postmortems, incidents, task threads, implementation chat, or repeated workflow failures, treat \`${COMPOUND_LESSONS_PATH}\` as the single checked-in durable artifact. Add it to \`## Changes\` and spell out the artifact contract being introduced or updated: entry format, ownership, update/promotion rules, and review expectations, including the mandatory before-merge promotion decision and dedup check. Do not treat plan-local \`## Audit Log\` or \`## Implementation Notes\` as the durable lesson store.`,
    '- Set the status to DRAFT.',
    '- DO NOT echo the template verbatim — every section must contain substantive analysis of the actual codebase.',
    '- The plan header (ID, Task, Created, Status, Project) is managed by the system — do not include it. Start your output with `# Plan:` followed by the plan title.',
    '- Output the complete plan markdown and nothing else — no preamble, no commentary, no thinking-out-loud. The very first line of your response must be `# Plan:`. Any text before or outside the plan structure will corrupt the plan file.',
    '',
    '## Expected Output Structure',
    '',
    'Follow this structure for the plan body:',
    '',
    '````markdown',
    templateBody,
    '````',
    '',
    '## Project Context',
    '',
    contextSummary,
  ].join('\n');
}

function buildCompactDrafterRetryPrompt(
  description: string,
  templateContent: string,
): string {
  const templateBody = materializePlanTemplateBody(templateContent);

  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are salvaging a stalled plan draft.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Instructions',
    '',
    DRAFTER_NO_TOOLS_RETRY_INSTRUCTION,
    '- Start writing the plan immediately. Do not narrate, explain, or reason aloud.',
    '- Use the task description and template below to produce the best concrete plan you can.',
    '- If a file path or dependency is uncertain, make the best grounded assumption and state that assumption explicitly in the plan.',
    '- Start your answer with `# Plan:` and output only the final plan markdown.',
    '',
    '## Expected Output Structure',
    '',
    '````markdown',
    templateBody,
    '````',
  ].join('\n');
}

function buildCompactRevisionRetryPrompt(
  planContent: string,
  auditNotes: string,
  description: string,
): string {
  const planForPrompt = stripAuditLogForPrompt(planContent);

  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are salvaging a stalled plan revision.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Current Plan',
    '',
    '```markdown',
    planForPrompt,
    '```',
    '',
    '## Latest Audit Feedback',
    '',
    auditNotes,
    '',
    '## Instructions',
    '',
    '- Do NOT use tools on this retry. Revise from the provided plan and audit feedback only.',
    '- Start writing the revised plan immediately. Do not narrate, explain, or reason aloud.',
    '- Address all blocking concerns from the latest audit while preserving already-accepted structure.',
    '- Preserve the plan header fields and overall section layout.',
    '- In `## Changes`, keep concrete backtick-wrapped repo-relative file paths.',
    '- The first line of your answer must be `# Plan: <title>` with the current plan title on the same line.',
    '- Output only the complete revised plan markdown.',
  ].join('\n');
}

function buildCodexDraftGroundingPrompt(description: string): string {
  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are gathering only the concrete repo file paths needed for a later plan-writing turn.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Instructions',
    '',
    '- Read the codebase using your tools (Read, Glob, Grep) only as needed to identify the most likely change files.',
    '- Stop as soon as you have enough concrete repo-relative file paths for the later plan-writing turn.',
    '- Reply with 1-5 lines and nothing else.',
    '- Each line must be exactly one backtick-wrapped repo-relative file path.',
    '- Do NOT draft the plan yet.',
    '- No bullets. No notes. No prose. No `# Plan:` heading.',
  ].join('\n');
}

function buildCodexDraftWritePrompt(
  description: string,
  templateContent: string,
  contextSummary: string,
  groundedInputs: string,
): string {
  const templateBody = materializePlanTemplateBody(templateContent);
  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are writing the final plan artifact from grounded repo inputs that were already gathered in this thread.',
    '',
    '## Task',
    '',
    description,
    '',
    '## Instructions',
    '',
    '- Do NOT inspect the repo further in this turn.',
    '- Use only the grounded repo inputs and project context below.',
    '- In `## Changes`, use concrete repo-relative file paths from the grounded repo inputs below.',
    '- If a detail is still uncertain, make the narrowest explicit assumption in the plan instead of reopening investigation.',
    '- Start your answer with `# Plan:` and output only the final plan markdown.',
    '',
    '## Grounded Repo Inputs',
    '',
    groundedInputs,
    '',
    '## Expected Output Structure',
    '',
    '````markdown',
    templateBody,
    '````',
    '',
    '## Project Context',
    '',
    contextSummary,
  ].join('\n');
}

function buildCodexRevisionGroundingPrompt(
  planContent: string,
  auditNotes: string,
): string {
  const planForPrompt = stripAuditLogForPrompt(planContent);
  return [
    PHASE_SAFETY_REMINDER,
    '',
    'You are gathering grounded repo inputs for revising an existing technical plan.',
    '',
    '## Current Plan',
    '',
    '```markdown',
    planForPrompt,
    '```',
    '',
    '## Latest Audit Feedback',
    '',
    auditNotes,
    '',
    '## Instructions',
    '',
    '- Inspect the repo only as needed to address the latest audit concerns.',
    '- Prefer reusing the file paths already present in the current plan whenever they are sufficient.',
    '- Reply with `NONE` exactly if no additional repo-relative file paths are needed.',
    '- Otherwise reply with 1-5 lines and nothing else.',
    '- Each line must be exactly one backtick-wrapped repo-relative file path.',
    '- Do NOT write the revised plan yet.',
    '- No bullets. No notes. No prose.',
  ].join('\n');
}

function buildCodexRevisionWritePrompt(
  planContent: string,
  auditNotes: string,
  description: string,
  projectContext: string | undefined,
  groundedInputs: string,
): string {
  const planForPrompt = stripAuditLogForPrompt(planContent);
  const existingPaths = extractConcretePlanPaths(planContent);
  const sections = [
    PHASE_SAFETY_REMINDER,
    '',
    'You are writing the final revised plan artifact from grounded repo inputs that were already gathered in this thread.',
    '',
    '## Original Description',
    '',
    description,
    '',
  ];

  if (projectContext) {
    sections.push(
      '## Project Context',
      '',
      projectContext,
      '',
    );
  }

  sections.push(
    '## Current Plan',
    '',
    '```markdown',
    planForPrompt,
    '```',
    '',
    '## Latest Audit Feedback',
    '',
    auditNotes,
    '',
    '## Existing Plan File Paths',
    '',
    formatConcretePlanPaths(existingPaths),
    '',
    '## Additional Grounded Repo Inputs',
    '',
    groundedInputs,
    '',
    '## Instructions',
    '',
    '- Do NOT inspect the repo further in this turn.',
    '- Address all blocking audit concerns while preserving accepted plan structure and history.',
    '- Prefer the existing plan file paths above. Add a new concrete repo-relative file path only if it already appears in the grounded repo inputs above.',
    '- Output the complete revised plan markdown starting with `# Plan:` and nothing else.',
  );

  return sections.join('\n');
}

export function buildAuditorPrompt(
  planContent: string,
  roundNumber: number,
  projectContext?: string,
  opts?: { hasTools?: boolean },
): string {
  const planForPrompt = stripAuditLogForPrompt(planContent);
  const priorAuditSummary = roundNumber > 1 ? summarizePriorAuditHistory(planContent) : undefined;
  const sections = [
    PHASE_SAFETY_REMINDER,
    '',
    'You are a rigorous senior engineer auditing a technical plan.',
    'Find real flaws, gaps, and risks, but optimize for closure: raise only issues that materially change whether the plan can ship.',
    '',
    '## Key Audit Criteria',
    '',
    ...AUDIT_CRITERIA_LINES,
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
    planForPrompt,
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
      'The current plan prompt omits the raw audit log to reduce repetition. Prior rounds are summarized here only so you can avoid re-litigating resolved concerns.',
      '',
    );
    if (priorAuditSummary) {
      instructions.push(
        'Summary of prior reviews:',
        '',
        priorAuditSummary,
        '',
      );
    }
    instructions.push(
      '',
      '- **DO NOT re-raise concerns that were adequately resolved.** If a prior resolution is sound, move on.',
      '- **If a prior resolution is inadequate**, reference the specific prior review and point to the exact contradiction in the current plan text or a verified code fact.',
      '- **Focus on genuinely new issues** — things not yet examined, edge cases the prior rounds missed, or problems introduced by the revisions themselves.',
      '- **Do not split one root cause into multiple blocking concerns.** Merge duplicates and report the root issue once.',
      '',
    );
  }

  const hasTools = opts?.hasTools ?? true;

  instructions.push(
    'Review the plan for:',
    ...AUDIT_CRITERIA_LINES,
    '',
    '- Prefer the smallest correct unblocker. If narrowing the contract, docs, or tests resolves the issue, recommend that instead of expanding implementation scope.',
    '- A blocking concern must cite the contradictory plan text or a verified code fact.',
    '- If the plan claims a restricted subset of a broader capability, verify the exact gating primitive that enforces it (for example: category flags, explicit allowlist, permission check, dedicated parser path). If the plan only describes the restriction in prose, that is a blocking concern.',
    `- If the plan claims to close a recurring workflow/process/quality gap or promote lessons from audits, forge runs, postmortems, incidents, task threads, or implementation chat into durable guidance, verify that it uses \`${COMPOUND_LESSONS_PATH}\` as the checked-in artifact, specifies the intended format, ownership, update rules, and review expectations, and makes the review gate operational: an explicit promotion decision (update existing lesson, add materially distinct new lesson, or no promotion needed) plus a dedup check before merge.`,
    '- Report at most 3 blocking concerns in a single round; merge related issues.',
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
    '',
    '## Reminder: Audit Criteria',
    '',
    ...AUDIT_CRITERIA_LINES,
    '',
    'Every concern you raise must map to one of these criteria.',
  );

  return instructions.join('\n');
}

export function buildRevisionPrompt(
  planContent: string,
  auditNotes: string,
  description: string,
  projectContext?: string,
): string {
  const planForPrompt = stripAuditLogForPrompt(planContent);
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
    planForPrompt,
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
    '- In `## Changes`, every file entry must use a concrete backtick-wrapped repo-relative path (for example, `src/discord/forge-commands.ts`). Replace placeholder paths like `path/to/file.ts`.',
    '- If you keep or add a restriction claim ("read-only", "post-only", "only these actions"), rewrite it to name the exact enforcement mechanism. If no such mechanism exists, narrow the claim or add the necessary implementation work.',
    `- If the task is about codifying reusable engineering lessons, route that work through \`${COMPOUND_LESSONS_PATH}\` as the single checked-in durable artifact. The revised plan should describe the format, ownership, update rules, and mandatory review gate there, including search/dedup expectations and the explicit promotion decision (update an existing lesson, add a materially distinct new one, or record that no promotion is needed), instead of treating \`## Audit Log\` or \`## Implementation Notes\` as the durable lesson sink.`,
    '- Preserve resolutions from prior audit rounds that were accepted — do not weaken, revert, or remove them unless the current audit explicitly challenges them.',
    '- Prefer the smallest change that resolves the blocker. Narrow the contract, docs, or tests before adding new runtime machinery.',
    '- When an audit exposes a guarantee the runtime cannot actually provide, rewrite the plan to match the real guarantee unless the task explicitly requires the stronger one.',
    '- **Push back on re-raised concerns.** If a concern is a refinement or restatement of something already resolved in a prior round, you may note it as "previously addressed" in the resolution and decline to make further changes. The auditor should raise genuinely new issues, not re-litigate resolved ones from a slightly different angle.',
    '- **Reject perfectionism beyond the plan\'s goal.** If a concern demands a standard higher than what the plan set out to achieve (e.g., provably decodable payloads when the goal is "reject obviously broken ones"), acknowledge the concern but explain why the current approach is sufficient. Not every valid observation requires a code change.',
    '- Treat the current plan body as the source of truth. Do not copy old audit-log prose back into the revised plan.',
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
// Runtime adapter wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps a RuntimeAdapter to inject `reasoningEffort` into every `invoke` call.
 * Existing `reasoningEffort` in params is preserved (caller wins).
 */
function wrapWithReasoningEffort(
  rt: RuntimeAdapter,
  effort: string,
): RuntimeAdapter {
  return {
    id: rt.id,
    capabilities: rt.capabilities,
    invoke(params) {
      return rt.invoke({ ...params, reasoningEffort: params.reasoningEffort ?? effort });
    },
  };
}

/**
 * Wraps a RuntimeAdapter so every emitted EngineEvent is forwarded to
 * `onEvent` before being yielded to the pipeline engine. Errors thrown by
 * `onEvent` are swallowed to prevent UI callbacks from aborting execution.
 */
function wrapWithEventForwarding(
  rt: RuntimeAdapter,
  onEvent: (evt: EngineEvent) => void,
): RuntimeAdapter {
  return {
    id: rt.id,
    capabilities: rt.capabilities,
    invoke(params) {
      const seen = new WeakSet<object>();
      const forward = (evt: EngineEvent) => {
        const ref = evt as object;
        if (seen.has(ref)) return;
        seen.add(ref);
        try { onEvent(evt); } catch { /* UI callback errors must not abort execution */ }
      };

      return (async function* (): AsyncGenerator<EngineEvent> {
        for await (const evt of rt.invoke({
          ...params,
          rawEventTap(evt) {
            params.rawEventTap?.(evt);
            forward(evt);
          },
        })) {
          forward(evt);
          yield evt;
        }
      })();
    },
  };
}

function normalizePlanOutputPrefix(text: string): string {
  return text.replace(/^\s+/, '');
}

function sanitizePlanOutputPreview(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAN_OUTPUT_DIAGNOSTIC_PREVIEW_CHARS);
}

function findGroundingOutputStart(text: string, allowNone: boolean): { start: number; kind: 'path' | 'none' } | null {
  const firstNonWhitespace = text.search(/\S/);
  if (firstNonWhitespace === -1) return null;
  const trimmed = text.slice(firstNonWhitespace);
  if (trimmed.startsWith('`')) {
    return { start: firstNonWhitespace, kind: 'path' };
  }
  if (allowNone && /^NONE(?:\s|$)/.test(trimmed)) {
    return { start: firstNonWhitespace, kind: 'none' };
  }
  return null;
}

function hasPotentialGroundingPrefix(text: string, allowNone: boolean): boolean {
  const firstNonWhitespace = text.search(/\S/);
  if (firstNonWhitespace === -1) return true;
  const trimmed = text.slice(firstNonWhitespace);
  if ('`'.startsWith(trimmed)) return true;
  if (allowNone && 'NONE'.startsWith(trimmed)) return true;
  return false;
}

function isValidGroundingOutput(text: string, allowNone: boolean): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (allowNone && trimmed === 'NONE') return true;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 5) return false;
  return lines.every((line) => /^`(?!\/)[^`\n]+`$/.test(line));
}

function buildGroundingOutputSteerMessage(allowNone: boolean): string {
  const lines = [
    'Restart your answer now.',
    'Do not narrate, explain, or add notes.',
    'Output only repo-relative file paths, one backtick-wrapped path per line.',
  ];
  if (allowNone) {
    lines.push('Reply with `NONE` exactly if no additional file paths are needed.');
  }
  return lines.join(' ');
}

function isGlobalSupervisorCycleStartEvent(evt: EngineEvent): boolean {
  if (evt.type !== 'log_line') return false;
  try {
    const payload = JSON.parse(evt.line) as Record<string, unknown>;
    return payload.source === 'global_supervisor'
      && payload.phase === 'execute'
      && payload.reason === 'start';
  } catch {
    return false;
  }
}

function assertPlanMarkdownOutput(output: string, phase: 'draft' | 'revision'): void {
  if (!normalizePlanOutputPrefix(output).startsWith(PLAN_MARKDOWN_PREFIX)) {
    throw new Error(`${phase} output must start with # Plan:`);
  }
}

function withRetrySessionKey(sessionKey: string | null | undefined, suffix: string): string | undefined {
  if (!sessionKey) return undefined;
  return `${sessionKey}:${suffix}`;
}

function addPlanRetryHints(
  def: Parameters<typeof runPipeline>[0],
  opts: {
    includeTemplateEchoWarning?: boolean;
    retrySessionSuffix: string;
    dropToolsOnRetry?: boolean;
    replacementPrompt?: string;
  },
): Parameters<typeof runPipeline>[0] {
  const promptPrefix = `${opts.includeTemplateEchoWarning ? TEMPLATE_ECHO_RETRY_PREFIX : ''}${opts.dropToolsOnRetry ? PLAN_OUTPUT_NO_TOOLS_RETRY_PREFIX : ''}${PLAN_OUTPUT_RETRY_PREFIX}`;

  return {
    ...def,
    steps: def.steps.map((step) =>
      step.kind === 'prompt'
        ? (() => {
          const retrySystemPrompt = opts.dropToolsOnRetry
            ? [
              step.systemPrompt,
              'Do not use tools on this retry. Produce the final plan from the context already provided.',
            ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n')
            : step.systemPrompt;
          const basePrompt = opts.replacementPrompt ?? step.prompt;
          const prompt =
            opts.dropToolsOnRetry && typeof basePrompt === 'string'
              ? basePrompt.replace(DRAFTER_CODEBASE_TOOLS_INSTRUCTION, DRAFTER_NO_TOOLS_RETRY_INSTRUCTION)
              : basePrompt;

          return {
            ...step,
            ...(retrySystemPrompt !== undefined && { systemPrompt: retrySystemPrompt }),
            ...(opts.dropToolsOnRetry ? { tools: undefined, addDirs: undefined, disableNativeAppServer: true } : {}),
            prompt: typeof prompt === 'string' ? promptPrefix + prompt : prompt,
            sessionKey: withRetrySessionKey(step.sessionKey, opts.retrySessionSuffix),
          };
        })()
        : step,
    ),
  };
}

function isGroundingOutputError(message: string): boolean {
  return message.toLowerCase().includes('grounding output must be repo-relative file paths');
}

function shouldDropToolsOnPlanRetry(message: string): boolean {
  return message.toLowerCase().includes('native turn produced no text output');
}

function shouldDropToolsOnCodexPlanRetry(
  runtime: RuntimeAdapter,
  message: string,
): boolean {
  const lower = message.toLowerCase();
  return shouldDropToolsOnPlanRetry(message)
    || isGroundingOutputError(message)
    || (runtime.id === 'codex' && lower.includes('output must start with # plan:'));
}

function wrapWithPlanPrefixGuard(
  rt: RuntimeAdapter,
  phase: 'draft' | 'revision',
): RuntimeAdapter {
  const errorMessage = `${phase} output must start with # Plan:`;

  return {
    id: rt.id,
    capabilities: rt.capabilities,
    invoke(params) {
      let prefixSatisfied = false;
      let leadingText = '';
      let steerAttempted = false;
      let silentSteerAttempted = false;
      let silentSteerTimer: ReturnType<typeof setTimeout> | undefined;
      const transformedEvents = new WeakMap<object, EngineEvent | null>();

      const clearSilentSteerTimer = () => {
        if (!silentSteerTimer) return;
        clearTimeout(silentSteerTimer);
        silentSteerTimer = undefined;
      };

      const maybeArmSilentSteerTimer = () => {
        if (
          prefixSatisfied
          || silentSteerAttempted
          || silentSteerTimer
          || !params.sessionKey
          || typeof rt.steer !== 'function'
        ) {
          return;
        }

        silentSteerTimer = setTimeout(() => {
          silentSteerTimer = undefined;
          if (prefixSatisfied || silentSteerAttempted) return;
          silentSteerAttempted = true;
          void rt.steer?.(params.sessionKey!, PLAN_OUTPUT_STEER_MESSAGE).catch(() => false);
        }, PLAN_OUTPUT_SILENT_STEER_DELAY_MS);
      };

      const transformEvent = (evt: EngineEvent): EngineEvent | null => {
        if (isGlobalSupervisorCycleStartEvent(evt)) {
          prefixSatisfied = false;
          leadingText = '';
          steerAttempted = false;
          silentSteerAttempted = false;
          clearSilentSteerTimer();
          return evt;
        }
        if (prefixSatisfied) return evt;
        if (evt.type !== 'text_delta' && evt.type !== 'text_final') {
          if (
            evt.type === 'tool_start'
            || evt.type === 'tool_end'
            || evt.type === 'preview_debug'
            || evt.type === 'log_line'
          ) {
            maybeArmSilentSteerTimer();
          }
          return evt;
        }

        clearSilentSteerTimer();
        leadingText += evt.text;
        const normalizedLeadingText = normalizePlanOutputPrefix(leadingText);
        const prefixStart = leadingText.indexOf(PLAN_MARKDOWN_PREFIX);
        if (prefixStart === -1) {
          if (
            !steerAttempted
            && normalizedLeadingText.length > 0
            && !PLAN_MARKDOWN_PREFIX.startsWith(normalizedLeadingText)
          ) {
            steerAttempted = true;
            if (params.sessionKey && typeof rt.steer === 'function') {
              void rt.steer(params.sessionKey, PLAN_OUTPUT_STEER_MESSAGE).catch(() => false);
            }
          }
          if (
            normalizedLeadingText.length >= PLAN_OUTPUT_MAX_LEADING_CHARS
            && !PLAN_MARKDOWN_PREFIX.startsWith(normalizedLeadingText)
          ) {
            const preview = sanitizePlanOutputPreview(leadingText);
            params.rawEventTap?.({
              type: 'log_line',
              stream: 'stderr',
              line: JSON.stringify({
                source: 'forge_plan_prefix_guard',
                phase,
                reason: 'invalid_leading_text',
                leadingChars: leadingText.length,
                previewChars: preview.length,
                preview,
              }),
            });
            if (params.sessionKey && typeof rt.interrupt === 'function') {
              void rt.interrupt(params.sessionKey).catch(() => false);
            }
            throw new Error(errorMessage);
          }
          return null;
        }

        const trimmedText = leadingText.slice(prefixStart);
        if (trimmedText.length === 0) {
          return null;
        }

        prefixSatisfied = true;
        leadingText = '';
        return {
          ...evt,
          text: trimmedText,
        };
      };

      const transformOnce = (evt: EngineEvent): EngineEvent | null => {
        const ref = evt as object;
        if (transformedEvents.has(ref)) {
          return transformedEvents.get(ref) ?? null;
        }
        const transformed = transformEvent(evt);
        transformedEvents.set(ref, transformed);
        return transformed;
      };

      return (async function* (): AsyncGenerator<EngineEvent> {
        try {
          for await (const evt of rt.invoke({
            ...params,
            rawEventTap(evt) {
              const transformed = transformOnce(evt);
              if (transformed) {
                params.rawEventTap?.(transformed);
              }
            },
          })) {
            const transformed = transformOnce(evt);
            if (!transformed) {
              continue;
            }
            yield transformed;
          }
        } finally {
          clearSilentSteerTimer();
        }
      })();
    },
  };
}

function wrapWithGroundingOutputGuard(
  rt: RuntimeAdapter,
  phase: 'draft' | 'revision',
  opts?: { allowNone?: boolean },
): RuntimeAdapter {
  const allowNone = opts?.allowNone ?? false;
  const errorMessage = allowNone
    ? `${phase} grounding output must be repo-relative file paths or NONE`
    : `${phase} grounding output must be repo-relative file paths only`;
  const steerMessage = buildGroundingOutputSteerMessage(allowNone);

  return {
    id: rt.id,
    capabilities: rt.capabilities,
    invoke(params) {
      let prefixSatisfied = false;
      let leadingText = '';
      let steerAttempted = false;
      let groundingText = '';
      const transformedEvents = new WeakMap<object, EngineEvent | null>();

      const failInvalidGroundingOutput = () => {
        const preview = sanitizePlanOutputPreview(groundingText || leadingText);
        params.rawEventTap?.({
          type: 'log_line',
          stream: 'stderr',
          line: JSON.stringify({
            source: 'forge_grounding_guard',
            phase,
            reason: 'invalid_grounding_output',
            leadingChars: (groundingText || leadingText).length,
            previewChars: preview.length,
            preview,
          }),
        });
        if (params.sessionKey && typeof rt.interrupt === 'function') {
          void rt.interrupt(params.sessionKey).catch(() => false);
        }
        throw new Error(errorMessage);
      };

      const transformEvent = (evt: EngineEvent): EngineEvent | null => {
        if (isGlobalSupervisorCycleStartEvent(evt)) {
          prefixSatisfied = false;
          leadingText = '';
          groundingText = '';
          steerAttempted = false;
          return evt;
        }
        if (evt.type !== 'text_delta' && evt.type !== 'text_final') {
          return evt;
        }

        if (!prefixSatisfied) {
          const steerRestartStart = steerAttempted
            ? findGroundingOutputStart(evt.text, allowNone)
            : null;
          if (steerRestartStart) {
            leadingText = evt.text.slice(steerRestartStart.start);
          } else {
            leadingText += evt.text;
          }
          const start = findGroundingOutputStart(leadingText, allowNone);
          if (!start) {
            const normalizedLeadingText = leadingText.replace(/^\s+/, '');
            if (
              !steerAttempted
              && normalizedLeadingText.length > 0
              && !hasPotentialGroundingPrefix(leadingText, allowNone)
            ) {
              steerAttempted = true;
              if (params.sessionKey && typeof rt.steer === 'function') {
                void rt.steer(params.sessionKey, steerMessage).catch(() => false);
              }
            }
            if (
              normalizedLeadingText.length >= GROUNDING_OUTPUT_MAX_LEADING_CHARS
              && !hasPotentialGroundingPrefix(leadingText, allowNone)
            ) {
              failInvalidGroundingOutput();
            }
            return null;
          }

          prefixSatisfied = true;
          const trimmedText = leadingText.slice(start.start);
          leadingText = '';
          groundingText += trimmedText;
          return { ...evt, text: trimmedText };
        }

        groundingText += evt.text;
        return evt;
      };

      const transformOnce = (evt: EngineEvent): EngineEvent | null => {
        const ref = evt as object;
        if (transformedEvents.has(ref)) {
          return transformedEvents.get(ref) ?? null;
        }
        const transformed = transformEvent(evt);
        transformedEvents.set(ref, transformed);
        return transformed;
      };

      return (async function* (): AsyncGenerator<EngineEvent> {
        for await (const evt of rt.invoke({
          ...params,
          rawEventTap(evt) {
            const transformed = transformOnce(evt);
            if (transformed) {
              params.rawEventTap?.(transformed);
            }
          },
        })) {
          const transformed = transformOnce(evt);
          if (!transformed) continue;
          yield transformed;
        }
        if (groundingText.length > 0 && !isValidGroundingOutput(groundingText, allowNone)) {
          failInvalidGroundingOutput();
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
 *  - 'codex app-server websocket closed' — transient native transport disconnect; retry starts a fresh turn
 */
export function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('hang detected') ||
    lower.includes('stream stall') ||
    lower.includes('progress stall') ||
    lower.includes('timed out') ||
    lower.includes('process exited unexpectedly') ||
    lower.includes('stdin write failed') ||
    lower.includes('codex app-server websocket closed') ||
    lower.includes('codex app-server websocket is closed') ||
    lower.includes('drafter echoed the template') ||
    isGroundingOutputError(lower) ||
    lower.includes('output must start with # plan:')
  );
}

// ---------------------------------------------------------------------------
// ForgeOrchestrator
// ---------------------------------------------------------------------------

export class ForgeOrchestrator {
  private running = false;
  private cancelRequested = false;
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

  requestCancel(reason?: string): void {
    this.opts.log?.info({ planId: this.currentPlanId, reason: reason ?? 'unknown' }, 'forge:cancel-requested');
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

    // Resolve degenerate descriptions ("this", "it", etc.) to the task title
    description = resolveForgeDescription(
      description,
      this.opts.taskStore,
      this.opts.existingTaskId,
    );

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
        withForgeIcon(
          FORGE_PROGRESS_ICON.failed,
          `Forge failed${planId ? ` during ${planId}` : ''}: ${errorMsg}${filePath ? `. Partial plan saved: \`!plan show ${planId}\`` : ''}`,
        ),
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
        withForgeIcon(FORGE_PROGRESS_ICON.failed, `Forge resume failed for ${planId}: ${errorMsg}`),
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

    const rawDrafterModel = this.opts.drafterModel ?? this.opts.model;
    const rawAuditorModel = this.opts.auditorModel ?? this.opts.model;
    const drafterRt = this.opts.drafterRuntime ?? this.opts.runtime;
    const isClaudeDrafter = drafterRt.id === 'claude_code';
    const hasExplicitDrafterModel = Boolean(this.opts.drafterModel);
    const drafterModel = isClaudeDrafter
      ? resolveModel(rawDrafterModel, drafterRt.id)
      : (hasExplicitDrafterModel ? resolveModel(rawDrafterModel, drafterRt.id) : '');
    const drafterReasoningEffort = resolveReasoningEffort(rawDrafterModel, drafterRt.id);
    const readOnlyTools = ['Read', 'Glob', 'Grep'];
    const addDirs = [this.opts.cwd];

    // Stable session keys — one per role — enable multi-turn reuse across
    // the audit-revise loop.  Keys use raw (pre-resolution) tier names so
    // they remain stable if the tier→model mapping changes.
    const drafterSessionKey = `forge:${planId}:${rawDrafterModel}:drafter`;
    const auditorSessionKey = `forge:${planId}:${rawAuditorModel}:auditor`;

    // Wrap drafter with reasoning effort if resolved (before event-forwarding so both compose).
    const reasoningDrafterRt = drafterReasoningEffort
      ? wrapWithReasoningEffort(drafterRt, drafterReasoningEffort)
      : drafterRt;
    const guardedDraftRt = wrapWithPlanPrefixGuard(reasoningDrafterRt, 'draft');
    const guardedRevisionRt = wrapWithPlanPrefixGuard(reasoningDrafterRt, 'revision');
    const guardedDraftResearchRt = wrapWithGroundingOutputGuard(reasoningDrafterRt, 'draft');
    const guardedRevisionResearchRt = wrapWithGroundingOutputGuard(reasoningDrafterRt, 'revision', { allowNone: true });
    const effectiveDraftResearchRt = onEvent ? wrapWithEventForwarding(guardedDraftResearchRt, onEvent) : guardedDraftResearchRt;
    const effectiveRevisionResearchRt = onEvent ? wrapWithEventForwarding(guardedRevisionResearchRt, onEvent) : guardedRevisionResearchRt;
    const effectiveDrafterRt = onEvent ? wrapWithEventForwarding(guardedDraftRt, onEvent) : guardedDraftRt;
    const effectiveRevisionRt = onEvent ? wrapWithEventForwarding(guardedRevisionRt, onEvent) : guardedRevisionRt;
    const useTwoStageCodexDraftFlow = shouldUseTwoStageCodexPlanFlow(drafterRt);

    let round = startRound - 1; // will be incremented at top of loop
    let planContent = await fs.readFile(filePath, 'utf-8');
    let lastAuditNotes = '';
    let lastVerdict: AuditVerdict = { maxSeverity: 'none', shouldLoop: false };
    const heartbeatPolicy = resolvePlanHeaderHeartbeatPolicy(
      planContent,
      this.opts.planForgeHeartbeatIntervalMs,
    );

    // The effective max round number is startRound + maxAuditRounds - 1
    const maxRound = startRound + this.opts.maxAuditRounds - 1;
    const forgeHeartbeat = createPhaseStatusHeartbeatController({
      flowLabel: `Forge ${planId}`,
      policy: heartbeatPolicy,
      onUpdate: async (message, event) => {
        if (event.type === 'terminal') return;
        await onProgress(message, { force: true });
      },
      onError: (err, event) => {
        this.opts.log?.warn({ err, planId, eventType: event.type }, 'forge:heartbeat update failed');
      },
    });
    let heartbeatPhaseStarted = false;
    let heartbeatCompleted = false;
    const setHeartbeatPhase = async (phaseLabel: string) => {
      if (!heartbeatPhaseStarted) {
        heartbeatPhaseStarted = true;
        await forgeHeartbeat.startPhase(phaseLabel);
        return;
      }
      await forgeHeartbeat.transitionPhase(phaseLabel);
    };
    const completeHeartbeat = async (
      outcome: 'succeeded' | 'failed' | 'cancelled',
      detail?: string,
    ) => {
      if (heartbeatCompleted) return;
      heartbeatCompleted = true;
      await forgeHeartbeat.complete(outcome, detail);
    };

    try {
      while (round < maxRound) {
        if (this.cancelRequested) {
          this.opts.log?.info({ planId, round, phase: 'loop-entry' }, 'forge:cancelled');
          await this.updatePlanStatus(filePath, 'CANCELLED');
          await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.cancelled, `Forge ${planId} cancelled.`), { force: true });
          await completeHeartbeat('cancelled', `Cancelled before round ${round + 1}/${maxRound}.`);
          return {
            planId,
            filePath,
            finalVerdict: 'CANCELLED',
            rounds: round - startRound + 1,
            reachedMaxRounds: false,
          };
        }

        round++;
        const forgePhaseLiveness = resolveForgePhaseLiveness(this.opts.timeoutMs);

        // Draft phase (only on first round of a fresh forge, not resume)
        if (round === 1 && startRound === 1 && templateContent && contextSummary) {
          await setHeartbeatPhase(`Draft round ${round}/${maxRound}`);
          await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.draft, `Forging ${planId}... Drafting (reading codebase)`));

          const drafterPrompt = buildDrafterPrompt(
            description,
            templateContent,
            contextSummary,
          );
          const compactDrafterRetryPrompt = buildCompactDrafterRetryPrompt(
            description,
            templateContent,
          );
          const draftPrimaryDef = useTwoStageCodexDraftFlow
            ? {
              steps: [
                {
                  id: 'draft-grounding',
                  kind: 'prompt' as const,
                  prompt: buildCodexDraftGroundingPrompt(description),
                  runtime: effectiveDraftResearchRt,
                  model: drafterModel,
                  tools: readOnlyTools,
                  addDirs,
                  timeoutMs: this.opts.timeoutMs,
                  streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
                  progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
                  sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
                  supervisor: FORGE_GROUNDING_PHASE_SUPERVISOR_POLICY,
                },
                {
                  id: 'draft-write',
                  kind: 'prompt' as const,
                  prompt: buildCodexDraftWritePrompt(
                    description,
                    templateContent,
                    contextSummary,
                    '{{steps.draft-grounding.output}}',
                  ),
                  runtime: effectiveDrafterRt,
                  systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
                  model: drafterModel,
                  tools: [],
                  timeoutMs: this.opts.timeoutMs,
                  streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
                  progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
                  sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
                  supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
                },
              ],
              runtime: this.opts.runtime,
              cwd: this.opts.cwd,
              model: this.opts.model,
              signal: this.abortController.signal,
            }
            : {
              steps: [{
                kind: 'prompt' as const,
                prompt: drafterPrompt,
                runtime: effectiveDrafterRt,
                systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
                model: drafterModel,
                tools: readOnlyTools,
                addDirs,
                timeoutMs: this.opts.timeoutMs,
                streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
                progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
                sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
                supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
              }],
              runtime: this.opts.runtime,
              cwd: this.opts.cwd,
              model: this.opts.model,
              signal: this.abortController.signal,
            };
          const draftRetryBaseDef = {
            steps: [{
              kind: 'prompt' as const,
              prompt: drafterPrompt,
              runtime: effectiveDrafterRt,
              systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
              model: drafterModel,
              tools: readOnlyTools,
              addDirs,
              timeoutMs: this.opts.timeoutMs,
              streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
              progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
              sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
              supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
            }],
            runtime: this.opts.runtime,
            cwd: this.opts.cwd,
            model: this.opts.model,
            signal: this.abortController.signal,
          };

          const draftPipelineResult = await this.runWithRetry(draftPrimaryDef, 'Draft', onProgress, (result) => {
            const output = result.outputs[result.outputs.length - 1] ?? '';
            assertPlanMarkdownOutput(output, 'draft');
            if (isTemplateEchoed(output)) {
              this.opts.log?.warn({ planId, round, phase: 'draft' }, 'forge:template-echo');
              throw new Error('drafter echoed the template');
            }
          }, (retryDef, retryCtx) => {
            const dropToolsOnRetry = shouldDropToolsOnCodexPlanRetry(drafterRt, retryCtx.firstError);
            return addPlanRetryHints(useTwoStageCodexDraftFlow ? draftRetryBaseDef : retryDef, {
              includeTemplateEchoWarning: true,
              retrySessionSuffix: 'draft-retry',
              dropToolsOnRetry,
              replacementPrompt: dropToolsOnRetry ? compactDrafterRetryPrompt : undefined,
            });
          });
          if (!draftPipelineResult) {
            this.opts.log?.info({ planId, round, phase: 'draft' }, 'forge:cancelled');
            await this.updatePlanStatus(filePath, 'CANCELLED');
            await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.cancelled, `Forge ${planId} cancelled.`), { force: true });
            await completeHeartbeat('cancelled', `Cancelled during draft in round ${round}/${maxRound}.`);
            return {
              planId,
              filePath,
              finalVerdict: 'CANCELLED',
              rounds: round - startRound + 1,
              reachedMaxRounds: false,
            };
          }
          const draftOutput = draftPipelineResult.outputs[draftPipelineResult.outputs.length - 1] ?? '';

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
            withForgeIcon(FORGE_PROGRESS_ICON.audit, `Forging ${planId}... Revision complete. Audit round ${round}/${maxRound}...`),
          );
        }

        // Audit phase
        await setHeartbeatPhase(`Audit round ${round}/${maxRound}`);
        await onProgress(
          withForgeIcon(
            FORGE_PROGRESS_ICON.audit,
            round === startRound && startRound === 1
              ? `Forging ${planId}... Draft complete. Audit round ${round}/${maxRound}...`
              : `Forging ${planId}... Audit round ${round}/${maxRound}...`,
          ),
        );

        const auditorRt = this.opts.auditorRuntime ?? this.opts.runtime;
        const isClaudeAuditor = auditorRt.id === 'claude_code';
        const auditorHasFileTools = auditorRt.capabilities.has('tools_fs');
        const hasExplicitAuditorModel = Boolean(this.opts.auditorModel);
        const effectiveAuditorModel = isClaudeAuditor
          ? resolveModel(rawAuditorModel, auditorRt.id)
          : (hasExplicitAuditorModel ? resolveModel(rawAuditorModel, auditorRt.id) : '');
        const auditorReasoningEffort = resolveReasoningEffort(rawAuditorModel, auditorRt.id);
        const reasoningAuditorRt = auditorReasoningEffort
          ? wrapWithReasoningEffort(auditorRt, auditorReasoningEffort)
          : auditorRt;

        const auditorPrompt = buildAuditorPrompt(
          planContent,
          round,
          projectContext,
          { hasTools: auditorHasFileTools },
        );
        const effectiveAuditorRt = onEvent ? wrapWithEventForwarding(reasoningAuditorRt, onEvent) : reasoningAuditorRt;
        const auditPipelineResult = await this.runWithRetry({
          steps: [{
            kind: 'prompt',
            prompt: auditorPrompt,
            runtime: effectiveAuditorRt,
            model: effectiveAuditorModel,
            tools: auditorHasFileTools ? readOnlyTools : [],
            ...(auditorHasFileTools ? { addDirs } : {}),
            timeoutMs: this.opts.timeoutMs,
            streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
            progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
            sessionKey: auditorRt.capabilities.has('sessions') ? auditorSessionKey : undefined,
            supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
          }],
          runtime: this.opts.runtime,
          cwd: this.opts.cwd,
          model: this.opts.model,
          signal: this.abortController.signal,
        }, `Audit round ${round}`, onProgress);
        if (!auditPipelineResult) {
          this.opts.log?.info({ planId, round, phase: 'audit' }, 'forge:cancelled');
          await this.updatePlanStatus(filePath, 'CANCELLED');
          await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.cancelled, `Forge ${planId} cancelled.`), { force: true });
          await completeHeartbeat('cancelled', `Cancelled during audit round ${round}/${maxRound}.`);
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
          // Post-loop structural check: verify a revision hasn't stripped required sections.
          // Truncate to content before ## Audit Log so audit notes don't confuse parsePlan.
          let structuralWarning: string | undefined;
          const auditLogIdx = planContent.indexOf('\n## Audit Log');
          const bodyForCheck = auditLogIdx !== -1 ? planContent.slice(0, auditLogIdx) : planContent;
          const postConcerns = auditPlanStructure(bodyForCheck);
          const postVerdict = deriveVerdict(postConcerns);
          if (postVerdict.shouldLoop) {
            const missing = postConcerns
              .filter((c) => c.severity === 'high' || c.severity === 'medium')
              .map((c) => c.title)
              .join(', ');
            structuralWarning = missing;
            planContent = appendAuditRound(
              planContent,
              round + 1,
              `**Structural warning (automated):** ${missing}`,
              { maxSeverity: 'medium', shouldLoop: false },
            );
            await this.atomicWrite(filePath, planContent);
          }

          await this.updatePlanStatus(filePath, 'REVIEW');
          // Re-read to get updated status in the summary
          planContent = await fs.readFile(filePath, 'utf-8');
          const summary = buildPlanSummary(planContent);
          const elapsed = Math.round((Date.now() - t0) / 1000);
          const roundLabel = `${round - startRound + 1} round${round - startRound + 1 > 1 ? 's' : ''}`;
          const warningSuffix = structuralWarning
            ? ` ${FORGE_PROGRESS_ICON.warning} Structural warning: ${structuralWarning}`
            : '';
          await onProgress(
            withForgeIcon(
              FORGE_PROGRESS_ICON.success,
              `Forge complete. Plan ${planId} ready for review (${roundLabel}, ${elapsed}s)${warningSuffix}`,
            ),
            { force: true },
          );
          await completeHeartbeat(
            'succeeded',
            `Completed ${round - startRound + 1} round${round - startRound + 1 > 1 ? 's' : ''}.`,
          );
          return {
            planId,
            filePath,
            finalVerdict: lastVerdict.maxSeverity,
            rounds: round - startRound + 1,
            reachedMaxRounds: false,
            planSummary: summary,
            structuralWarning,
          };
        }

        // Check if we've hit the cap
        if (round >= maxRound) {
          break;
        }

        // Revision phase
        await setHeartbeatPhase(`Revision after round ${round}/${maxRound}`);
        await onProgress(
          withForgeIcon(
            FORGE_PROGRESS_ICON.revise,
            `Forging ${planId}... Audit round ${round} found ${lastVerdict.maxSeverity} concerns. Revising...`,
          ),
        );

        const revisionPrompt = buildRevisionPrompt(
          planContent,
          auditOutput,
          description,
          projectContext,
        );
        const compactRevisionRetryPrompt = buildCompactRevisionRetryPrompt(
          planContent,
          auditOutput,
          description,
        );
        const revisionPrimaryDef = useTwoStageCodexDraftFlow
          ? {
            steps: [
              {
                id: `revision-round-${round}-grounding`,
                kind: 'prompt' as const,
                prompt: buildCodexRevisionGroundingPrompt(planContent, auditOutput),
                runtime: effectiveRevisionResearchRt,
                model: drafterModel,
                tools: readOnlyTools,
                addDirs,
                timeoutMs: this.opts.timeoutMs,
                streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
                progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
                sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
                supervisor: FORGE_GROUNDING_PHASE_SUPERVISOR_POLICY,
              },
              {
                id: `revision-round-${round}-write`,
                kind: 'prompt' as const,
                prompt: buildCodexRevisionWritePrompt(
                  planContent,
                  auditOutput,
                  description,
                  projectContext,
                  `{{steps.revision-round-${round}-grounding.output}}`,
                ),
                runtime: effectiveRevisionRt,
                systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
                model: drafterModel,
                tools: [],
                timeoutMs: this.opts.timeoutMs,
                streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
                progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
                sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
                supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
              },
            ],
            runtime: this.opts.runtime,
            cwd: this.opts.cwd,
            model: this.opts.model,
            signal: this.abortController.signal,
          }
          : {
            steps: [{
              kind: 'prompt' as const,
              prompt: revisionPrompt,
              runtime: effectiveRevisionRt,
              systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
              model: drafterModel,
              tools: readOnlyTools,
              addDirs,
              timeoutMs: this.opts.timeoutMs,
              streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
              progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
              sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
              supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
            }],
            runtime: this.opts.runtime,
            cwd: this.opts.cwd,
            model: this.opts.model,
            signal: this.abortController.signal,
          };
        const revisionRetryBaseDef = {
          steps: [{
            kind: 'prompt' as const,
            prompt: revisionPrompt,
            runtime: effectiveRevisionRt,
            systemPrompt: resolveForgePlanSystemPrompt(drafterRt),
            model: drafterModel,
            tools: readOnlyTools,
            addDirs,
            timeoutMs: this.opts.timeoutMs,
            streamStallTimeoutMs: forgePhaseLiveness.streamStallTimeoutMs,
            progressStallTimeoutMs: forgePhaseLiveness.progressStallTimeoutMs,
            sessionKey: drafterRt.capabilities.has('sessions') ? drafterSessionKey : undefined,
            supervisor: FORGE_PLAN_PHASE_SUPERVISOR_POLICY,
          }],
          runtime: this.opts.runtime,
          cwd: this.opts.cwd,
          model: this.opts.model,
          signal: this.abortController.signal,
        };

        const revisionPipelineResult = await this.runWithRetry(revisionPrimaryDef, `Revision after round ${round}`, onProgress, (result) => {
          assertPlanMarkdownOutput(result.outputs[result.outputs.length - 1] ?? '', 'revision');
        }, (retryDef, retryCtx) => {
          const dropToolsOnRetry = shouldDropToolsOnCodexPlanRetry(drafterRt, retryCtx.firstError);
          return addPlanRetryHints(useTwoStageCodexDraftFlow ? revisionRetryBaseDef : retryDef, {
            retrySessionSuffix: `revision-round-${round}-retry`,
            dropToolsOnRetry,
            replacementPrompt: dropToolsOnRetry ? compactRevisionRetryPrompt : undefined,
          });
        });
        if (!revisionPipelineResult) {
          this.opts.log?.info({ planId, round, phase: 'revision' }, 'forge:cancelled');
          await this.updatePlanStatus(filePath, 'CANCELLED');
          await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.cancelled, `Forge ${planId} cancelled.`), { force: true });
          await completeHeartbeat('cancelled', `Cancelled during revision after round ${round}/${maxRound}.`);
          return {
            planId,
            filePath,
            finalVerdict: 'CANCELLED',
            rounds: round - startRound + 1,
            reachedMaxRounds: false,
          };
        }
        const revisionOutput = revisionPipelineResult.outputs[revisionPipelineResult.outputs.length - 1] ?? '';

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

      await onProgress(
        withForgeIcon(
          FORGE_PROGRESS_ICON.warning,
          `Forge stopped after ${this.opts.maxAuditRounds} audit rounds — concerns remain. Review manually: \`!plan show ${planId}\``,
        ),
        { force: true },
      );
      await completeHeartbeat('failed', `Reached audit round cap at ${round}/${maxRound}.`);

      return {
        planId,
        filePath,
        finalVerdict: lastVerdict.maxSeverity,
        rounds: round - startRound + 1,
        reachedMaxRounds: true,
        planSummary: summary,
      };
    } catch (err) {
      await completeHeartbeat(
        this.cancelRequested ? 'cancelled' : 'failed',
        this.cancelRequested
          ? `Cancelled at round ${Math.max(startRound, round)}/${maxRound}.`
          : `Error: ${String(err instanceof Error ? err.message : err)}`,
      );
      throw err;
    } finally {
      forgeHeartbeat.dispose();
    }
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

    const taskDescription = opts?.taskDescription;
    if (taskDescription) {
      sections.push(`--- task-description (thread) ---\n${taskDescription.trim()}`);
    }

    if (opts?.pinnedThreadSummary) {
      sections.push(`--- pinned-thread summary ---\n${opts.pinnedThreadSummary.trim()}`);
    }

    const compoundLessonsPath = path.join(this.opts.cwd, COMPOUND_LESSONS_PATH);
    try {
      const compoundLessons = await fs.readFile(compoundLessonsPath, 'utf-8');
      const lessonsSection = extractCompoundLessonsForPrompt(compoundLessons);
      if (lessonsSection) {
        sections.push(`--- compound-lessons.md (repo) ---\n${lessonsSection}`);
      }
    } catch {
      // skip missing or unreadable files
    }

    return buildPromptPreamble(sections.join('\n\n'));
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
    const metadataSeparator = '\n---\n\n';
    const prefixEnd = originalContent.indexOf(metadataSeparator);
    if (prefixEnd === -1) return draftOutput;

    const originalPrefix = originalContent.slice(0, prefixEnd + metadataSeparator.length);
    const originalTitle = originalPrefix.match(/^# Plan:[^\n]*\n/)?.[0] ?? '';
    const draftTitle = draftOutput.match(/^# Plan:[^\n]*\n/)?.[0] ?? '';
    const preservedPrefix = draftTitle && originalTitle
      ? originalPrefix.replace(originalTitle, draftTitle)
      : originalPrefix;

    const findTailStart = (text: string): number => {
      for (const marker of [
        '\n---\n\n## Audit Log',
        '\n## Audit Log',
        '\n---\n\n## Implementation Notes',
        '\n## Implementation Notes',
      ]) {
        const idx = text.indexOf(marker);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const preservedTailStart = findTailStart(originalContent);
    const preservedTail = preservedTailStart !== -1 ? originalContent.slice(preservedTailStart) : '';

    let draftBody = draftOutput;
    const generatedHeaderMatch = draftOutput.match(
      /^[\s\S]*?\*\*Project:\*\*[^\n]*\n(?:\n?---\n\n)?/,
    );
    if (generatedHeaderMatch) {
      draftBody = draftOutput.slice(generatedHeaderMatch[0].length);
    } else if (draftTitle) {
      draftBody = draftOutput.slice(draftTitle.length);
      draftBody = draftBody.replace(/^\s*---\s*\n+/, '');
    }

    const generatedTailStart = findTailStart(draftBody);
    if (generatedTailStart !== -1) {
      draftBody = draftBody.slice(0, generatedTailStart);
    }

    const normalizedBody = draftBody.trim();
    if (!normalizedBody) {
      return preservedTail ? preservedPrefix + preservedTail : preservedPrefix.trimEnd();
    }

    return preservedTail
      ? preservedPrefix + normalizedBody + preservedTail
      : preservedPrefix + normalizedBody + '\n';
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
   *
   * An optional `validate` callback runs after each successful pipeline result.
   * If it throws a retryable error, the pipeline is retried like any other
   * transient failure.
   *
   * An optional `retryTransform` callback modifies the pipeline definition
   * before the retry attempt (e.g. augmenting the prompt with error context).
   */
  private async runWithRetry(
    def: Parameters<typeof runPipeline>[0],
    phase: string,
    onProgress: ProgressFn,
    validate?: (result: { outputs: string[] }) => void,
    retryTransform?: (
      def: Parameters<typeof runPipeline>[0],
      ctx: { firstError: string },
    ) => Parameters<typeof runPipeline>[0],
  ): Promise<{ outputs: string[] } | null> {
    try {
      const result = await this.runCancellable(def);
      if (result && validate) validate(result);
      return result;
    } catch (firstErr) {
      if (this.cancelRequested) return null;
      const firstMsg = String(firstErr instanceof Error ? firstErr.message : firstErr);
      if (!isRetryableError(firstMsg)) {
        throw new Error(`${phase} failed: ${firstMsg}`);
      }
      this.opts.log?.warn({ err: firstErr, phase }, 'forge:retry');
      await onProgress(withForgeIcon(FORGE_PROGRESS_ICON.retry, `Forge ${phase} stalled — retrying...`), { force: true });
      const retryDef = retryTransform ? retryTransform(def, { firstError: firstMsg }) : def;
      try {
        const result = await this.runCancellable(retryDef);
        if (result && validate) validate(result);
        return result;
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
