import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Chunk = {
  id: string;
  section: string;
  file: string;
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
};

type ChunkManifest = {
  sourcePath: string;
  chunkSize: number;
  chunks: Chunk[];
};

type RiskFinding = {
  severity: 'P1' | 'P2' | 'P3';
  rule: string;
  description: string;
  chunkId: string;
  section: string;
  file: string;
  line: number;
  snippet: string;
};

type RiskScan = {
  generatedAtUtc: string;
  manifestPath: string;
  findings: RiskFinding[];
};

type ChunkAuditStatus = 'passed' | 'follow_up';

type ChunkAuditEntry = {
  id: string;
  file: string;
  section: string;
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
  status: ChunkAuditStatus;
  findings: RiskFinding[];
};

type CliOptions = {
  manifestPath: string;
  risksPath: string;
};

function parseArgs(argv: string[]): CliOptions {
  const day = new Date().toISOString().slice(0, 10);
  let manifestPath = `docs/code-review/long-file-chunks-${day}.json`;
  let risksPath = `docs/code-review/long-file-chunk-risks-${day}.json`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') {
      manifestPath = argv[i + 1] ?? manifestPath;
      i += 1;
      continue;
    }
    if (arg === '--risks') {
      risksPath = argv[i + 1] ?? risksPath;
      i += 1;
    }
  }
  return { manifestPath, risksPath };
}

function readJsonFile<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function findFindingsForChunk(
  chunkId: string,
  allFindings: RiskFinding[],
): RiskFinding[] {
  return allFindings
    .filter((finding) => finding.chunkId === chunkId)
    .sort((a, b) => a.line - b.line);
}

function buildAuditEntries(manifest: ChunkManifest, scan: RiskScan): ChunkAuditEntry[] {
  return manifest.chunks.map((chunk) => {
    const findings = findFindingsForChunk(chunk.id, scan.findings);
    return {
      id: chunk.id,
      file: chunk.file,
      section: chunk.section,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      status: findings.length === 0 ? 'passed' : 'follow_up',
      findings,
    };
  });
}

function renderMarkdown(
  manifestPath: string,
  risksPath: string,
  entries: ChunkAuditEntry[],
): string {
  const lines: string[] = [];
  const passed = entries.filter((entry) => entry.status === 'passed').length;
  const followUp = entries.filter((entry) => entry.status === 'follow_up').length;

  lines.push('# Long File Chunk Audit Result');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${new Date().toISOString()}`);
  lines.push(`- Manifest: ${manifestPath}`);
  lines.push(`- Risk scan: ${risksPath}`);
  lines.push(`- Chunks audited: ${entries.length}`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Follow-up required: ${followUp}`);
  lines.push('');
  lines.push('## Chunk Status');
  lines.push('');

  for (const entry of entries) {
    const mark = entry.status === 'passed' ? 'x' : ' ';
    const suffix = entry.findings.length > 0
      ? ` | findings=${entry.findings.length}`
      : '';
    lines.push(
      `- [${mark}] ${entry.section} | \`${entry.file}\` | chunk ${entry.chunkIndex}/${entry.chunkCount} | lines ${entry.startLine}-${entry.endLine}${suffix}`,
    );
  }

  lines.push('');
  lines.push('## Follow-up Findings');
  lines.push('');
  if (followUp === 0) {
    lines.push('- None.');
  } else {
    for (const entry of entries.filter((value) => value.status === 'follow_up')) {
      for (const finding of entry.findings) {
        lines.push(
          `- [${finding.severity}] \`${finding.file}:${finding.line}\` (${entry.id}) ${finding.rule}: ${finding.description}`,
        );
      }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readJsonFile<ChunkManifest>(opts.manifestPath);
  const scan = readJsonFile<RiskScan>(opts.risksPath);
  const entries = buildAuditEntries(manifest, scan);

  const day = new Date().toISOString().slice(0, 10);
  const outDir = 'docs/code-review';
  mkdirSync(outDir, { recursive: true });
  const basePath = `${outDir}/long-file-chunk-audit-${day}`;

  const payload = {
    generatedAtUtc: new Date().toISOString(),
    manifestPath: opts.manifestPath,
    risksPath: opts.risksPath,
    chunksAudited: entries.length,
    passed: entries.filter((entry) => entry.status === 'passed').length,
    followUp: entries.filter((entry) => entry.status === 'follow_up').length,
    entries,
  };

  writeFileSync(`${basePath}.json`, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(`${basePath}.md`, renderMarkdown(opts.manifestPath, opts.risksPath, entries), 'utf8');

  console.log(`review: wrote ${basePath}.md`);
  console.log(`review: wrote ${basePath}.json`);
  console.log(`review: chunk-audit chunks=${entries.length} passed=${payload.passed} followUp=${payload.followUp}`);
}

main();
