import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Severity = 'P1' | 'P2' | 'P3';

type SectionFinding = {
  severity: Severity;
  section: string;
  file: string;
  line?: number;
  rule: string;
  details: string;
};

type SectionReview = {
  timestampUtc: string;
  commit: string;
  fileCount: number;
  findings: SectionFinding[];
  gateResults?: {
    build?: 'PASS' | 'FAIL';
    test?: 'PASS' | 'FAIL';
    legacyGuard?: 'PASS' | 'FAIL';
    preflight?: 'PASS' | 'FAIL';
  };
};

type RiskFinding = {
  severity: Severity;
  rule: string;
  description: string;
  chunkId: string;
  section: string;
  file: string;
  line: number;
  snippet: string;
};

type ChunkRisks = {
  generatedAtUtc: string;
  findings: RiskFinding[];
};

type ChunkAudit = {
  generatedAtUtc: string;
  chunksAudited: number;
  passed: number;
  followUp: number;
  entries: Array<{
    file: string;
    status: 'passed' | 'follow_up';
  }>;
};

type CliOptions = {
  sectionPath: string;
  chunkRisksPath: string;
  chunkAuditPath: string;
};

type StructuralLongFile = {
  file: string;
  mitigatedByChunkAudit: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const day = new Date().toISOString().slice(0, 10);
  let sectionPath = `docs/code-review/section-review-${day}.json`;
  let chunkRisksPath = `docs/code-review/long-file-chunk-risks-${day}.json`;
  let chunkAuditPath = `docs/code-review/long-file-chunk-audit-${day}.json`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sections') {
      sectionPath = argv[i + 1] ?? sectionPath;
      i += 1;
      continue;
    }
    if (arg === '--chunk-risks') {
      chunkRisksPath = argv[i + 1] ?? chunkRisksPath;
      i += 1;
      continue;
    }
    if (arg === '--chunk-audit') {
      chunkAuditPath = argv[i + 1] ?? chunkAuditPath;
      i += 1;
    }
  }
  return { sectionPath, chunkRisksPath, chunkAuditPath };
}

function readJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`required input not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function countBySeverity(findings: Array<{ severity: Severity }>): Record<Severity, number> {
  return {
    P1: findings.filter((finding) => finding.severity === 'P1').length,
    P2: findings.filter((finding) => finding.severity === 'P2').length,
    P3: findings.filter((finding) => finding.severity === 'P3').length,
  };
}

function hasFailingGate(section: SectionReview): boolean {
  const gates = section.gateResults;
  if (!gates) return true;
  return [gates.build, gates.test, gates.legacyGuard, gates.preflight].some((value) => value !== 'PASS');
}

function evaluateLongFileMitigations(section: SectionReview, audit: ChunkAudit): StructuralLongFile[] {
  const longFiles = section.findings.filter((finding) => finding.rule === 'LONG_FILE');
  const byFile = new Map<string, ChunkAudit['entries']>();
  for (const entry of audit.entries) {
    const list = byFile.get(entry.file) ?? [];
    list.push(entry);
    byFile.set(entry.file, list);
  }

  return longFiles.map((finding) => {
    const entries = byFile.get(finding.file) ?? [];
    const mitigated = entries.length > 0 && entries.every((entry) => entry.status === 'passed');
    return { file: finding.file, mitigatedByChunkAudit: mitigated };
  });
}

function renderMarkdown(payload: {
  sectionPath: string;
  chunkRisksPath: string;
  chunkAuditPath: string;
  section: SectionReview;
  risks: ChunkRisks;
  audit: ChunkAudit;
  bugFindings: Array<SectionFinding | RiskFinding>;
  structural: StructuralLongFile[];
  verdict: 'PASS' | 'FAIL';
}): string {
  const lines: string[] = [];
  const sectionCounts = countBySeverity(payload.section.findings);
  const riskCounts = countBySeverity(payload.risks.findings);

  lines.push('# Final Automated Audit');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${new Date().toISOString()}`);
  lines.push(`- Commit: ${payload.section.commit}`);
  lines.push(`- Verdict: ${payload.verdict}`);
  lines.push(`- Section review input: ${payload.sectionPath}`);
  lines.push(`- Chunk risk input: ${payload.chunkRisksPath}`);
  lines.push(`- Chunk audit input: ${payload.chunkAuditPath}`);
  lines.push(`- Files reviewed: ${payload.section.fileCount}`);
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push(`- build: ${payload.section.gateResults?.build ?? 'UNKNOWN'}`);
  lines.push(`- test: ${payload.section.gateResults?.test ?? 'UNKNOWN'}`);
  lines.push(`- guard:legacy: ${payload.section.gateResults?.legacyGuard ?? 'UNKNOWN'}`);
  lines.push(`- preflight: ${payload.section.gateResults?.preflight ?? 'UNKNOWN'}`);
  lines.push('');
  lines.push('## Findings Summary');
  lines.push('');
  lines.push(`- Section findings: ${payload.section.findings.length} (P1=${sectionCounts.P1}, P2=${sectionCounts.P2}, P3=${sectionCounts.P3})`);
  lines.push(`- Chunk risk findings: ${payload.risks.findings.length} (P1=${riskCounts.P1}, P2=${riskCounts.P2}, P3=${riskCounts.P3})`);
  lines.push(`- Chunk audit: ${payload.audit.passed}/${payload.audit.chunksAudited} passed, follow-up=${payload.audit.followUp}`);
  lines.push(`- Bug-risk findings (net): ${payload.bugFindings.length}`);
  lines.push('');
  lines.push('## Structural LONG_FILE Status');
  lines.push('');
  if (payload.structural.length === 0) {
    lines.push('- None.');
  } else {
    for (const item of payload.structural) {
      lines.push(`- ${item.file}: ${item.mitigatedByChunkAudit ? 'mitigated by chunk audit' : 'follow-up required'}`);
    }
  }
  lines.push('');
  lines.push('## Net Bug Findings');
  lines.push('');
  if (payload.bugFindings.length === 0) {
    lines.push('- None.');
  } else {
    for (const finding of payload.bugFindings) {
      if ('line' in finding) {
        lines.push(`- [${finding.severity}] ${finding.rule} - \`${finding.file}:${finding.line ?? 1}\` - ${finding.details}`);
      } else {
        lines.push(`- [${finding.severity}] ${finding.rule} - \`${finding.file}:${finding.line}\` - ${finding.description}`);
      }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const section = readJson<SectionReview>(opts.sectionPath);
  const risks = readJson<ChunkRisks>(opts.chunkRisksPath);
  const audit = readJson<ChunkAudit>(opts.chunkAuditPath);

  const structural = evaluateLongFileMitigations(section, audit);
  const longFileSet = new Set(structural.map((item) => item.file));

  const nonLongFileSectionFindings = section.findings.filter((finding) => finding.rule !== 'LONG_FILE');
  const unmitigatedLongFileCount = structural.filter((item) => !item.mitigatedByChunkAudit).length;
  const bugFindings: Array<SectionFinding | RiskFinding> = [
    ...nonLongFileSectionFindings,
    ...risks.findings,
  ];

  const hasHardFinding = bugFindings.some((finding) => finding.severity === 'P1' || finding.severity === 'P2');
  const verdict: 'PASS' | 'FAIL' =
    hasFailingGate(section) || hasHardFinding || audit.followUp > 0 || unmitigatedLongFileCount > 0
      ? 'FAIL'
      : 'PASS';

  const day = new Date().toISOString().slice(0, 10);
  const outDir = 'docs/code-review';
  mkdirSync(outDir, { recursive: true });
  const basePath = `${outDir}/final-audit-${day}`;

  const payload = {
    generatedAtUtc: new Date().toISOString(),
    commit: section.commit,
    verdict,
    inputs: {
      sections: opts.sectionPath,
      chunkRisks: opts.chunkRisksPath,
      chunkAudit: opts.chunkAuditPath,
    },
    gates: section.gateResults ?? null,
    totals: {
      filesReviewed: section.fileCount,
      sectionFindings: section.findings.length,
      chunkRiskFindings: risks.findings.length,
      bugFindings: bugFindings.length,
      structuralLongFiles: structural.length,
      unmitigatedLongFiles: unmitigatedLongFileCount,
      longFilesMitigated: structural.filter((item) => item.mitigatedByChunkAudit).length,
      chunksAudited: audit.chunksAudited,
      chunkFollowUp: audit.followUp,
    },
    longFileStatus: structural,
    sectionFindingsExcludedAsStructural: section.findings.filter(
      (finding) => finding.rule === 'LONG_FILE' && longFileSet.has(finding.file),
    ),
    bugFindings,
  };

  writeFileSync(`${basePath}.json`, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(
    `${basePath}.md`,
    renderMarkdown({
      sectionPath: opts.sectionPath,
      chunkRisksPath: opts.chunkRisksPath,
      chunkAuditPath: opts.chunkAuditPath,
      section,
      risks,
      audit,
      bugFindings,
      structural,
      verdict,
    }),
    'utf8',
  );

  console.log(`review: wrote ${basePath}.md`);
  console.log(`review: wrote ${basePath}.json`);
  console.log(`review: final verdict=${verdict} bugFindings=${bugFindings.length} longFilesMitigated=${payload.totals.longFilesMitigated}/${payload.totals.structuralLongFiles}`);
}

main();
