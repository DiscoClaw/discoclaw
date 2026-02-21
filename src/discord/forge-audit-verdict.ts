import { extractFirstJsonValue } from './json-extract.js';

export type AuditSeverity = 'blocking' | 'medium' | 'minor' | 'suggestion' | 'none';

export type AuditVerdict = {
  maxSeverity: AuditSeverity;
  shouldLoop: boolean;
};

export type AuditVerdictPayload = {
  maxSeverity?: string;
  shouldLoop?: boolean;
  summary?: string;
  concerns?: Array<{ title?: string; severity?: string }>;
  verdict?: AuditVerdictPayload;
};

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  none: 0,
  suggestion: 1,
  minor: 2,
  medium: 3,
  blocking: 4,
};

function normalizeSeverity(raw: string | undefined): AuditSeverity | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'high') return 'blocking';
  if (normalized === 'low') return 'minor';
  if (
    normalized === 'blocking' ||
    normalized === 'medium' ||
    normalized === 'minor' ||
    normalized === 'suggestion' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  return null;
}

function maxSeverityFromList(severities: AuditSeverity[]): AuditSeverity {
  let max: AuditSeverity = 'none';
  for (const sev of severities) {
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[max]) {
      max = sev;
    }
  }
  return max;
}

function tryParseJsonVerdict(auditText: string): AuditVerdict | null {
  const jsonCandidate = extractFirstJsonValue(auditText, { objectOnly: true });
  if (!jsonCandidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const payload = parsed as AuditVerdictPayload;
  const verdictPayload = payload.verdict && typeof payload.verdict === 'object'
    ? payload.verdict
    : payload;

  const topSeverity = normalizeSeverity(verdictPayload.maxSeverity);
  const concernSeverities: AuditSeverity[] = [];
  for (const concern of verdictPayload.concerns ?? []) {
    const severity = normalizeSeverity(concern?.severity);
    if (severity) concernSeverities.push(severity);
  }
  const hasStructuredVerdict =
    topSeverity !== null ||
    typeof verdictPayload.shouldLoop === 'boolean' ||
    concernSeverities.length > 0;
  if (!hasStructuredVerdict) return null;

  const concernMax = maxSeverityFromList(concernSeverities);
  let maxSeverity = topSeverity ?? concernMax;
  const shouldLoop = typeof verdictPayload.shouldLoop === 'boolean'
    ? verdictPayload.shouldLoop
    : maxSeverity === 'blocking';
  if (shouldLoop && maxSeverity === 'none') {
    maxSeverity = 'blocking';
  }

  return { maxSeverity, shouldLoop };
}

function parseAuditVerdictLegacy(auditText: string): AuditVerdict {
  const lower = auditText.toLowerCase();

  // --- Severity detection ---
  // Primary: "Severity: blocking" or "Severity: **high**" (structured format we ask for)
  // Secondary: table cells like "| **blocking** |" or "| medium |".
  // Tertiary: parenthesized severity like "Concern 1 (high)" or "(medium)".
  // We intentionally avoid matching free-form bold words in prose to prevent
  // false positives like "the impact is **high**" in a description paragraph.
  const severityLabel = /\bseverity\b[:\s]*\**\s*(blocking|high|medium|minor|low|suggestion)\b/gi;
  const tableCellSeverity = /\|\s*\**\s*(blocking|high|medium|minor|low|suggestion)\s*\**\s*\|/gi;
  const bareSeverity = /\((blocking|high|medium|minor|low|suggestion)\)/gi;

  // Collect all severity mentions from all patterns
  const found = new Set<string>();
  for (const re of [severityLabel, tableCellSeverity, bareSeverity]) {
    let m;
    while ((m = re.exec(auditText)) !== null) {
      found.add(m[1]!.toLowerCase());
    }
  }

  // Normalize backward-compat aliases: high -> blocking, low -> minor
  if (found.has('high')) {
    found.delete('high');
    found.add('blocking');
  }
  if (found.has('low')) {
    found.delete('low');
    found.add('minor');
  }

  // Determine max severity from markers (blocking > medium > minor > suggestion)
  const markerSeverity: AuditVerdict['maxSeverity'] = found.has('blocking')
    ? 'blocking'
    : found.has('medium')
      ? 'medium'
      : found.has('minor')
        ? 'minor'
        : found.has('suggestion')
          ? 'suggestion'
          : 'none';

  // Determine verdict from text
  const needsRevision = lower.includes('needs revision');
  const readyToApprove = lower.includes('ready to approve');

  // Severity markers win over verdict text when they disagree.
  // A "Ready to approve" verdict with blocking-severity findings is contradictory —
  // trust the severity markers.
  if (markerSeverity !== 'none') {
    const shouldLoop = markerSeverity === 'blocking';
    return { maxSeverity: markerSeverity, shouldLoop };
  }

  // No severity markers found — fall back to verdict text
  if (needsRevision) {
    return { maxSeverity: 'blocking', shouldLoop: true };
  }
  if (readyToApprove) {
    return { maxSeverity: 'minor', shouldLoop: false };
  }

  // Malformed output — stop and let the human review
  return { maxSeverity: 'none', shouldLoop: false };
}

export function parseAuditVerdict(auditText: string): AuditVerdict {
  if (!auditText || !auditText.trim()) {
    return { maxSeverity: 'none', shouldLoop: false };
  }

  const parsedJson = tryParseJsonVerdict(auditText);
  if (parsedJson) return parsedJson;

  return parseAuditVerdictLegacy(auditText);
}
