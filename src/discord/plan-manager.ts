import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { collectRuntimeText } from './runtime-utils.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from './action-types.js';

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

export type PhaseExecutionOpts = {
  runtime: RuntimeAdapter;
  model: string;
  projectCwd: string;
  addDirs: string[];
  timeoutMs: number;
  workspaceCwd: string;
  log?: LoggerLike;
};

export type RunPhaseResult =
  | { result: 'done'; phase: PlanPhase; output: string }
  | { result: 'failed'; phase: PlanPhase; output: string; error: string }
  | { result: 'stale'; message: string }
  | { result: 'nothing_to_run' }
  | { result: 'corrupt'; message: string }
  | { result: 'retry_blocked'; phase: PlanPhase; message: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: Set<string> = new Set(['pending', 'in-progress', 'done', 'failed', 'skipped']);
const VALID_KINDS: Set<string> = new Set(['implement', 'read', 'audit']);

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
  const paths: string[] = [];
  const seen = new Set<string>();

  // Match ` - `path/to/file` ` patterns (backtick-wrapped in list items)
  const regex = /^[\s]*-\s+`([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(changesSection)) !== null) {
    const candidate = m[1]!;
    if (!isLikelyFilePath(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }

  return paths;
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

export function decomposePlan(planContent: string, planId: string, planFile: string): PlanPhases {
  const hash = computePlanHash(planContent);
  const now = new Date().toISOString().split('T')[0]!;

  // Extract Changes section
  const changesMatch = planContent.match(/## Changes\s*\n([\s\S]*?)(?=\n## (?!#)|$)/);
  const changesSection = changesMatch?.[1] ?? '';

  // Extract file paths
  const filePaths = extractFilePaths(changesSection);

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
  } else {
    // Group files into batches
    const groups = groupFiles(filePaths, 5);
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
      message: 'Plan file has changed since phases were generated. Run `!plan phases --regenerate <plan-id>` to update.',
    };
  }
  return { stale: false, message: '' };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildPhasePrompt(
  phase: PlanPhase,
  planContent: string,
  injectedContext?: string,
): string {
  const lines: string[] = [];

  // Extract objective
  const objMatch = planContent.match(/## Objective\s*\n([\s\S]*?)(?=\n## )/);
  const objective = objMatch?.[1]?.trim() ?? '(no objective found in plan)';

  lines.push('## Objective');
  lines.push('');
  lines.push(objective);
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
    lines.push('Compare the implementation against the plan specification. Report any deviations, missing pieces, or concerns.');
    lines.push('Use Read, Glob, and Grep tools only.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project directory resolution
// ---------------------------------------------------------------------------

export function resolveProjectCwd(
  planContent: string,
  workspaceCwd: string,
): string {
  const projectMatch = planContent.match(/^\*\*Project:\*\*\s*(.+)$/m);
  if (!projectMatch) {
    throw new Error('Plan has no **Project:** field. Cannot determine source directory.');
  }

  const projectName = projectMatch[1]!.trim();
  const projectDir = PROJECT_DIRS[projectName];

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
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Project directory does not exist: ${projectDir}`);
    }
    throw err;
  }

  // Symlink validation: scan top-level entries for symlinks pointing to workspaceCwd
  const realWorkspaceCwd = fsSync.realpathSync(workspaceCwd);
  const entries = fsSync.readdirSync(projectDir);

  for (const entry of entries) {
    const entryPath = path.join(projectDir, entry);
    const lstat = fsSync.lstatSync(entryPath);
    if (lstat.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = fsSync.realpathSync(entryPath);
      } catch {
        continue; // Broken symlink — skip
      }
      if (realTarget === realWorkspaceCwd || realTarget.startsWith(realWorkspaceCwd + path.sep)) {
        throw new Error(
          `Project directory contains a symlink to the workspace data directory (${entry} → ${realTarget}). ` +
          'Implement phases cannot safely operate in this layout — remove the symlink or use a project directory without it.',
        );
      }
    }
  }

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
    return resolved;
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
  const content = serializePhases(phases);
  const tmpPath = filePath + '.tmp';
  fsSync.writeFileSync(tmpPath, content, 'utf-8');
  fsSync.renameSync(tmpPath, filePath);
}

export async function executePhase(
  phase: PlanPhase,
  planContent: string,
  phases: PlanPhases,
  opts: PhaseExecutionOpts,
  injectedContext?: string,
): Promise<{ status: 'done' | 'failed'; output: string; error?: string }> {
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
      { requireFinalEvent: true },
    );
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

function gitDiffNames(cwd: string): Set<string> {
  const result = new Set<string>();
  try {
    const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    for (const line of [...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]) {
      if (line.trim()) result.add(line.trim());
    }
  } catch {
    // Best-effort
  }
  return result;
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
  // 1. Read and deserialize phases file
  let allPhases: PlanPhases;
  try {
    const content = fsSync.readFileSync(phasesFilePath, 'utf-8');
    allPhases = deserializePhases(content);
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

  if (phase.status === 'failed') {
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

  // 5. Write in-progress status to disk
  await onProgress(`Running ${phase.id}: ${phase.title}...`);
  allPhases = updatePhaseStatus(allPhases, phase.id, 'in-progress');
  writePhasesFile(phasesFilePath, allPhases);

  // 6. Git snapshot
  const preSnapshot = isGitAvailable ? gitDiffNames(opts.projectCwd) : new Set<string>();

  // 7. Auto-revert on retry
  if (phase.status === 'failed' && phase.modifiedFiles && phase.failureHashes && isGitAvailable) {
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
  let injectedContext: string | undefined;
  if (phase.kind === 'implement') {
    const blocks: string[] = [];
    for (const cf of phase.contextFiles) {
      if (!cf.startsWith('workspace/')) continue;
      const stripped = cf.slice('workspace/'.length);
      const absPath = path.resolve(opts.workspaceCwd, stripped);
      try {
        const content = fsSync.readFileSync(absPath, 'utf-8');
        blocks.push(`### File: ${cf}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
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
  const result = await executePhase(currentPhase, planContent, allPhases, opts, injectedContext);

  // 10. Capture modified files
  const postSnapshot = isGitAvailable ? gitDiffNames(opts.projectCwd) : new Set<string>();
  const modifiedFiles: string[] = [];
  for (const file of postSnapshot) {
    if (!preSnapshot.has(file)) {
      modifiedFiles.push(file);
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
  allPhases = updatePhaseStatus(allPhases, phase.id, result.status, result.output, result.error);
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
      opts.log?.warn({ err, phase: phase.id }, 'plan-manager: git commit failed');
    }
  } else if (result.status === 'done' && isGitAvailable && modifiedFiles.length === 0) {
    opts.log?.warn({ phase: phase.id }, 'plan-manager: phase completed but no files were modified');
  }

  const updatedPhase = allPhases.phases.find((p) => p.id === phase.id)!;

  if (result.status === 'done') {
    return { result: 'done', phase: updatedPhase, output: result.output };
  } else {
    return { result: 'failed', phase: updatedPhase, output: result.output, error: result.error ?? 'Unknown error' };
  }
}
