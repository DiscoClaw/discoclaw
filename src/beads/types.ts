// ---------------------------------------------------------------------------
// Bead data types — mirrors the bd CLI JSONL schema.
// ---------------------------------------------------------------------------

export const BEAD_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'closed',
  'done',
  'tombstone',
] as const;

export type BeadStatus = (typeof BEAD_STATUSES)[number];

export function isBeadStatus(s: string): s is BeadStatus {
  return (BEAD_STATUSES as readonly string[]).includes(s);
}

export type BeadData = {
  id: string;
  title: string;
  status: BeadStatus;

  // Many bd fields are often absent depending on command / config; model as optional.
  description?: string;
  priority?: number;
  issue_type?: string;
  owner?: string;
  external_ref?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; created_at: string }>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
};

export type BeadCreateParams = {
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  owner?: string;
  labels?: string[];
};

export type BeadUpdateParams = {
  title?: string;
  description?: string;
  priority?: number;
  status?: BeadStatus;
  owner?: string;
  externalRef?: string;
};

export type BeadCloseParams = {
  reason?: string;
};

export type BeadListParams = {
  status?: string;
  label?: string;
  limit?: number;
};

/** Tag name → Discord forum tag ID. */
export type TagMap = Record<string, string>;

/** Status → emoji prefix for thread names. */
export const STATUS_EMOJI: Record<string, string> = {
  open: '\u{1F7E2}',          // 🟢
  in_progress: '\u{1F7E1}',   // 🟡
  blocked: '\u{1F6AB}',       // 🚫
  closed: '\u2705',            // ✅
  done: '\u2705',              // ✅
  tombstone: '\u{1FAA6}',     // 🪦
};
