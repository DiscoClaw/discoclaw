// ── Self-improvement harness types ──────────────────────────────────

/** A single expected action from a frozen test case. */
export interface ExpectedAction {
  type: string;
  params?: Record<string, unknown>;
}

/** A frozen prompt/expected-action pair loaded from disk. */
export interface FrozenTestCase {
  id: string;
  prompt: string;
  expectedActions: ExpectedAction[];
  tags?: string[];
}

/** Schema for a single test case in a JSON fixture file. */
export interface FrozenTestCaseRaw {
  id: string;
  prompt: string;
  expectedActions: { type: string; params?: Record<string, unknown> }[];
  tags?: string[];
}

// ── Mutation types ──────────────────────────────────────────────────

export type MutationKind = 'insert' | 'delete' | 'replace' | 'swap';

/** A single line-level edit operation on instruction text. */
export interface MutationOp {
  kind: MutationKind;
  /** Zero-based line index to target. */
  target: number;
  /** New content (for insert/replace). */
  content?: string;
  /** Second line index (for swap). */
  swapWith?: number;
}

/** A named bundle of mutation operations. */
export interface Mutation {
  ops: MutationOp[];
  description: string;
}

/** The before/after state of an instruction mutation. */
export interface MutationResult {
  original: string;
  mutated: string;
  mutation: Mutation;
}

// ── Scoring types ───────────────────────────────────────────────────

/** Comparison of one expected action against the best-matching actual action. */
export interface ActionMatch {
  expected: ExpectedAction;
  actual: ExpectedAction | null;
  typeMatch: boolean;
  /** Fraction of expected params that matched (0–1). */
  paramScore: number;
  /** Combined score for this pair (0–1). */
  score: number;
}

/** Aggregate score for one test case. */
export interface ScoreResult {
  testCaseId: string;
  matches: ActionMatch[];
  /** Overall score for the test case (0–1). */
  score: number;
}
