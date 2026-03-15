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

type RiskSeverity = 'P1' | 'P2' | 'P3';

type Rule = {
  id: string;
  severity: RiskSeverity;
  description: string;
  test: (line: string) => boolean;
};

type RiskFinding = {
  severity: RiskSeverity;
  rule: string;
  description: string;
  chunkId: string;
  section: string;
  file: string;
  line: number;
  snippet: string;
};

type CliOptions = {
  manifestPath: string;
};

function parseArgs(argv: string[]): CliOptions {
  const day = new Date().toISOString().slice(0, 10);
  let manifestPath = `docs/code-review/long-file-chunks-${day}.json`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') {
      manifestPath = argv[i + 1] ?? manifestPath;
      i += 1;
    }
  }
  return { manifestPath };
}

function readManifest(manifestPath: string): ChunkManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`chunk manifest not found: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as ChunkManifest;
}

function fileLines(file: string): string[] {
  const raw = readFileSync(file, 'utf8');
  return raw.split('\n');
}

const RULES: Rule[] = [
  {
    id: 'SILENT_CATCH',
    severity: 'P2',
    description: 'Empty or comment-only catch block can hide runtime failures.',
    test: (line) => /\bcatch\s*\{\s*\}\s*$/.test(line),
  },
  {
    id: 'DOUBLE_CAST',
    severity: 'P2',
    description: 'Double-cast (as unknown as) can bypass type safety.',
    test: (line) => /\bas unknown as\b/.test(line),
  },
  {
    id: 'NON_NULL_ASSERT',
    severity: 'P2',
    description: 'Non-null assertion may throw at runtime if invariant breaks.',
    test: (line) => /\w+!\./.test(line) || /\w+!\)/.test(line),
  },
  {
    id: 'TYPE_ANY_ALIAS',
    severity: 'P2',
    description: 'type alias to any weakens type boundaries.',
    test: (line) => /^\s*type\s+[A-Za-z0-9_]+\s*=\s*any\b/.test(line),
  },
  {
    id: 'ENV_DIRECT_ACCESS',
    severity: 'P3',
    description: 'Direct process.env access can drift from centralized config.',
    test: (line) => /\bprocess\.env\.[A-Z0-9_]+\b/.test(line),
  },
];

function scanChunk(chunk: Chunk, lines: string[]): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (let lineNo = chunk.startLine; lineNo <= chunk.endLine; lineNo += 1) {
    const line = lines[lineNo - 1] ?? '';
    for (const rule of RULES) {
      if (!rule.test(line)) continue;
      findings.push({
        severity: rule.severity,
        rule: rule.id,
        description: rule.description,
        chunkId: chunk.id,
        section: chunk.section,
        file: chunk.file,
        line: lineNo,
        snippet: line.trim().slice(0, 180),
      });
    }
  }
  return findings;
}

function renderMarkdown(
  manifestPath: string,
  findings: RiskFinding[],
): string {
  const lines: string[] = [];
  lines.push('# Long File Chunk Risk Scan');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${new Date().toISOString()}`);
  lines.push(`- Chunk manifest: ${manifestPath}`);
  lines.push(`- Findings: ${findings.length}`);
  lines.push('');
  lines.push('## Findings (Severity Ordered)');
  lines.push('');

  if (findings.length === 0) {
    lines.push('- None.');
  } else {
    for (const finding of findings) {
      lines.push(
        `- [${finding.severity}] ${finding.rule} - \`${finding.file}:${finding.line}\` (${finding.chunkId}) - ${finding.description} Snippet: \`${finding.snippet}\``,
      );
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This scan highlights risk signals; each hit needs manual confirmation.');
  lines.push('- Prioritize P2 findings first, then clean up P3 drift findings.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest(opts.manifestPath);

  const allFindings: RiskFinding[] = [];
  const fileCache = new Map<string, string[]>();
  for (const chunk of manifest.chunks) {
    if (!fileCache.has(chunk.file)) {
      fileCache.set(chunk.file, fileLines(chunk.file));
    }
    const lines = fileCache.get(chunk.file) ?? [];
    allFindings.push(...scanChunk(chunk, lines));
  }

  const severityOrder: Record<RiskSeverity, number> = { P1: 0, P2: 1, P3: 2 };
  allFindings.sort((a, b) => {
    const sev = severityOrder[a.severity] - severityOrder[b.severity];
    if (sev !== 0) return sev;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const outDir = 'docs/code-review';
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const basePath = `${outDir}/long-file-chunk-risks-${day}`;

  const payload = {
    generatedAtUtc: new Date().toISOString(),
    manifestPath: opts.manifestPath,
    findings: allFindings,
  };

  writeFileSync(`${basePath}.json`, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(`${basePath}.md`, renderMarkdown(opts.manifestPath, allFindings), 'utf8');

  const p1 = allFindings.filter((f) => f.severity === 'P1').length;
  const p2 = allFindings.filter((f) => f.severity === 'P2').length;
  const p3 = allFindings.filter((f) => f.severity === 'P3').length;
  console.log(`review: wrote ${basePath}.md`);
  console.log(`review: wrote ${basePath}.json`);
  console.log(`review: chunk-risk findings=${allFindings.length} (P1=${p1}, P2=${p2}, P3=${p3})`);
}

main();
