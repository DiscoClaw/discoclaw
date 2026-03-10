export const VERIFICATION_EVIDENCE_KINDS = ['build', 'test', 'audit'] as const;
export const VERIFICATION_EVIDENCE_STATUSES = ['pass', 'fail'] as const;

export type VerificationEvidenceKind = (typeof VERIFICATION_EVIDENCE_KINDS)[number];
export type VerificationEvidenceStatus = (typeof VERIFICATION_EVIDENCE_STATUSES)[number];

export type VerificationEvidence = {
  kind: VerificationEvidenceKind;
  status: VerificationEvidenceStatus;
  command?: string;
  summary?: string;
  reason?: string;
};

export type VerificationEvidenceInput = {
  kind: string;
  status: string;
  command?: string | null;
  summary?: string | null;
  reason?: string | null;
};

export type CoerceEvidenceArrayOptions = {
  allowedKinds?: readonly VerificationEvidenceKind[];
};

export type PhaseEvidenceKind = 'implement' | 'read' | 'audit';
export type PhaseEvidenceStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';

export type RunEvidencePhase = {
  id: string;
  title: string;
  kind: PhaseEvidenceKind;
  status: PhaseEvidenceStatus;
  evidence?: VerificationEvidence[];
};

export type PhaseEvidenceSummary = {
  phaseId: string;
  phaseTitle: string;
  phaseKind: PhaseEvidenceKind;
  phaseStatus: PhaseEvidenceStatus;
  evidence: VerificationEvidence[] | undefined;
};

const VALID_EVIDENCE_KINDS = new Set<string>(VERIFICATION_EVIDENCE_KINDS);
const VALID_EVIDENCE_STATUSES = new Set<string>(VERIFICATION_EVIDENCE_STATUSES);

function normalizeOptionalText(
  value: string | null | undefined,
  field: keyof Pick<VerificationEvidence, 'command' | 'summary' | 'reason'>,
): string | undefined {
  if (value == null) return undefined;

  if (typeof value !== 'string') {
    throw new Error(`VerificationEvidence ${field} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collapseToOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function createEvidence(input: VerificationEvidenceInput): VerificationEvidence {
  if (!VALID_EVIDENCE_KINDS.has(input.kind)) {
    throw new Error(`Unknown verification evidence kind: '${input.kind}'`);
  }

  if (!VALID_EVIDENCE_STATUSES.has(input.status)) {
    throw new Error(`Unknown verification evidence status: '${input.status}'`);
  }

  const command = normalizeOptionalText(input.command, 'command');
  const summary = normalizeOptionalText(input.summary, 'summary');
  const reason = normalizeOptionalText(input.reason, 'reason');

  if (input.status === 'fail' && !reason) {
    throw new Error('Failed verification evidence requires a reason');
  }

  if (input.status === 'pass' && reason) {
    throw new Error('Passed verification evidence cannot include a reason');
  }

  const evidence: VerificationEvidence = {
    kind: input.kind as VerificationEvidenceKind,
    status: input.status as VerificationEvidenceStatus,
  };

  if (command) evidence.command = command;
  if (summary) evidence.summary = summary;
  if (reason) evidence.reason = reason;

  return evidence;
}

export function coerceEvidenceArray(
  value: unknown,
  field: string,
  opts: CoerceEvidenceArrayOptions = {},
): VerificationEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error(`Malformed phases json: ${field} must be VerificationEvidence[]`);
  }

  const allowedKinds = opts.allowedKinds ? new Set<string>(opts.allowedKinds) : null;

  return value.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Malformed phases json: ${field}[${idx}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;

    const asOptionalString = (key: 'command' | 'summary' | 'reason'): string | null | undefined => {
      const raw = obj[key];
      if (raw === undefined || raw === null) return raw;
      if (typeof raw !== 'string') {
        throw new Error(`Malformed phases json: ${field}[${idx}].${key} must be a string`);
      }
      return raw;
    };

    try {
      const evidence = createEvidence({
        kind: typeof obj.kind === 'string' ? obj.kind : String(obj.kind),
        status: typeof obj.status === 'string' ? obj.status : String(obj.status),
        command: asOptionalString('command'),
        summary: asOptionalString('summary'),
        reason: asOptionalString('reason'),
      });
      if (allowedKinds && !allowedKinds.has(evidence.kind)) {
        throw new Error(`kind '${evidence.kind}' is not allowed here`);
      }
      return evidence;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Malformed phases json: ${field}[${idx}] ${msg}`);
    }
  });
}

export function formatEvidenceLine(evidence: VerificationEvidence): string {
  const parts = [`${evidence.kind}: ${evidence.status}`];

  if (evidence.command?.trim()) {
    parts.push(collapseToOneLine(evidence.command));
  }

  const detail = evidence.status === 'fail'
    ? evidence.reason?.trim()
    : evidence.summary?.trim();

  if (detail) {
    parts.push(collapseToOneLine(detail));
  }

  return parts.join(' - ');
}

export function formatEvidenceSummary(evidence: VerificationEvidence): string {
  const detail = evidence.status === 'fail'
    ? evidence.reason?.trim()
    : evidence.summary?.trim();

  if (detail) {
    return `${evidence.kind}: ${evidence.status} (${collapseToOneLine(detail)})`;
  }

  return `${evidence.kind}: ${evidence.status}`;
}

export function collectRunEvidence(phases: RunEvidencePhase[]): PhaseEvidenceSummary[] {
  return phases.map((phase) => ({
    phaseId: phase.id,
    phaseTitle: phase.title,
    phaseKind: phase.kind,
    phaseStatus: phase.status,
    evidence: phase.evidence ? [...phase.evidence] : phase.evidence,
  }));
}
