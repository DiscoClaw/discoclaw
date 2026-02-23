import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Finding = {
  section: string;
  file: string;
  rule: string;
  details: string;
};

type ReviewSummary = {
  timestampUtc: string;
  commit: string;
  findings: Finding[];
};

type Chunk = {
  id: string;
  section: string;
  file: string;
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
  status: 'pending';
  checklist: string[];
};

type CliOptions = {
  sourcePath: string;
  chunkSize: number;
};

function parseArgs(argv: string[]): CliOptions {
  const day = new Date().toISOString().slice(0, 10);
  let sourcePath = `docs/code-review/section-review-${day}.json`;
  let chunkSize = 250;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      sourcePath = argv[i + 1] ?? sourcePath;
      i += 1;
      continue;
    }
    if (arg === '--chunk-size') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        chunkSize = parsed;
      }
      i += 1;
    }
  }

  return { sourcePath, chunkSize };
}

function readSummary(sourcePath: string): ReviewSummary {
  if (!existsSync(sourcePath)) {
    throw new Error(`review source not found: ${sourcePath}`);
  }
  const raw = readFileSync(sourcePath, 'utf8');
  return JSON.parse(raw) as ReviewSummary;
}

function lineCount(file: string): number {
  const content = readFileSync(file, 'utf8');
  return content.length === 0 ? 0 : content.split('\n').length;
}

function buildChunks(file: string, section: string, totalLines: number, chunkSize: number): Chunk[] {
  const chunks: Chunk[] = [];
  const chunkCount = Math.max(1, Math.ceil(totalLines / chunkSize));
  for (let index = 0; index < chunkCount; index += 1) {
    const startLine = index * chunkSize + 1;
    const endLine = Math.min(totalLines, (index + 1) * chunkSize);
    chunks.push({
      id: `${section}:${file}:${index + 1}`,
      section,
      file,
      chunkIndex: index + 1,
      chunkCount,
      startLine,
      endLine,
      status: 'pending',
      checklist: [
        'Validate control-flow branches and guard conditions.',
        'Review error handling paths and fail-open/fail-closed behavior.',
        'Check side effects (I/O, Discord/API calls, subprocesses) for safety and retries.',
        'Identify missing or weak tests for the chunk-specific behavior.',
      ],
    });
  }
  return chunks;
}

function renderMarkdown(
  sourcePath: string,
  chunkSize: number,
  summary: ReviewSummary,
  chunks: Chunk[],
): string {
  const lines: string[] = [];
  lines.push('# Long File Chunk Audit Plan');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${new Date().toISOString()}`);
  lines.push(`- Source review: ${sourcePath}`);
  lines.push(`- Source review timestamp (UTC): ${summary.timestampUtc}`);
  lines.push(`- Commit: ${summary.commit}`);
  lines.push(`- Chunk size: ${chunkSize}`);
  lines.push(`- Total chunks: ${chunks.length}`);
  lines.push('');
  lines.push('## Chunk Checklist');
  lines.push('');
  for (const chunk of chunks) {
    lines.push(
      `- [ ] ${chunk.section} | \`${chunk.file}\` | chunk ${chunk.chunkIndex}/${chunk.chunkCount} | lines ${chunk.startLine}-${chunk.endLine}`,
    );
  }
  lines.push('');
  lines.push('## Standard Review Focus');
  lines.push('');
  lines.push('- Control flow and guard correctness.');
  lines.push('- Error propagation, retries, and observability.');
  lines.push('- Side-effect safety (I/O, network, subprocess, Discord mutations).');
  lines.push('- Missing tests or weak assertions around changed behavior.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const summary = readSummary(opts.sourcePath);

  const longFileTargets = new Map<string, { file: string; section: string }>();
  for (const finding of summary.findings) {
    if (finding.rule !== 'LONG_FILE') continue;
    longFileTargets.set(finding.file, { file: finding.file, section: finding.section });
  }

  const allChunks: Chunk[] = [];
  for (const target of longFileTargets.values()) {
    const totalLines = lineCount(target.file);
    const chunks = buildChunks(target.file, target.section, totalLines, opts.chunkSize);
    allChunks.push(...chunks);
  }

  allChunks.sort((a, b) => {
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.chunkIndex - b.chunkIndex;
  });

  const outDir = 'docs/code-review';
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const basePath = `${outDir}/long-file-chunks-${day}`;

  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const payload = {
    generatedAtUtc: new Date().toISOString(),
    commit,
    sourcePath: opts.sourcePath,
    sourceSummaryTimestampUtc: summary.timestampUtc,
    chunkSize: opts.chunkSize,
    chunkCount: allChunks.length,
    chunks: allChunks,
  };

  writeFileSync(`${basePath}.json`, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(`${basePath}.md`, renderMarkdown(opts.sourcePath, opts.chunkSize, summary, allChunks), 'utf8');

  console.log(`review: wrote ${basePath}.md`);
  console.log(`review: wrote ${basePath}.json`);
  console.log(`review: long-file targets=${longFileTargets.size} chunks=${allChunks.length}`);
}

main();
