import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

type Severity = 'P1' | 'P2' | 'P3';

type Finding = {
  severity: Severity;
  section: string;
  file: string;
  line?: number;
  rule: string;
  details: string;
};

type SectionDef = {
  name: string;
  matches: (file: string) => boolean;
};

type FileInfo = {
  file: string;
  section: string;
  lines: number;
  isTest: boolean;
  isCode: boolean;
  isSourceTs: boolean;
};

type ReviewSummary = {
  timestampUtc: string;
  commit: string;
  filters: {
    sections: string[];
    includeTests: boolean;
    withGates: boolean;
  };
  fileCount: number;
  sectionCoverage: Array<{ section: string; files: number; findings: number }>;
  findings: Finding[];
  gateResults?: {
    build?: 'PASS' | 'FAIL';
    test?: 'PASS' | 'FAIL';
    legacyGuard?: 'PASS' | 'FAIL';
    preflight?: 'PASS' | 'FAIL';
  };
};

const LONG_FILE_THRESHOLD = 1300;
const MISSING_TEST_THRESHOLD = 350;
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.mp4', '.mov', '.wav', '.lock',
]);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);
const ROOT_TEXT_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'README.md',
  'MIGRATION.md',
  '.env.example',
  '.env.example.full',
]);

const sections: SectionDef[] = [
  { name: 'discord', matches: (f) => f.startsWith('src/discord/') || f === 'src/discord.ts' },
  { name: 'tasks', matches: (f) => f.startsWith('src/tasks/') },
  { name: 'runtime-pipeline', matches: (f) => f.startsWith('src/runtime/') || f.startsWith('src/pipeline/') },
  { name: 'cron', matches: (f) => f.startsWith('src/cron/') },
  {
    name: 'platform-adapters',
    matches: (f) =>
      f.startsWith('src/cli/') ||
      f.startsWith('src/webhook/') ||
      f.startsWith('src/transport/') ||
      f.startsWith('src/onboarding/') ||
      f.startsWith('src/health/') ||
      f.startsWith('src/observability/'),
  },
  {
    name: 'core-src',
    matches: (f) =>
      f.startsWith('src/') &&
      !f.startsWith('src/discord/') &&
      !f.startsWith('src/tasks/') &&
      !f.startsWith('src/runtime/') &&
      !f.startsWith('src/pipeline/') &&
      !f.startsWith('src/cron/') &&
      !f.startsWith('src/cli/') &&
      !f.startsWith('src/webhook/') &&
      !f.startsWith('src/transport/') &&
      !f.startsWith('src/onboarding/') &&
      !f.startsWith('src/health/') &&
      !f.startsWith('src/observability/') &&
      f !== 'src/discord.ts',
  },
  { name: 'automation-scripts', matches: (f) => f.startsWith('scripts/') },
  { name: 'ci-workflows', matches: (f) => f.startsWith('.github/workflows/') },
  { name: 'docs', matches: (f) => f.startsWith('docs/') },
  { name: 'root-config', matches: (f) => ROOT_TEXT_FILES.has(f) },
  { name: 'other-tracked', matches: (_f) => true },
];

type CliOptions = {
  selectedSections: Set<string> | null;
  includeTests: boolean;
  withGates: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  let selectedSections: Set<string> | null = null;
  let includeTests = false;
  let withGates = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--section' || arg === '-s') {
      const raw = argv[i + 1] ?? '';
      i += 1;
      const names = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      selectedSections = new Set(names);
    } else if (arg === '--include-tests') {
      includeTests = true;
    } else if (arg === '--with-gates') {
      withGates = true;
    }
  }

  return { selectedSections, includeTests, withGates };
}

function runCmd(cmd: string, args: string[]): 'PASS' | 'FAIL' {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return 'PASS';
  } catch {
    return 'FAIL';
  }
}

function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !shouldSkip(file));
}

function shouldSkip(file: string): boolean {
  if (file.startsWith('dist/') || file.startsWith('node_modules/')) return true;
  if (file === 'pnpm-lock.yaml') return true;
  const ext = extname(file).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

function sectionFor(file: string): string {
  const hit = sections.find((s) => s.matches(file));
  return hit ? hit.name : 'other-tracked';
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.has(extname(file).toLowerCase());
}

function isTestFile(file: string): boolean {
  return file.includes('.test.') || file.includes('/__tests__/') || file.includes('.integration.test.');
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

function findLines(content: string, re: RegExp): number[] {
  const lines = content.split('\n');
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    re.lastIndex = 0;
    if (re.test(lines[i])) out.push(i + 1);
  }
  return out;
}

function hasNearbyTest(file: string): boolean {
  if (!file.endsWith('.ts')) return true;
  const direct = file.replace(/\.ts$/, '.test.ts');
  if (existsSync(direct)) return true;

  const folder = dirname(file);
  const stem = basename(file, '.ts');
  try {
    const names = readdirSync(folder);
    return names.some((name) => name.startsWith(`${stem}.`) && name.includes('.test.'));
  } catch {
    return false;
  }
}

function shouldAnalyzeFile(info: FileInfo, includeTests: boolean): boolean {
  if (!info.isCode) return false;
  if (!includeTests && info.isTest) return false;
  return true;
}

function collectFindings(files: FileInfo[], includeTests: boolean): Finding[] {
  const grouped = new Map<
    string,
    {
      severity: Severity;
      section: string;
      file: string;
      rule: string;
      details: string;
      lines: number[];
    }
  >();

  function addFinding(entry: Omit<Finding, 'line'> & { line?: number }): void {
    const key = [entry.severity, entry.section, entry.file, entry.rule, entry.details].join('|');
    const existing = grouped.get(key);
    if (existing) {
      if (typeof entry.line === 'number') existing.lines.push(entry.line);
      return;
    }
    grouped.set(key, {
      severity: entry.severity,
      section: entry.section,
      file: entry.file,
      rule: entry.rule,
      details: entry.details,
      lines: typeof entry.line === 'number' ? [entry.line] : [],
    });
  }

  for (const info of files) {
    if (!shouldAnalyzeFile(info, includeTests)) continue;
    const content = readText(info.file);
    if (!content) continue;

    const isProdTs = info.isSourceTs && !info.isTest;

    if (isProdTs && info.lines >= LONG_FILE_THRESHOLD) {
      addFinding({
        severity: 'P2',
        section: info.section,
        file: info.file,
        line: 1,
        rule: 'LONG_FILE',
        details: `File has ${info.lines} lines; review complexity/splitting risk.`,
      });
    }

    const todoLines = findLines(content, /\b(TODO|FIXME|HACK|XXX)\b/);
    for (const line of todoLines) {
      addFinding({
        severity: isProdTs ? 'P2' : 'P3',
        section: info.section,
        file: info.file,
        line,
        rule: 'TODO_MARKER',
        details: 'Unresolved marker; confirm whether this is intentionally deferred.',
      });
    }

    if (isProdTs) {
      const anyLines = findLines(content, /(:\s*any\b|\bas any\b|<any>)/);
      for (const line of anyLines) {
        addFinding({
          severity: 'P2',
          section: info.section,
          file: info.file,
          line,
          rule: 'UNTYPED_ANY',
          details: 'Weak type boundary; verify narrowing and runtime guards.',
        });
      }

      const emptyCatchLines = findLines(content, /^\s*catch\s*\{\s*\}\s*$/);
      for (const line of emptyCatchLines) {
        addFinding({
          severity: 'P2',
          section: info.section,
          file: info.file,
          line,
          rule: 'EMPTY_CATCH',
          details: 'Empty catch can hide failures; verify this is deliberate.',
        });
      }

      const riskyExecaLines = findLines(content, /\bexeca(?:Command|CommandSync)?\s*\(\s*`/);
      for (const line of riskyExecaLines) {
        addFinding({
          severity: 'P1',
          section: info.section,
          file: info.file,
          line,
          rule: 'EXECA_TEMPLATE_STRING',
          details: 'Template-string command invocation can increase injection risk; prefer argument arrays.',
        });
      }

      const shellTrueLines = findLines(content, /\bshell\s*:\s*true\b/);
      for (const line of shellTrueLines) {
        addFinding({
          severity: 'P2',
          section: info.section,
          file: info.file,
          line,
          rule: 'SHELL_TRUE',
          details: 'Shell-enabled subprocess usage should be justified and safely parameterized.',
        });
      }

      if (info.lines >= MISSING_TEST_THRESHOLD && !hasNearbyTest(info.file)) {
        addFinding({
          severity: 'P3',
          section: info.section,
          file: info.file,
          line: 1,
          rule: 'NO_NEARBY_TEST',
          details: `No nearby test file detected for a ${info.lines}-line source file.`,
        });
      }
    }
  }

  const findings: Finding[] = [...grouped.values()].map((entry) => {
    const sortedLines = [...entry.lines].sort((a, b) => a - b);
    const uniqueLines = sortedLines.filter((line, i) => i === 0 || sortedLines[i - 1] !== line);
    const lineSummary =
      uniqueLines.length === 0
        ? ''
        : ` (hits=${uniqueLines.length}; lines=${uniqueLines.slice(0, 8).join(', ')}${uniqueLines.length > 8 ? ', ...' : ''})`;
    return {
      severity: entry.severity,
      section: entry.section,
      file: entry.file,
      line: uniqueLines[0],
      rule: entry.rule,
      details: `${entry.details}${lineSummary}`,
    };
  });

  const sevOrder: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };
  findings.sort((a, b) => {
    const d = sevOrder[a.severity] - sevOrder[b.severity];
    if (d !== 0) return d;
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return findings;
}

function renderMarkdown(summary: ReviewSummary): string {
  const lines: string[] = [];
  lines.push('# Automated Section Code Review');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${summary.timestampUtc}`);
  lines.push(`- Commit: ${summary.commit}`);
  lines.push(`- Files reviewed: ${summary.fileCount}`);
  lines.push(`- Section filter: ${summary.filters.sections.length > 0 ? summary.filters.sections.join(', ') : 'all'}`);
  lines.push(`- Include tests in heuristics: ${summary.filters.includeTests ? 'yes' : 'no'}`);
  lines.push('');

  if (summary.gateResults) {
    lines.push('## Gate Results');
    lines.push('');
    lines.push(`- build: ${summary.gateResults.build}`);
    lines.push(`- test: ${summary.gateResults.test}`);
    lines.push(`- guard:legacy: ${summary.gateResults.legacyGuard}`);
    lines.push(`- preflight: ${summary.gateResults.preflight}`);
    lines.push('');
  }

  lines.push('## Section Coverage');
  lines.push('');
  lines.push('| Section | Files | Findings |');
  lines.push('| --- | ---: | ---: |');
  for (const row of summary.sectionCoverage) {
    lines.push(`| ${row.section} | ${row.files} | ${row.findings} |`);
  }
  lines.push('');

  lines.push('## Findings (Severity Ordered)');
  lines.push('');
  if (summary.findings.length === 0) {
    lines.push('- None.');
  } else {
    for (const finding of summary.findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- [${finding.severity}] ${finding.rule} - \`${location}\` - ${finding.details}`);
    }
  }
  lines.push('');

  lines.push('## Residual Risk');
  lines.push('');
  lines.push('- Heuristic scans identify risk signals, not proofs of correctness.');
  lines.push('- Follow-up manual review is required for P1/P2 findings.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const timestampUtc = new Date().toISOString();
  const day = timestampUtc.slice(0, 10);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

  const selected = opts.selectedSections;
  const allTracked = listTrackedFiles();
  const fileInfos: FileInfo[] = allTracked
    .map((file) => {
      const section = sectionFor(file);
      const content = readText(file);
      return {
        file,
        section,
        lines: lineCount(content),
        isTest: isTestFile(file),
        isCode: isCodeFile(file),
        isSourceTs: file.endsWith('.ts'),
      };
    })
    .filter((item) => !selected || selected.has(item.section));

  const findings = collectFindings(fileInfos, opts.includeTests);

  const sectionCoverage = sections
    .map((s) => s.name)
    .filter((name) => !selected || selected.has(name))
    .map((name) => {
      const files = fileInfos.filter((f) => f.section === name).length;
      const findingsCount = findings.filter((f) => f.section === name).length;
      return { section: name, files, findings: findingsCount };
    })
    .filter((row) => row.files > 0 || row.findings > 0);

  const gateResults = opts.withGates
    ? {
        build: runCmd('pnpm', ['build']),
        test: runCmd('pnpm', ['test']),
        legacyGuard: runCmd('pnpm', ['guard:legacy']),
        preflight: runCmd('pnpm', ['preflight']),
      }
    : undefined;

  const summary: ReviewSummary = {
    timestampUtc,
    commit,
    filters: {
      sections: selected ? [...selected] : [],
      includeTests: opts.includeTests,
      withGates: opts.withGates,
    },
    fileCount: fileInfos.length,
    sectionCoverage,
    findings,
    gateResults,
  };

  const outDir = 'docs/code-review';
  mkdirSync(outDir, { recursive: true });

  const suffix = selected && selected.size > 0 ? `-${[...selected].sort().join('_')}` : '';
  const base = `${outDir}/section-review-${day}${suffix}`;

  const md = renderMarkdown(summary);
  writeFileSync(`${base}.md`, md, 'utf8');
  writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const p1 = findings.filter((f) => f.severity === 'P1').length;
  const p2 = findings.filter((f) => f.severity === 'P2').length;
  const p3 = findings.filter((f) => f.severity === 'P3').length;
  console.log(`review: wrote ${base}.md`);
  console.log(`review: wrote ${base}.json`);
  console.log(`review: files=${fileInfos.length} findings=${findings.length} (P1=${p1}, P2=${p2}, P3=${p3})`);
  if (gateResults) {
    console.log(
      `review: gates build=${gateResults.build} test=${gateResults.test} guard:legacy=${gateResults.legacyGuard} preflight=${gateResults.preflight}`,
    );
  }
}

main();
