import fs from 'node:fs/promises';
import path from 'node:path';

export type GuardRule = {
  id: string;
  pattern: RegExp;
  message: string;
  allowIn: string[];
};

export type GuardMatch = {
  ruleId: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
  message: string;
};

export type GuardReport = {
  scannedFiles: number;
  matches: GuardMatch[];
};

const TARGET_ROOTS = ['src', 'scripts'] as const;
const TARGET_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs']);
const TEST_FILE_RE = /\.test\.[cm]?[jt]s$/;
const EXCLUDED_FILES = new Set(['scripts/legacy-token-guard.ts']);

export const DEFAULT_LEGACY_GUARD_RULES: GuardRule[] = [
  {
    id: 'legacy-env-beads',
    pattern: /DISCOCLAW_BEADS_[A-Z0-9_]+/g,
    message: 'Use DISCOCLAW_TASKS_* environment names.',
    allowIn: [],
  },
  {
    id: 'legacy-action-module',
    pattern: /actions-beads(?:\.js)?/g,
    message: 'Use actions-tasks module names.',
    allowIn: [],
  },
  {
    id: 'legacy-bead-context',
    pattern: /\bbeadCtx\b/g,
    message: 'Use taskCtx naming.',
    allowIn: [],
  },
  {
    id: 'legacy-beads-flag',
    pattern: /\bflags\.beads\b/g,
    message: 'Use flags.tasks naming.',
    allowIn: [],
  },
  {
    id: 'legacy-bootstrap-keys',
    pattern: /\b(?:bootstrapEnsureBeadsForum|existingBeadsId|beadsForumId|systemBeadsForumId)\b/g,
    message: 'Use task-named scaffold keys.',
    allowIn: [],
  },
  {
    id: 'legacy-beads-cwd',
    pattern: /\bbeadsCwd\b/g,
    message: 'Use tasksCwd naming.',
    allowIn: [],
  },
  {
    id: 'legacy-beads-import-path',
    pattern: /\bfrom\s+['"][^'"]*\/beads\/[^'"]*['"]/g,
    message: 'Import canonical task modules; src/beads import paths are retired.',
    allowIn: [],
  },
  {
    id: 'legacy-beads-script-path',
    pattern: /scripts\/beads\//g,
    message: 'Use canonical scripts/tasks paths in runtime code.',
    allowIn: [],
  },
  {
    id: 'legacy-beads-db-path',
    pattern: /\.beads\/beads\.db/g,
    message: 'Legacy bd DB paths are retired from runtime/preflight code.',
    allowIn: ['src/tasks/bd-cli.ts'],
  },
];

DEFAULT_LEGACY_GUARD_RULES.push(
  {
    id: 'legacy-plan-header-bead',
    pattern: /\*\*Bead:\*\*/g,
    message: 'Use **Task:** plan headers.',
    allowIn: [],
  },
  {
    id: 'legacy-plan-template-bead-id',
    pattern: /\{\{BEAD_ID\}\}/g,
    message: 'Use {{TASK_ID}} in templates.',
    allowIn: [],
  },
);

function normalizeRelPath(p: string): string {
  return p.split(path.sep).join('/');
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  // Simple glob support for allowlists: ** and *.
  const normalized = normalizeRelPath(glob);
  const sentinel = '__DOUBLE_STAR__';
  const withSentinel = normalized.replace(/\*\*/g, sentinel);
  const escaped = escapeRegex(withSentinel)
    .replace(new RegExp(sentinel, 'g'), '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function isRuleAllowedForFile(file: string, allowGlobs: readonly string[]): boolean {
  if (allowGlobs.length === 0) return false;
  return allowGlobs.some((glob) => globToRegExp(glob).test(file));
}

function cloneRegexWithGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function isTargetFile(relFile: string): boolean {
  const normalized = normalizeRelPath(relFile);
  if (EXCLUDED_FILES.has(normalized)) return false;
  if (TEST_FILE_RE.test(normalized)) return false;
  if (!TARGET_ROOTS.some((root) => normalized.startsWith(`${root}/`))) return false;
  return TARGET_EXTS.has(path.extname(normalized));
}

async function walkDir(rootDir: string, relDir: string, out: string[]): Promise<void> {
  const absDir = path.join(rootDir, relDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      await walkDir(rootDir, relPath, out);
      continue;
    }
    if (entry.isFile() && isTargetFile(relPath)) {
      out.push(normalizeRelPath(relPath));
    }
  }
}

export async function collectGuardTargetFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of TARGET_ROOTS) {
    await walkDir(rootDir, root, files);
  }
  return files.sort();
}

export function scanFileContent(file: string, content: string, rules: readonly GuardRule[]): GuardMatch[] {
  const lines = content.split('\n');
  const matches: GuardMatch[] = [];

  for (const rule of rules) {
    if (isRuleAllowedForFile(file, rule.allowIn)) continue;
    const matcher = cloneRegexWithGlobal(rule.pattern);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? '';
      matcher.lastIndex = 0;
      let m: RegExpExecArray | null = matcher.exec(line);
      while (m) {
        matches.push({
          ruleId: rule.id,
          file,
          line: lineIndex + 1,
          column: m.index + 1,
          snippet: line.trim(),
          message: rule.message,
        });
        m = matcher.exec(line);
      }
    }
  }

  return matches;
}

export async function runLegacyTokenGuard(opts?: {
  rootDir?: string;
  files?: string[];
  rules?: GuardRule[];
}): Promise<GuardReport> {
  const rootDir = opts?.rootDir ?? process.cwd();
  const rules = opts?.rules ?? DEFAULT_LEGACY_GUARD_RULES;
  const files = (opts?.files ?? (await collectGuardTargetFiles(rootDir))).map(normalizeRelPath);
  const matches: GuardMatch[] = [];

  for (const relFile of files) {
    const absFile = path.join(rootDir, relFile);
    const content = await fs.readFile(absFile, 'utf8');
    matches.push(...scanFileContent(relFile, content, rules));
  }

  return { scannedFiles: files.length, matches };
}

function printReport(report: GuardReport): void {
  if (report.matches.length === 0) {
    console.log(`legacy-token-guard: ok (${report.scannedFiles} files scanned)`);
    return;
  }

  console.error(`legacy-token-guard: found ${report.matches.length} violation(s)`);
  for (const match of report.matches) {
    console.error(
      `${match.file}:${match.line}:${match.column} [${match.ruleId}] ${match.message}\n` +
      `  ${match.snippet}`,
    );
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const report = await runLegacyTokenGuard();
  printReport(report);
  if (report.matches.length > 0) process.exit(1);
}
