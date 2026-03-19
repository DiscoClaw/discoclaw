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
  /** Action types the model must NOT emit for this prompt. */
  forbiddenActions?: string[];
  tags?: string[];
}

/** Schema for a single test case in a JSON fixture file. */
export interface FrozenTestCaseRaw {
  id: string;
  prompt: string;
  expectedActions: { type: string; params?: Record<string, unknown> }[];
  /** Action types the model must NOT emit for this prompt. */
  forbiddenActions?: string[];
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

// ── Runner types ────────────────────────────────────────────────────

/** Options for configuring the runtime adapter invocation. */
export interface RunnerOpts {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Max test cases to run in parallel (default 1 = sequential). */
  concurrency?: number;
  /** Inject the Discord action schema into the system prompt (default true). */
  injectActionSchema?: boolean;
  /** Called after each test case completes or fails. */
  onProgress?: ProgressCallback;
  /** Called after each test case completes with its full result (for checkpointing). */
  onCaseResult?: (tc: FrozenTestCase, result: RunResult) => void | Promise<void>;
  /** AbortSignal — when aborted, pending cases are skipped. */
  signal?: AbortSignal;
}

/** Called after each test case completes (or fails) during a suite run. */
export type ProgressCallback = (info: {
  index: number;
  total: number;
  testCaseId: string;
  status: 'pass' | 'error';
  durationMs: number;
  error?: string;
}) => void;

/** Result of running a single test case through the runtime adapter. */
export interface RunResult {
  testCaseId: string;
  text: string;
  actions: ExpectedAction[];
  parseFailures: number;
  events: import('../runtime/types.js').EngineEvent[];
  durationMs: number;
  /** Non-null when the test case threw instead of completing normally. */
  error?: string;
}

// ── Keeper types ────────────────────────────────────────────────────

/** Record of a single iteration's outcome (persisted regardless of promotion). */
export interface IterationRecord {
  iteration: number;
  score: number;
  promoted: boolean;
  mutationDescription: string;
  timestamp: string;
}

/** Persisted ledger tracking the best-known score for an instruction file. */
export interface Ledger {
  bestScore: number;
  iteration: number;
  promotedAt: string;
  /** Hash of sorted test-case IDs — detects when the case set has changed. */
  caseSetHash?: string;
  /** Full history of every iteration (baseline + mutations). */
  history?: IterationRecord[];
}

// ── Checkpoint types ──────────────────────────────────────────────

/** Minimal result data preserved in a checkpoint for resume. */
export interface CheckpointedResult {
  actions: ExpectedAction[];
  durationMs: number;
  error?: string;
}

/** Checkpoint state for resumable harness runs. */
export interface HarnessCheckpoint {
  /** Phase identifier: "baseline" or "iteration-N". */
  phase: string;
  /** Hash of the test case set (must match to resume). */
  caseSetHash: string;
  /** Completed case results keyed by test case ID. */
  completed: Record<string, CheckpointedResult>;
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

/** A forbidden action that was emitted (violation). */
export interface ForbiddenViolation {
  /** The forbidden action type. */
  forbiddenType: string;
  /** The actual action that violated the constraint. */
  actual: ExpectedAction;
}

/** Aggregate score for one test case. */
export interface ScoreResult {
  testCaseId: string;
  matches: ActionMatch[];
  /** Forbidden actions that were emitted (should be empty for a perfect score). */
  violations: ForbiddenViolation[];
  /** Overall score for the test case (0–1). */
  score: number;
}
