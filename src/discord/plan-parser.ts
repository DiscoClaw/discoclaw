export type ParsedPlanDoc = {
  title: string;
  metadata: Map<string, string>;
  sections: Map<string, string>;
};

function parseBoldMetadataLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('**')) return null;
  const sep = trimmed.indexOf(':**');
  if (sep === -1) return null;
  const key = trimmed.slice(2, sep).trim();
  if (!key) return null;
  const value = trimmed.slice(sep + ':**'.length).trim();
  return { key, value };
}

export function parsePlan(content: string): ParsedPlanDoc {
  const lines = content.split('\n');
  const metadata = new Map<string, string>();
  const sections = new Map<string, string>();
  let title = '';
  let inFence = false;

  let currentSection: string | null = null;
  let currentBody: string[] = [];

  const flushSection = () => {
    if (!currentSection) return;
    sections.set(currentSection, currentBody.join('\n').trim());
    currentSection = null;
    currentBody = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
    }

    if (!inFence && line.startsWith('# Plan:') && !title) {
      title = line.slice('# Plan:'.length).trim();
    }

    if (!inFence && currentSection === null) {
      const meta = parseBoldMetadataLine(line);
      if (meta) metadata.set(meta.key, meta.value);
    }

    if (!inFence) {
      const sectionMatch = line.match(/^##\s+(.+)$/);
      if (sectionMatch) {
        flushSection();
        currentSection = sectionMatch[1]!.trim();
        continue;
      }
    }

    if (currentSection) {
      currentBody.push(line);
    }
  }

  flushSection();

  return { title, metadata, sections };
}

export function getSection(
  doc: ParsedPlanDoc,
  sectionName: string,
): string {
  return doc.sections.get(sectionName) ?? '';
}

function stripFencedCode(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

export function getLatestAuditVerdictFromSection(auditSection: string): string | null {
  const text = stripFencedCode(auditSection);
  const lines = text.split('\n');

  // Preferred modern format: **Verdict:** ...
  const verdicts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith('**verdict:**')) continue;
    verdicts.push(trimmed.slice('**Verdict:**'.length).trim());
  }
  if (verdicts.length > 0) {
    return verdicts[verdicts.length - 1] || null;
  }

  // Legacy format:
  // #### Verdict
  // <line(s)>
  let latestLegacy: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().toLowerCase() !== '#### verdict') continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.startsWith('### ') || line.startsWith('#### ')) break;
      if (line.trim() === '---') break;
      if (line.trim()) body.push(line.trim());
    }
    if (body.length > 0) latestLegacy = body.join(' ');
  }
  return latestLegacy;
}
