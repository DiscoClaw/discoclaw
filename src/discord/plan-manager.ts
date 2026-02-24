import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { collectRuntimeText } from './runtime-utils.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';
import { PHASE_SAFETY_REMINDER } from '../runtime/strategies/claude-strategy.js';
import { matchesDestructivePattern } from '../runtime/tool-call-gate.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { parseAuditVerdict } from './forge-audit-verdict.js';
import type { AuditVerdict } from './forge-audit-verdict.js';
import { extractFirstJsonValue } from './json-extract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhaseKind = 'implement' | 'read' | 'audit';
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';

export type PlanPhase = {
  id: string;
  title: string;
  kind: PhaseKind;
  description: string;
  status: PhaseStatus;
  dependsOn: string[];
  contextFiles: string[];
  changeSpec?: string;
  output?: string;
  error?: string;
  gitCommit?: string;
  modifiedFiles?: string[];
  failureHashes?: Record<string, string>;
};

export type PlanPhases = {
  planId: string;
  planFile: string;
  planContentHash: string;
  phases: PlanPhase[];
  createdAt: string;
  updatedAt: string;
};

export type PlanPhasesStateV1 = PlanPhases & {
  version: 1;
};

export type PlanRunEvent =
  | {
      type: 'phase_start';
      planId: string;
      phase: {
        id: string;
        title: string;
        kind: PhaseKind;
      };
    }
  | {
      type: 'phase_complete';
      planId: string;
      phase: {
        id: string;
        title: string;
        kind: PhaseKind;
      };
      status: 'done' | 'failed' | 'skipped';
    };

export type PhaseExecutionOpts = {
  runtime: RuntimeAdapter;
  model: string;
  projectCwd: string;
  addDirs: string[];
  timeoutMs: number;
  workspaceCwd: string;
  log?: LoggerLike;
  /** Max audit→fix→re-audit loops before giving up. Default: 2. */
  maxAuditFixAttempts?: number;
  /** Optional streaming event callback for live Discord progress previews. */
  onEvent?: (evt: EngineEvent) => void;
  /** Optional typed plan-run event callback (phase lifecycle boundaries). */
  onPlanEvent?: (evt: PlanRunEvent) => Promise<void> | void;
  /** AbortSignal — when fired, kills the runtime subprocess and breaks the phase loop. */
  signal?: AbortSignal;
};

export type RunPhaseResult =
  | { result: 'done'; phase: PlanPhase; output: string; nextPhase?: { id: string; title: string } }
  | { result: 'failed'; phase: PlanPhase; output: string; error: string }
  | { result: 'audit_failed'; phase: PlanPhase; output: string; verdict: AuditVerdict; fixAttemptsUsed?: number }
  | { result: 'stale'; message: string }
  | { result: 'nothing_to_run' }
  | { result: 'corrupt'; message: string }
  | { result: 'retry_blocked'; phase: PlanPhase; message: string };

const ROLLOUT_ERROR_PATTERNS = [
  /rollout path missing/i,
  /session state appears corrupted/i,
  /state db.*rollout/i,
];

function isRolloutPathMissingError(error?: string): boolean {
  if (!error) return false;
  return ROLLOUT_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: Set<string> = new Set(['pending', 'in-progress', 'done', 'failed', 'skipped']);
const VALID_KINDS: Set<string> = new Set(['implement', 'read', 'audit']);
const PHASES_STATE_VERSION = 1;

/** Known workspace filenames that should be normalized to workspace/ prefix. */
const KNOWN_WORKSPACE_FILES = new Set([
  'TOOLS.md', 'AGENTS.md', 'MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
]);

/** Hardcoded project directory map. */
const PROJECT_DIRS: Record<string, string> = {
  discoclaw: path.join(os.homedir(), 'code/discoclaw'),
};


// ---------------------------------------------------------------------------
// Pure functions (no I/O)
// ---------------------------------------------------------------------------

export function computePlanHash(planContent: string): string {
  return createHash('sha256').update(planContent).digest('hex').slice(0, 16);
}

export function extractFilePaths(changesSection: string): string[] {
  const deterministic = extractFilePathsDeterministic(changesSection);
  const legacy = extractFilePathsLegacy(changesSection);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [...deterministic, ...legacy]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    merged.push(candidate);
  }

  return merged;
}

function extractFilePathsDeterministic(changesSection: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of changesSection.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const isHeading = /^#{1,6}\s+/.test(trimmed);
    const isList = /^[-*+]\s+/.test(trimmed);
    const isBoldEntry = /^\*{2,3}`[^`]+`\*{2,3}/.test(trimmed);
    if (!isHeading && !isList && !isBoldEntry) continue;

    for (const token of extractBacktickTokens(line)) {
      if (!isLikelyFilePath(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      paths.push(token);
    }
  }
  return paths;
}

function extractFilePathsLegacy(changesSection: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const regexes = [
    /^[\s]*-\s+(?:\*{1,3})?`([^`]+)`(?:\*{1,3})?/gm,
    /^#{1,6}\s+(?:\*{1,3})?`([^`]+)`(?:\*{1,3})?/gm,
    /^\s*\*{2,3}`([^`]+)`\*{2,3}(?:\s*[—–:-].*)?$/gm,
  ];

  for (const regex of regexes) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(changesSection)) !== null) {
      const candidate = m[1]!;
      if (!isLikelyFilePath(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
  }

  return paths;
}

function extractBacktickTokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const start = line.indexOf('`', i);
    if (start === -1) break;
    const end = line.indexOf('`', start + 1);
    if (end === -1) break;
    const token = line.slice(start + 1, end).trim();
    if (token) out.push(token);
    i = end + 1;
  }
  return out;
}

function isLikelyFilePath(s: string): boolean {
  // Must contain / or file extension
  if (!s.includes('/') && !s.includes('.')) return false;

  // Reject ALL_CAPS identifiers (config keys like PLAN_PHASES_ENABLED)
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return false;

  // Reject PascalCase type names (PlanPhase, RunPhaseResult)
  if (/^[A-Z][a-zA-Z]+$/.test(s) && !s.includes('/') && !s.includes('.')) return false;

  // Reject quoted strings ('pending', 'done')
  if (s.startsWith("'") || s.startsWith('"')) return false;

  // Reject single words without path separators or extensions
  if (!s.includes('/') && !/\.\w+$/.test(s)) return false;

  return true;
}

export function groupFiles(filePaths: string[], maxPerGroup: number): string[][] {
  if (filePaths.length === 0) return [];

  // 1. Pair module + test files
  const paired = new Map<string, string[]>();
  const testSuffixes = ['.test.ts', '.test.js', '.spec.ts', '.spec.js'];
  const assignedToModule = new Set<string>();

  for (const fp of filePaths) {
    const isTest = testSuffixes.some((s) => fp.endsWith(s));
    if (isTest) {
      // Find the module this test belongs to
      let moduleFile: string | undefined;
      for (const suffix of testSuffixes) {
        if (fp.endsWith(suffix)) {
          moduleFile = fp.slice(0, -suffix.length) + fp.slice(-suffix.length).replace(/\.(test|spec)\./, '.');
          break;
        }
      }
      if (moduleFile && filePaths.includes(moduleFile)) {
        if (!paired.has(moduleFile)) paired.set(moduleFile, [moduleFile]);
        paired.get(moduleFile)!.push(fp);
        assignedToModule.add(fp);
        assignedToModule.add(moduleFile);
      }
    }
  }

  // 2. Group remaining files by directory
  const dirGroups = new Map<string, string[]>();
  for (const fp of filePaths) {
    if (assignedToModule.has(fp)) continue;
    const dir = path.dirname(fp);
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(fp);
  }

  // 3. Merge paired groups + directory groups, respecting maxPerGroup
  const result: string[][] = [];

  // Add paired groups first
  for (const group of paired.values()) {
    if (group.length <= maxPerGroup) {
      result.push(group);
    } else {
      // Shouldn't happen (pairs are 2), but handle it
      for (let i = 0; i < group.length; i += maxPerGroup) {
        result.push(group.slice(i, i + maxPerGroup));
      }
    }
  }

  // Add directory groups, merging small ones and splitting large ones
  for (const [, files] of dirGroups) {
    // Try to merge into the last result group if it's from the same directory and has room
    if (files.length <= maxPerGroup) {
      result.push(files);
    } else {
      for (let i = 0; i < files.length; i += maxPerGroup) {
        result.push(files.slice(i, i + maxPerGroup));
      }
    }
  }

  return result;
}

export function extractChangeSpec(changesSection: string, filePaths: string[]): string {
  const blocks: string[] = [];
  const lines = changesSection.split('\n');

  for (const fp of filePaths) {
    let capturing = false;
    let block: string[] = [];
    let foundIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check if this line starts a top-level list item with our file path
      const topMatch = line.match(/^(\s*)-\s+`([^`]+)`/);
      if (topMatch) {
        const indent = topMatch[1]!.length;
        const matchedPath = topMatch[2]!;

        if (capturing) {
          // Hit a new top-level item — stop capturing
          if (indent <= foundIndent) {
            capturing = false;
          }
        }

        if (!capturing && matchedPath === fp) {
          capturing = true;
          foundIndent = indent;
          block = [line];
          continue;
        }
      }

      if (capturing) {
        // Check if this is a new top-level item (same or less indent) or a section header
        if (line.match(/^#{1,4}\s/) || (topMatch && topMatch[1]!.length <= foundIndent)) {
          capturing = false;
        } else {
          block.push(line);
        }
      }
    }

    if (block.length > 0) {
      blocks.push(block.join('\n'));
    } else {
      blocks.push(`File \`${fp}\` — not described in Changes section; create per Objective.`);
    }
  }

  return blocks.join('\n\n');
}

export function decomposePlan(planContent: string, planId: string, planFile: string, maxContextFiles = 5): PlanPhases {
  const hash = computePlanHash(planContent);
  const now = new Date().toISOString().split('T')[0]!;

  const changesSection = extractTopLevelSection(planContent, 'Changes');
  const manifestSection = extractTopLevelSection(planContent, 'Change Manifest');
  const manifestPaths = parseChangeManifest(manifestSection);
  const filePaths = manifestPaths.length > 0
    ? manifestPaths
    : extractFilePaths(changesSection);

  const phases: PlanPhase[] = [];

  if (filePaths.length === 0) {
    // Minimal 2-phase set for plans without file paths
    phases.push({
      id: 'phase-1',
      title: 'Read and analyze plan',
      kind: 'read',
      description: 'Read the plan file and produce analysis notes.',
      status: 'pending',
      dependsOn: [],
      contextFiles: [planFile],
    });
    phases.push({
      id: 'phase-2',
      title: 'Implement plan',
      kind: 'implement',
      description: 'Execute the plan objectives.',
      status: 'pending',
      dependsOn: ['phase-1'],
      contextFiles: [planFile],
    });
    phases.push({
      id: 'phase-3',
      title: 'Post-implementation audit',
      kind: 'audit',
      description: 'Audit the implementation against the plan specification.',
      status: 'pending',
      dependsOn: ['phase-2'],
      contextFiles: [planFile],
    });
  } else {
    // Group files into batches
    const groups = groupFiles(filePaths, maxContextFiles);
    const implPhaseIds: string[] = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const phaseId = `phase-${i + 1}`;
      implPhaseIds.push(phaseId);

      // Normalize bare workspace filenames in contextFiles
      const contextFiles = group.map(normalizeWorkspacePath);

      const changeSpec = extractChangeSpec(changesSection, group);

      phases.push({
        id: phaseId,
        title: `Implement ${formatGroupTitle(group)}`,
        kind: 'implement',
        description: `Implement changes for: ${group.map((f) => `\`${f}\``).join(', ')}`,
        status: 'pending',
        dependsOn: i > 0 ? [implPhaseIds[i - 1]!] : [],
        contextFiles,
        changeSpec,
      });
    }

    // Post-implementation audit phase
    const auditContextFiles = filePaths.map(normalizeWorkspacePath);
    phases.push({
      id: `phase-${groups.length + 1}`,
      title: 'Post-implementation audit',
      kind: 'audit',
      description: 'Audit all changes against the plan specification.',
      status: 'pending',
      dependsOn: implPhaseIds,
      contextFiles: auditContextFiles,
    });
  }

  return {
    planId,
    planFile,
    planContentHash: hash,
    phases,
    createdAt: now,
    updatedAt: now,
  };
}

function extractTopLevelSection(planContent: string, sectionName: string): string {
  const lines = planContent.split('\n');
  const target = sectionName.trim().toLowerCase();
  let inFence = false;
  let capturing = false;
  const body: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
    }

    if (!inFence) {
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        const heading = headingMatch[1]!.trim().toLowerCase();
        if (!capturing && heading === target) {
          capturing = true;
          continue;
        }
        if (capturing) break;
      }
    }

    if (capturing) body.push(line);
  }

  return body.join('\n').trim();
}

function parseChangeManifest(section: string): string[] {
  if (!section) return [];
  const json = extractFirstJsonValue(section, { arrayOnly: true });
  if (!json) return [];

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== 'string') continue;
      const candidate = value.trim();
      if (!isLikelyFilePath(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
    return paths;
  } catch {
    return [];
  }
}

function normalizeWorkspacePath(fp: string): string {
  const basename = path.basename(fp);
  if (KNOWN_WORKSPACE_FILES.has(basename) && !fp.startsWith('workspace/') && !fp.includes('/')) {
    return `workspace/${fp}`;
  }
  return fp;
}

function formatGroupTitle(files: string[]): string {
  if (files.length === 1) return path.basename(files[0]!);
  const dir = path.dirname(files[0]!);
  if (files.every((f) => path.dirname(f) === dir)) {
    return `${dir}/ (${files.length} files)`;
  }
  return `${files.length} files`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializePhases(phases: PlanPhases): string {
  const lines: string[] = [];
  lines.push(`# Phases: ${phases.planId} — ${phases.planFile}`);
  lines.push(`Created: ${phases.createdAt}`);
  lines.push(`Updated: ${phases.updatedAt}`);
  lines.push(`Plan hash: ${phases.planContentHash}`);
  lines.push('');

  for (const phase of phases.phases) {
    lines.push(`## ${phase.id}: ${phase.title}`);
    lines.push(`**Kind:** ${phase.kind}`);
    lines.push(`**Status:** ${phase.status}`);
    lines.push(`**Context:** ${phase.contextFiles.map((f) => `\`${f}\``).join(', ') || '(none)'}`);
    lines.push(`**Depends on:** ${phase.dependsOn.length > 0 ? phase.dependsOn.join(', ') : '(none)'}`);
    if (phase.gitCommit) lines.push(`**Git commit:** ${phase.gitCommit}`);
    if (phase.modifiedFiles && phase.modifiedFiles.length > 0) {
      lines.push(`**Modified files:** ${phase.modifiedFiles.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (phase.failureHashes) {
      lines.push(`**Failure hashes:** ${JSON.stringify(phase.failureHashes)}`);
    }
    lines.push('');
    lines.push(phase.description);

    if (phase.changeSpec) {
      lines.push('');
      lines.push('**Change spec:**');
      lines.push(phase.changeSpec);
    }

    if (phase.output) {
      lines.push('');
      lines.push(`**Output:** ${phase.output}`);
    }
    if (phase.error) {
      lines.push('');
      lines.push(`**Error:** ${phase.error}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function deserializePhases(content: string): PlanPhases {
  const headerMatch = content.match(/^# Phases:\s*(\S+)\s*—\s*(.+)$/m);
  if (!headerMatch) throw new Error('Malformed phases file: missing header');

  const planId = headerMatch[1]!;
  const planFile = headerMatch[2]!.trim();

  const createdMatch = content.match(/^Created:\s*(.+)$/m);
  const updatedMatch = content.match(/^Updated:\s*(.+)$/m);
  const hashMatch = content.match(/^Plan hash:\s*(\S+)$/m);

  if (!hashMatch) throw new Error('Malformed phases file: missing plan hash');

  const createdAt = createdMatch?.[1]?.trim() ?? '';
  const updatedAt = updatedMatch?.[1]?.trim() ?? '';
  const planContentHash = hashMatch[1]!;

  // Split into phase sections
  const phaseSections = content.split(/^## /m).slice(1); // first split is the header
  const phases: PlanPhase[] = [];

  for (const section of phaseSections) {
    const idTitleMatch = section.match(/^(phase-\d+):\s*(.+)$/m);
    if (!idTitleMatch) continue;

    const id = idTitleMatch[1]!;
    const title = idTitleMatch[2]!.trim();

    const kindMatch = section.match(/^\*\*Kind:\*\*\s*(\S+)/m);
    const statusMatch = section.match(/^\*\*Status:\*\*\s*(\S+)/m);
    const contextMatch = section.match(/^\*\*Context:\*\*\s*(.+)$/m);
    const dependsMatch = section.match(/^\*\*Depends on:\*\*\s*(.+)$/m);
    const commitMatch = section.match(/^\*\*Git commit:\*\*\s*(\S+)/m);
    const modifiedMatch = section.match(/^\*\*Modified files:\*\*\s*(.+)$/m);
    const failureHashesMatch = section.match(/^\*\*Failure hashes:\*\*\s*(.+)$/m);
    const outputMatch = section.match(/^\*\*Output:\*\*\s*([\s\S]*?)(?=\n\*\*(?:Error|Change spec):\*\*|\n---|\n$)/m);
    const errorMatch = section.match(/^\*\*Error:\*\*\s*([\s\S]*?)(?=\n\*\*(?:Output|Change spec):\*\*|\n---|\n$)/m);
    const changeSpecMatch = section.match(/^\*\*Change spec:\*\*\n([\s\S]*?)(?=\n\*\*(?:Output|Error):\*\*|\n---|\n$)/m);

    const kindValue = kindMatch?.[1]?.trim() ?? 'implement';
    const statusValue = statusMatch?.[1]?.trim() ?? 'pending';

    if (!VALID_KINDS.has(kindValue)) {
      throw new Error(`Unknown phase kind: '${kindValue}' in ${id}`);
    }
    if (!VALID_STATUSES.has(statusValue)) {
      throw new Error(`Unknown phase status: '${statusValue}' in ${id}`);
    }

    const contextRaw = contextMatch?.[1]?.trim() ?? '(none)';
    const contextFiles = contextRaw === '(none)'
      ? []
      : [...contextRaw.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

    const dependsRaw = dependsMatch?.[1]?.trim() ?? '(none)';
    const dependsOn = dependsRaw === '(none)'
      ? []
      : dependsRaw.split(',').map((s) => s.trim()).filter(Boolean);

    // Extract description: text between metadata lines and first **field or ---
    const metadataEnd = section.indexOf('\n\n');
    let description = '';
    if (metadataEnd !== -1) {
      const afterMetadata = section.slice(metadataEnd + 2);
      // Description is everything until the first **field or ---
      const descEnd = afterMetadata.search(/^\*\*(Change spec|Output|Error|Modified files|Failure hashes):\*\*/m);
      const dashEnd = afterMetadata.indexOf('\n---');
      const cutoff = descEnd >= 0 ? descEnd : (dashEnd >= 0 ? dashEnd : afterMetadata.length);
      description = afterMetadata.slice(0, cutoff).trim();
    }

    const phase: PlanPhase = {
      id,
      title,
      kind: kindValue as PhaseKind,
      description,
      status: statusValue as PhaseStatus,
      dependsOn,
      contextFiles,
    };

    if (changeSpecMatch) phase.changeSpec = changeSpecMatch[1]!.trim();
    if (outputMatch) phase.output = outputMatch[1]!.trim();
    if (errorMatch) phase.error = errorMatch[1]!.trim();
    if (commitMatch) phase.gitCommit = commitMatch[1]!;
    if (modifiedMatch) {
      phase.modifiedFiles = [...modifiedMatch[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    }
    if (failureHashesMatch) {
      try {
        phase.failureHashes = JSON.parse(failureHashesMatch[1]!);
      } catch {
        throw new Error(`Malformed failureHashes in ${id}`);
      }
    }

    phases.push(phase);
  }

  if (phases.length === 0) {
    throw new Error('Malformed phases file: no phases found');
  }

  return {
    planId,
    planFile,
    planContentHash,
    phases,
    createdAt,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Phase navigation
// ---------------------------------------------------------------------------

export function getNextPhase(phases: PlanPhases): PlanPhase | null {
  // Priority 1: resume in-progress
  const inProgress = phases.phases.find((p) => p.status === 'in-progress');
  if (inProgress) return inProgress;

  // Priority 2: retry failed
  const failed = phases.phases.find((p) => p.status === 'failed');
  if (failed) return failed;

  // Priority 3: first pending with all deps met
  for (const phase of phases.phases) {
    if (phase.status !== 'pending') continue;
    const depsMet = phase.dependsOn.every((depId) => {
      const dep = phases.phases.find((p) => p.id === depId);
      return dep?.status === 'done' || dep?.status === 'skipped';
    });
    if (depsMet) return phase;
  }

  return null;
}

// ---------------------------------------------------------------------------
// State updates (immutable)
// ---------------------------------------------------------------------------

export function updatePhaseStatus(
  phases: PlanPhases,
  phaseId: string,
  status: PhaseStatus,
  output?: string,
  error?: string,
): PlanPhases {
  const now = new Date().toISOString().split('T')[0]!;
  return {
    ...phases,
    updatedAt: now,
    phases: phases.phases.map((p) => {
      if (p.id !== phaseId) return p;
      return {
        ...p,
        status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }),
  };
}

export function checkStaleness(
  phases: PlanPhases,
  currentPlanContent: string,
): { stale: boolean; message: string } {
  const currentHash = computePlanHash(currentPlanContent);
  if (currentHash !== phases.planContentHash) {
    return {
      stale: true,
      message:
        'Plan file has changed since phases were generated — the existing phases may not match the current plan intent and cannot run safely.\n\n' +
        '**Fix:** `!plan phases --regenerate <plan-id>`\n\n' +
        'This regenerates phases from the current plan content. All phase statuses are reset to `pending` — previously completed phases will be re-executed. Git commits from completed phases are preserved on the branch, but the phase tracker loses their `done` status.',
    };
  }
  return { stale: false, message: '' };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extract the ## Objective section from plan content. */
export function extractObjective(planContent: string): string {
  const objMatch = planContent.match(/## Objective\s*\n([\s\S]*?)(?=\n## )/);
  return objMatch?.[1]?.trim() ?? '(no objective found in plan)';
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildPhasePrompt(
  phase: PlanPhase,
  planContent: string,
  injectedContext?: string,
): string {
  const lines: string[] = [PHASE_SAFETY_REMINDER, ''];

  lines.push('## Objective');
  lines.push('');
  lines.push(extractObjective(planContent));
  lines.push('');

  // Inject pre-read workspace context for implement phases
  if (injectedContext) {
    lines.push('## Pre-read Context Files');
    lines.push('');
    lines.push(injectedContext);
    lines.push('');
  }

  if (phase.kind === 'implement') {
    lines.push('## Task');
    lines.push('');
    lines.push(phase.description);
    lines.push('');

    if (phase.changeSpec) {
      lines.push('## Change Specification');
      lines.push('');
      lines.push(phase.changeSpec);
      lines.push('');
    }

    lines.push('## Context Files');
    lines.push('');
    if (phase.contextFiles.length > 0) {
      lines.push('Read these files to understand the current state, then implement the changes:');
      for (const f of phase.contextFiles) {
        lines.push(`- \`${f}\``);
      }
    }
    lines.push('');

    lines.push('## Instructions');
    lines.push('');
    lines.push('Implement the specified changes using the Write, Edit, and Read tools.');
    lines.push('After making changes, output a brief summary of what was changed.');
  } else if (phase.kind === 'read') {
    lines.push('## Task');
    lines.push('');
    lines.push(phase.description);
    lines.push('');

    lines.push('## Context Files');
    lines.push('');
    if (phase.contextFiles.length > 0) {
      lines.push('Read and analyze these files:');
      for (const f of phase.contextFiles) {
        lines.push(`- \`${f}\``);
      }
    }
    lines.push('');

    lines.push('## Instructions');
    lines.push('');
    lines.push('Read the specified files and produce analysis notes. Use Read, Glob, and Grep tools only.');
  } else {
    // audit
    lines.push('## Task');
    lines.push('');
    lines.push(phase.description);
    lines.push('');

    lines.push('## Context Files');
    lines.push('');
    if (phase.contextFiles.length > 0) {
      lines.push('Audit these files against the plan specification:');
      for (const f of phase.contextFiles) {
        lines.push(`- \`${f}\``);
      }
    }
    lines.push('');

    lines.push('## Instructions');
    lines.push('');
    lines.push('Compare the implementation against the plan specification. For each concern found, use this EXACT format:');
    lines.push('');
    lines.push('**Concern N: [title]**');
    lines.push('Description of the deviation.');
    lines.push('**Severity: blocking | medium | minor | suggestion**');
    lines.push('');
    lines.push('Severity level definitions:');
    lines.push('- **blocking** — Correctness bugs, security issues, architectural flaws, missing critical functionality. The plan cannot ship with this unresolved.');
    lines.push('- **medium** — Substantive improvements that would make the plan better but aren\'t showstoppers. Missing edge case handling, incomplete error paths.');
    lines.push('- **minor** — Small issues: naming, style, minor clarity gaps. Worth noting, not worth looping over.');
    lines.push('- **suggestion** — Ideas for future improvement. Not problems with the current plan.');
    lines.push('');
    lines.push('IMPORTANT: Each concern MUST have its own **Severity: X** line. Do NOT use tables, summary grids, or any other format for severity ratings — the automated fix loop parses these markers to decide whether to trigger revisions.');
    lines.push('');
    lines.push('End with a **Verdict:** line — either "Needs revision." (if any blocking concerns) or "Ready to approve." (if no blocking concerns).');
    lines.push('');
    lines.push('Use Read, Glob, and Grep tools only.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post-run summary
// ---------------------------------------------------------------------------

/**
 * Build a concise human-readable rollup of all phases after a plan run completes.
 * Returns an empty string when there are no phases.
 * The `budgetChars` parameter (default 800) caps total output length — if the
 * files list exceeds budget, it is truncated with an overflow count.
 */
export function buildPostRunSummary(phases: PlanPhases, budgetChars = 800): string {
  if (phases.phases.length === 0) return '';

  const statusIndicator: Record<string, string> = {
    'done': '[x]',
    'failed': '[!]',
    'skipped': '[-]',
    'in-progress': '[~]',
    'pending': '[ ]',
  };

  const lines: string[] = [];

  // Per-phase lines
  for (const phase of phases.phases) {
    const indicator = statusIndicator[phase.status] ?? '[ ]';
    const commit = phase.gitCommit ? ` (${phase.gitCommit})` : '';
    const fileCount = phase.modifiedFiles && phase.modifiedFiles.length > 0
      ? ` · ${phase.modifiedFiles.length} file${phase.modifiedFiles.length === 1 ? '' : 's'}`
      : '';

    let line = `${indicator} **${phase.id}:** ${phase.title}${commit}${fileCount}`;

    // For audit phases, append a one-line verdict extracted from output
    if (phase.kind === 'audit' && phase.output) {
      const verdictMatch = phase.output.match(/\*\*Verdict:\*\*\s*(.+)/);
      if (verdictMatch) {
        line += ` — ${verdictMatch[1]!.trim()}`;
      }
    }

    lines.push(line);
  }

  // Collect all unique modified files across phases
  const allFiles: string[] = [];
  const seen = new Set<string>();
  for (const phase of phases.phases) {
    for (const f of phase.modifiedFiles ?? []) {
      if (!seen.has(f)) {
        seen.add(f);
        allFiles.push(f);
      }
    }
  }

  // Build phase section
  const phaseSection = lines.join('\n');

  if (allFiles.length === 0) {
    return phaseSection;
  }

  // Build files section with budget enforcement
  const headerLine = `\n\n**Files changed (${allFiles.length}):**`;
  const budgetForFiles = Math.max(0, budgetChars - phaseSection.length - headerLine.length - 5); // 5 chars margin

  const fileLines: string[] = [];
  let usedChars = 0;
  let overflow = 0;

  for (const f of allFiles) {
    const entry = `\`${f}\``;
    if (usedChars + entry.length + 2 > budgetForFiles) {
      overflow = allFiles.length - fileLines.length;
      break;
    }
    fileLines.push(entry);
    usedChars += entry.length + 2; // +2 for ", " separator
  }

  let filesSection = headerLine + '\n' + fileLines.join(', ');
  if (overflow > 0) {
    filesSection += ` (+${overflow} more)`;
  }

  return phaseSection + filesSection;
}

export function buildAuditFixPrompt(
  planContent: string,
  auditOutput: string,
  contextFiles: string[],
  modifiedFilesList: string[],
  attemptNumber: number,
  maxAttempts: number,
): string {
  const lines: string[] = [PHASE_SAFETY_REMINDER, ''];

  lines.push('## Objective');
  lines.push('');
  lines.push(extractObjective(planContent));
  lines.push('');

  lines.push('## Task');
  lines.push('');
  if (attemptNumber === maxAttempts) {
    lines.push(`Fix attempt ${attemptNumber} of ${maxAttempts} — this is your last chance. Make minimal, targeted fixes only.`);
  } else {
    lines.push(`Fix attempt ${attemptNumber} of ${maxAttempts}.`);
  }
  lines.push('The post-implementation audit found deviations that need fixing.');
  lines.push('');

  lines.push('## Audit Findings');
  lines.push('');
  lines.push(auditOutput);
  lines.push('');

  lines.push('## Context Files');
  lines.push('');
  for (const f of contextFiles) {
    lines.push(`- \`${f}\``);
  }
  lines.push('');

  if (modifiedFilesList.length > 0) {
    lines.push('## Modified Files');
    lines.push('');
    for (const f of modifiedFilesList) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('Fix only the specific deviations identified in the audit. Do not refactor, reorganize, or modify code that the audit did not flag.');
  lines.push('You have read/write file tools only — you cannot run tests, build commands, or install packages. Focus on code-level fixes.');
  lines.push('After making changes, output a brief summary of what was fixed.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project directory resolution
// ---------------------------------------------------------------------------

export function resolveProjectCwd(
  planContent: string,
  workspaceCwd: string,
  projectDirMap: Record<string, string> = PROJECT_DIRS,
): string {
  const projectMatch = planContent.match(/^\*\*Project:\*\*\s*(.+)$/m);
  if (!projectMatch) {
    throw new Error('Plan has no **Project:** field. Cannot determine source directory.');
  }

  const projectName = projectMatch[1]!.trim();
  const projectDir = projectDirMap[projectName];

  if (!projectDir) {
    throw new Error(
      `Project '${projectName}' not in project directory map. Add it to the map in plan-manager.ts or set the **Project:** field to a known project.`,
    );
  }

  // Validate directory exists
  try {
    const stat = fsSync.statSync(projectDir);
    if (!stat.isDirectory()) {
      throw new Error(`Project directory is not a directory: ${projectDir}`);
    }
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : null;
    if (code === 'ENOENT') {
      throw new Error(`Project directory does not exist: ${projectDir}`);
    }
    throw err;
  }

  // Note: symlinks to workspaceCwd (e.g. workspace → discoclaw-data/workspace) are
  // allowed here. The real safety gate is resolveContextFilePath, which canonicalizes
  // all paths and checks they resolve under an allowed root (projectCwd or workspaceCwd).

  return projectDir;
}

// ---------------------------------------------------------------------------
// Context file path resolution
// ---------------------------------------------------------------------------

export function resolveContextFilePath(
  filePath: string,
  projectCwd: string,
  workspaceCwd: string,
): string {
  let resolved: string;

  if (filePath.startsWith('workspace/')) {
    // Strip workspace/ prefix and resolve against workspaceCwd
    const stripped = filePath.slice('workspace/'.length);
    resolved = path.resolve(workspaceCwd, stripped);
  } else {
    // Resolve against projectCwd
    resolved = path.resolve(projectCwd, filePath);
  }

  // Canonicalize both roots
  const realProjectCwd = safeRealpath(projectCwd);
  const realWorkspaceCwd = safeRealpath(workspaceCwd);

  // Canonicalize the resolved path (handle symlinks, non-existent files)
  const realResolved = safeRealpathWalkUp(resolved);

  // Check if under either root
  if (
    realResolved === realProjectCwd ||
    realResolved.startsWith(realProjectCwd + path.sep) ||
    realResolved === realWorkspaceCwd ||
    realResolved.startsWith(realWorkspaceCwd + path.sep)
  ) {
    return realResolved;
  }

  throw new Error(
    `Context file path '${filePath}' resolves to '${realResolved}' which is outside allowed roots ` +
    `(project: ${realProjectCwd}, workspace: ${realWorkspaceCwd})`,
  );
}

function safeRealpath(p: string): string {
  try {
    return fsSync.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve realpath, walking up to the nearest existing ancestor for non-existent files.
 */
function safeRealpathWalkUp(p: string): string {
  try {
    return fsSync.realpathSync(p);
  } catch {
    // Walk up to find nearest existing ancestor
    let current = p;
    const remaining: string[] = [];
    while (current !== path.dirname(current)) {
      try {
        const real = fsSync.realpathSync(current);
        return path.join(real, ...remaining);
      } catch {
        remaining.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }
    // Fallback: no ancestor exists (shouldn't happen in practice)
    return path.resolve(p);
  }
}

// ---------------------------------------------------------------------------
// I/O functions
// ---------------------------------------------------------------------------

export function writePhasesFile(filePath: string, phases: PlanPhases): void {
  const jsonPath = phasesJsonPath(filePath);
  const jsonContent = serializePhasesStateJson(phases);
  writeTextAtomically(jsonPath, jsonContent);

  const content = serializePhases(phases);
  writeTextAtomically(filePath, content);
}

export function readPhasesFile(
  filePath: string,
  opts?: { backfillJson?: boolean; log?: LoggerLike },
): PlanPhases {
  const jsonPath = phasesJsonPath(filePath);
  let jsonErr: unknown;

  if (fsSync.existsSync(jsonPath)) {
    try {
      const jsonContent = fsSync.readFileSync(jsonPath, 'utf-8');
      return deserializePhasesStateJson(jsonContent);
    } catch (err) {
      jsonErr = err;
      opts?.log?.warn(
        { err, jsonPath },
        'plan-manager: phases json invalid, falling back to markdown',
      );
    }
  }

  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    const phases = deserializePhases(content);

    if (opts?.backfillJson ?? true) {
      try {
        const jsonContent = serializePhasesStateJson(phases);
        writeTextAtomically(jsonPath, jsonContent);
      } catch (backfillErr) {
        opts?.log?.warn(
          { err: backfillErr, jsonPath },
          'plan-manager: failed to backfill phases json from markdown',
        );
      }
    }

    return phases;
  } catch (mdErr) {
    if (!jsonErr) throw mdErr;
    throw new Error(
      `Failed to read phases state. JSON error: ${String(jsonErr)}. Markdown error: ${String(mdErr)}`,
    );
  }
}

function phasesJsonPath(markdownPath: string): string {
  return markdownPath.endsWith('.md')
    ? markdownPath.slice(0, -'.md'.length) + '.json'
    : `${markdownPath}.json`;
}

function writeTextAtomically(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  fsSync.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fsSync.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsSync.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function serializePhasesStateJson(phases: PlanPhases): string {
  const state: PlanPhasesStateV1 = {
    version: PHASES_STATE_VERSION,
    ...phases,
  };
  return JSON.stringify(state, null, 2) + '\n';
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Malformed phases json: ${field} must be a string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Malformed phases json: ${field} must be string[]`);
  }
  return value;
}

function asFailureHashes(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed phases json: ${field} must be Record<string,string>`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`Malformed phases json: ${field}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function deserializePhasesStateJson(raw: string): PlanPhases {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Malformed phases json: invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Malformed phases json: expected object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== PHASES_STATE_VERSION) {
    throw new Error(`Malformed phases json: unsupported version '${String(obj.version)}'`);
  }

  const phasesRaw = obj.phases;
  if (!Array.isArray(phasesRaw)) {
    throw new Error('Malformed phases json: phases must be an array');
  }

  const phases: PlanPhase[] = phasesRaw.map((phaseRaw, idx) => {
    if (!phaseRaw || typeof phaseRaw !== 'object' || Array.isArray(phaseRaw)) {
      throw new Error(`Malformed phases json: phases[${idx}] must be an object`);
    }
    const p = phaseRaw as Record<string, unknown>;
    const kind = asString(p.kind, `phases[${idx}].kind`);
    const status = asString(p.status, `phases[${idx}].status`);
    if (!VALID_KINDS.has(kind)) throw new Error(`Unknown phase kind: '${kind}' in phases[${idx}]`);
    if (!VALID_STATUSES.has(status)) throw new Error(`Unknown phase status: '${status}' in phases[${idx}]`);

    const phase: PlanPhase = {
      id: asString(p.id, `phases[${idx}].id`),
      title: asString(p.title, `phases[${idx}].title`),
      kind: kind as PhaseKind,
      description: asString(p.description, `phases[${idx}].description`),
      status: status as PhaseStatus,
      dependsOn: asStringArray(p.dependsOn, `phases[${idx}].dependsOn`),
      contextFiles: asStringArray(p.contextFiles, `phases[${idx}].contextFiles`),
    };

    if (typeof p.changeSpec === 'string') phase.changeSpec = p.changeSpec;
    if (typeof p.output === 'string') phase.output = p.output;
    if (typeof p.error === 'string') phase.error = p.error;
    if (typeof p.gitCommit === 'string') phase.gitCommit = p.gitCommit;
    if (p.modifiedFiles !== undefined) {
      phase.modifiedFiles = asStringArray(p.modifiedFiles, `phases[${idx}].modifiedFiles`);
    }
    if (p.failureHashes !== undefined) {
      phase.failureHashes = asFailureHashes(p.failureHashes, `phases[${idx}].failureHashes`);
    }
    return phase;
  });

  return {
    planId: asString(obj.planId, 'planId'),
    planFile: asString(obj.planFile, 'planFile'),
    planContentHash: asString(obj.planContentHash, 'planContentHash'),
    phases,
    createdAt: asString(obj.createdAt, 'createdAt'),
    updatedAt: asString(obj.updatedAt, 'updatedAt'),
  };
}

export async function executePhase(
  phase: PlanPhase,
  planContent: string,
  phases: PlanPhases,
  opts: PhaseExecutionOpts,
  injectedContext?: string,
): Promise<
  | { status: 'done'; output: string }
  | { status: 'failed'; output: string; error: string }
  | { status: 'audit_failed'; output: string; error: string; verdict: AuditVerdict }
> {
  // Derive tools from phase kind
  const tools = phase.kind === 'implement'
    ? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']
    : ['Read', 'Glob', 'Grep'];

  // Derive addDirs based on phase kind
  let addDirs: string[];
  if (phase.kind === 'implement') {
    // Filter out workspace paths for implement phases
    const realWorkspace = safeRealpath(opts.workspaceCwd);
    addDirs = opts.addDirs.filter((d) => {
      const realD = safeRealpath(d);
      if (realD === realWorkspace || realD.startsWith(realWorkspace + path.sep)) {
        opts.log?.warn({ path: d }, 'Filtered workspace path from implement phase addDirs');
        return false;
      }
      return true;
    });
  } else {
    // read/audit get workspace access
    addDirs = [opts.workspaceCwd, ...opts.addDirs];
  }

  const prompt = buildPhasePrompt(phase, planContent, injectedContext);

  try {
    const output = await collectRuntimeText(
      opts.runtime,
      prompt,
      opts.model,
      opts.projectCwd,
      tools,
      addDirs,
      opts.timeoutMs,
      { requireFinalEvent: true, onEvent: opts.onEvent, signal: opts.signal, toolCallGate: true },
    );

    if (phase.kind === 'audit') {
      const verdict = parseAuditVerdict(output);
      if (verdict.shouldLoop) {
        return { status: 'audit_failed', output, error: `Audit found ${verdict.maxSeverity} severity deviations`, verdict };
      }
    }

    return { status: 'done', output };
  } catch (err) {
    const errorMsg = String(err instanceof Error ? err.message : err);
    return { status: 'failed', output: '', error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitAvailable(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function gitDiffNames(cwd: string): Set<string> | null {
  try {
    const result = new Set<string>();
    const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    for (const line of [...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]) {
      if (line.trim()) result.add(line.trim());
    }
    return result;
  } catch {
    return null;
  }
}

function hashFileContent(filePath: string): string {
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// High-level runner
// ---------------------------------------------------------------------------

export async function runNextPhase(
  phasesFilePath: string,
  planFilePath: string,
  opts: PhaseExecutionOpts,
  onProgress: (msg: string) => Promise<void>,
): Promise<RunPhaseResult> {
  // Destructive tool call gate: wrap onEvent to detect and flag destructive tool_start events.
  let destructiveDetected = false;
  let destructiveReason = '';
  const wrappedOnEvent = (evt: EngineEvent): void => {
    if (evt.type === 'tool_start') {
      const { matched, reason } = matchesDestructivePattern(evt.name, evt.input);
      if (matched) {
        destructiveDetected = true;
        destructiveReason = reason;
      }
    }
    opts.onEvent?.(evt);
  };
  const gatedOpts: PhaseExecutionOpts = { ...opts, onEvent: wrappedOnEvent };

  // 1. Read and deserialize phases file
  let allPhases: PlanPhases;
  try {
    allPhases = readPhasesFile(phasesFilePath, { backfillJson: true, log: opts.log });
  } catch (err) {
    return { result: 'corrupt', message: `Failed to read phases file: ${String(err)}` };
  }

  // 2. Read plan and check staleness
  let planContent: string;
  try {
    planContent = fsSync.readFileSync(planFilePath, 'utf-8');
  } catch (err) {
    return { result: 'corrupt', message: `Failed to read plan file: ${String(err)}` };
  }

  const staleness = checkStaleness(allPhases, planContent);
  if (staleness.stale) {
    return { result: 'stale', message: staleness.message };
  }

  // 3. Get next phase
  const phase = getNextPhase(allPhases);
  if (!phase) {
    return { result: 'nothing_to_run' };
  }

  // 4. Retry safety check
  const isGitAvailable = gitAvailable(opts.projectCwd);

  const allowRetryDespiteFailure = isRolloutPathMissingError(phase.error);
  if (phase.status === 'failed' && phase.kind !== 'audit' && !allowRetryDespiteFailure) {
    if (isGitAvailable) {
      if (!phase.modifiedFiles || phase.modifiedFiles.length === 0) {
        return {
          result: 'retry_blocked',
          phase,
          message: 'Phase failed but has no modifiedFiles — cannot safely determine what to revert. Use `!plan skip` or `!plan phases --regenerate`.',
        };
      }
      if (!phase.failureHashes) {
        return {
          result: 'retry_blocked',
          phase,
          message: 'Phase has modifiedFiles but no failureHashes — cannot safely determine which files to revert. Use `!plan skip` or `!plan phases --regenerate`.',
        };
      }
    }
    // Non-git: proceed unconditionally
  }

  if (opts.onPlanEvent) {
    try {
      await opts.onPlanEvent({
        type: 'phase_start',
        planId: allPhases.planId,
        phase: {
          id: phase.id,
          title: phase.title,
          kind: phase.kind,
        },
      });
    } catch (err) {
      opts.log?.warn(
        { err, planId: allPhases.planId, phaseId: phase.id },
        'plan-manager: onPlanEvent callback failed',
      );
    }
  }

  // 5. Write in-progress status to disk
  await onProgress(`**${phase.id}**: Running ${phase.title}...`);
  allPhases = updatePhaseStatus(allPhases, phase.id, 'in-progress');
  writePhasesFile(phasesFilePath, allPhases);

  // 6. Git snapshot (null = git command failed, skip modified-files tracking)
  const preSnapshot = isGitAvailable ? gitDiffNames(opts.projectCwd) : null;

  // 7. Auto-revert on retry
  if (phase.status === 'failed' && phase.modifiedFiles && phase.failureHashes && isGitAvailable && preSnapshot) {
    // Note: we are re-reading phase from the old allPhases data (before status update).
    // The status was 'failed' when getNextPhase returned it, and we updated to 'in-progress' in step 5.
    // The modifiedFiles/failureHashes are from the old data.
    const origPhase = allPhases.phases.find((p) => p.id === phase.id);
    const modFiles = origPhase?.modifiedFiles ?? phase.modifiedFiles;
    const failHashes = origPhase?.failureHashes ?? phase.failureHashes;

    const trackedToRevert: string[] = [];
    const untrackedToClean: string[] = [];

    for (const file of modFiles) {
      const currentHash = hashFileContent(path.join(opts.projectCwd, file));
      const failHash = failHashes[file];

      if (!failHash || currentHash !== failHash) {
        await onProgress(`Skipping revert of \`${file}\` — modified since last attempt. Retry will proceed with current state.`);
        continue;
      }

      // Hash matches — safe to revert
      if (preSnapshot.has(file)) {
        // File was in pre-snapshot, so it's tracked + dirty or staged
        trackedToRevert.push(file);
      } else {
        // File was not in pre-execution snapshot = created by failed attempt
        untrackedToClean.push(file);
      }
    }

    if (trackedToRevert.length > 0) {
      try {
        execFileSync('git', ['checkout', '--', ...trackedToRevert], { cwd: opts.projectCwd, stdio: 'pipe' });
      } catch (err) {
        opts.log?.warn({ err, files: trackedToRevert }, 'plan-manager: revert tracked files failed');
      }
    }

    if (untrackedToClean.length > 0) {
      try {
        execFileSync('git', ['clean', '-f', '--', ...untrackedToClean], { cwd: opts.projectCwd, stdio: 'pipe' });
      } catch (err) {
        opts.log?.warn({ err, files: untrackedToClean }, 'plan-manager: clean untracked files failed');
      }
    }
  }

  // 8. Context injection for implement phases
  const MAX_INJECTED_CONTEXT_BYTES = 100 * 1024; // 100 KB budget
  let injectedContext: string | undefined;
  if (phase.kind === 'implement') {
    const hasWorkspaceFiles = phase.contextFiles.some((cf) => cf.startsWith('workspace/'));
    if (hasWorkspaceFiles) {
      await onProgress(`**${phase.id}**: Reading context files...`);
    }
    const blocks: string[] = [];
    let totalBytes = 0;
    for (const cf of phase.contextFiles) {
      if (!cf.startsWith('workspace/')) continue;
      const stripped = cf.slice('workspace/'.length);
      const absPath = path.resolve(opts.workspaceCwd, stripped);
      try {
        const content = fsSync.readFileSync(absPath, 'utf-8');
        const block = `### File: ${cf}\n\`\`\`\n${content}\n\`\`\``;
        if (totalBytes + block.length > MAX_INJECTED_CONTEXT_BYTES) {
          opts.log?.warn({ file: cf, size: block.length, budget: MAX_INJECTED_CONTEXT_BYTES }, 'plan-manager: context file exceeds injection budget, skipping');
          continue;
        }
        totalBytes += block.length;
        blocks.push(block);
      } catch {
        opts.log?.warn({ file: cf }, 'plan-manager: context file not found');
        blocks.push(`### File: ${cf}\n(File not found)`);
      }
    }
    if (blocks.length > 0) {
      injectedContext = blocks.join('\n\n');
    }
  }

  // 9. Execute the phase
  // Reload the phase from allPhases to get the updated status
  const currentPhase = allPhases.phases.find((p) => p.id === phase.id)!;
  await onProgress(`**${phase.id}**: Executing ${phase.kind} phase...`);
  let result = await executePhase(currentPhase, planContent, allPhases, gatedOpts, injectedContext);

  if (destructiveDetected) {
    result = { status: 'failed', output: result.output, error: `Destructive tool call blocked: ${destructiveReason}` };
  }

  // 9a. Audit fix loop: if audit failed and git is available, attempt fix→re-audit cycles
  const maxFixAttempts = opts.maxAuditFixAttempts ?? 2;
  let fixAttemptsUsed: number | undefined;

  if (result.status === 'audit_failed' && maxFixAttempts > 0) {
    if (!isGitAvailable) {
      await onProgress('Automatic fix loop skipped \u2014 git not available.');
    } else {
      let lastAuditOutput = result.output;
      let lastSeverity = result.verdict.maxSeverity;
      const realWorkspace = safeRealpath(opts.workspaceCwd);
      const fixAddDirs = opts.addDirs.filter((d) => {
        const realD = safeRealpath(d);
        return !(realD === realWorkspace || realD.startsWith(realWorkspace + path.sep));
      });

      for (let attempt = 1; attempt <= maxFixAttempts; attempt++) {
        // Progress message — different wording for first vs subsequent
        if (attempt === 1) {
          await onProgress(
            `**${phase.id}**: Audit found **${lastSeverity}** deviations \u2014 attempting fix (${attempt}/${maxFixAttempts})...`,
          );
        } else {
          await onProgress(
            `**${phase.id}**: Audit still found deviations \u2014 attempting fix (${attempt}/${maxFixAttempts})...`,
          );
        }

        // Compute modified files list (fresh each iteration)
        let modifiedFilesList: string[] = [];
        try {
          const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: opts.projectCwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
          const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: opts.projectCwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
          const combined = [...(tracked ? tracked.split('\n') : []), ...(untracked ? untracked.split('\n') : [])];
          modifiedFilesList = [...new Set(combined)];
        } catch {
          // git error (no commits, corrupt index) — use empty list and continue
        }

        // Build fix prompt with full spec
        const fixPrompt = buildAuditFixPrompt(
          planContent,
          lastAuditOutput,
          currentPhase.contextFiles,
          modifiedFilesList,
          attempt,
          maxFixAttempts,
        );

        // Run fix agent — NO Bash tool (safety boundary for automated loop)
        try {
          await collectRuntimeText(
            opts.runtime,
            fixPrompt,
            opts.model,
            opts.projectCwd,
            ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
            fixAddDirs,
            opts.timeoutMs,
            { requireFinalEvent: true, onEvent: gatedOpts.onEvent, signal: opts.signal, toolCallGate: true },
          );
        } catch (err) {
          opts.log?.warn({ err, phase: phase.id, attempt }, 'plan-manager: audit fix agent failed');
          continue; // Consumed attempt — try again or exit loop
        }

        if (destructiveDetected) break;

        // Re-audit
        await onProgress(`**${phase.id}**: Fix attempt ${attempt} complete. Re-auditing...`);
        result = await executePhase(currentPhase, planContent, allPhases, gatedOpts);

        if (destructiveDetected) {
          result = { status: 'failed', output: result.output, error: `Destructive tool call blocked: ${destructiveReason}` };
          break;
        }

        if (result.status === 'done') {
          fixAttemptsUsed = attempt;
          break;
        } else if (result.status === 'audit_failed') {
          lastAuditOutput = result.output;
          lastSeverity = result.verdict.maxSeverity;
        }
        // result.status === 'failed' (runtime error on re-audit) — consumed attempt, continue
      }

      // Exhausted fix attempts — rollback all uncommitted changes
      if (result.status === 'audit_failed' || result.status === 'failed') {
        fixAttemptsUsed = fixAttemptsUsed ?? maxFixAttempts;
        try {
          execFileSync('git', ['checkout', '.'], { cwd: opts.projectCwd, stdio: 'pipe' });
          execFileSync('git', ['clean', '-fd'], { cwd: opts.projectCwd, stdio: 'pipe' });
          await onProgress('Fix attempts exhausted \u2014 rolled back fix-agent changes.');
        } catch (rollbackErr) {
          await onProgress(
            `Fix attempts exhausted \u2014 rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}. Working tree may contain partial fix-agent changes.`,
          );
        }
        // Normalize: fix loop exhaustion always returns audit_failed, even if
        // the last iteration was a runtime error ('failed') rather than an audit failure.
        if (result.status === 'failed') {
          result = {
            status: 'audit_failed',
            output: lastAuditOutput,
            error: 'Fix loop exhausted after runtime error on re-audit',
            verdict: { maxSeverity: lastSeverity, shouldLoop: true },
          };
        }
      }
    }
  }

  // 10. Capture modified files (skip if either snapshot is unavailable)
  const postSnapshot = preSnapshot ? gitDiffNames(opts.projectCwd) : null;
  const modifiedFiles: string[] = [];
  if (preSnapshot && postSnapshot) {
    for (const file of postSnapshot) {
      if (!preSnapshot.has(file)) {
        modifiedFiles.push(file);
      }
    }
  }

  // Compute failure hashes if failed
  let failureHashes: Record<string, string> | undefined;
  if (result.status === 'failed' && modifiedFiles.length > 0) {
    failureHashes = {};
    for (const file of modifiedFiles) {
      const hash = hashFileContent(path.join(opts.projectCwd, file));
      if (hash) failureHashes[file] = hash;
    }
  }

  // 11. Write done/failed status to disk
  const diskStatus = result.status === 'audit_failed' ? 'failed' : result.status;
  const diskError = result.status === 'done' ? undefined : result.error;
  allPhases = updatePhaseStatus(allPhases, phase.id, diskStatus, result.output, diskError);
  // Attach modifiedFiles and failureHashes to the phase
  allPhases = {
    ...allPhases,
    phases: allPhases.phases.map((p) => {
      if (p.id !== phase.id) return p;
      return {
        ...p,
        modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined,
        failureHashes,
      };
    }),
  };
  writePhasesFile(phasesFilePath, allPhases);

  // 12. Git commit on success
  if (result.status === 'done' && isGitAvailable && modifiedFiles.length > 0) {
    try {
      execFileSync('git', ['add', ...modifiedFiles], { cwd: opts.projectCwd, stdio: 'pipe' });
      const commitMsg = `${allPhases.planId} ${phase.id}: ${phase.title}`;
      execFileSync('git', ['commit', '-m', commitMsg], { cwd: opts.projectCwd, stdio: 'pipe' });

      // Capture commit hash
      const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.projectCwd, encoding: 'utf-8', stdio: 'pipe' }).trim();

      // Update phase with git commit hash
      allPhases = {
        ...allPhases,
        phases: allPhases.phases.map((p) => {
          if (p.id !== phase.id) return p;
          return { ...p, gitCommit: commitHash };
        }),
      };
      writePhasesFile(phasesFilePath, allPhases);
    } catch (err) {
      // Unstage files so the next retry doesn't see stale staged state
      try { execFileSync('git', ['reset'], { cwd: opts.projectCwd, stdio: 'pipe' }); } catch { /* best-effort */ }
      opts.log?.warn({ err, phase: phase.id }, 'plan-manager: git commit failed');
    }
  } else if (result.status === 'done' && isGitAvailable && modifiedFiles.length === 0) {
    opts.log?.warn({ phase: phase.id }, 'plan-manager: phase completed but no files were modified');
  }

  const updatedPhase = allPhases.phases.find((p) => p.id === phase.id)!;

  // Emit phase_complete event
  if (opts.onPlanEvent) {
    const completeStatus = result.status === 'done' ? 'done' : 'failed';
    try {
      await opts.onPlanEvent({
        type: 'phase_complete',
        planId: allPhases.planId,
        phase: {
          id: updatedPhase.id,
          title: updatedPhase.title,
          kind: updatedPhase.kind,
        },
        status: completeStatus,
      });
    } catch (err) {
      opts.log?.warn(
        { err, planId: allPhases.planId, phaseId: phase.id },
        'plan-manager: onPlanEvent phase_complete callback failed',
      );
    }
  }

  if (result.status === 'done') {
    const upcoming = getNextPhase(allPhases);
    const nextPhase = upcoming ? { id: upcoming.id, title: upcoming.title } : undefined;
    return { result: 'done', phase: updatedPhase, output: result.output, nextPhase };
  } else if (result.status === 'audit_failed') {
    return { result: 'audit_failed', phase: updatedPhase, output: result.output, verdict: result.verdict, fixAttemptsUsed };
  } else {
    return { result: 'failed', phase: updatedPhase, output: result.output, error: result.error ?? 'Unknown error' };
  }
}
