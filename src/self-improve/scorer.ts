// ── Action-compliance scorer ────────────────────────────────────────
//
// Scores a set of actual actions against a frozen test case's expected
// actions. Uses greedy best-match pairing: each expected action picks
// the highest-scoring unmatched actual action.
//
// Scoring breakdown per action pair:
//   - Type match:  0 or 1 (must match to score params)
//   - Param score: fraction of expected params whose values match
//   - Combined:    type_match * (TYPE_WEIGHT + PARAM_WEIGHT * param_score)
//
// Overall test-case score = mean of per-action combined scores.

import type { ExpectedAction, ActionMatch, ScoreResult, FrozenTestCase } from './types.js';

// ── Weights ─────────────────────────────────────────────────────────

const TYPE_WEIGHT = 0.6;
const PARAM_WEIGHT = 0.4;

// ── Param comparison ────────────────────────────────────────────────

/**
 * Fraction of expected params that match in the actual action (0–1).
 * Missing expected params count as mismatches.
 * Extra actual params are ignored (non-penalised).
 */
export function paramMatchScore(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): number {
  if (!expected || Object.keys(expected).length === 0) return 1.0;
  if (!actual) return 0.0;

  const keys = Object.keys(expected);
  let matched = 0;
  for (const key of keys) {
    if (deepEqual(expected[key], actual[key])) {
      matched++;
    }
  }
  return matched / keys.length;
}

/** Structural deep equality for JSON-serialisable values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  }

  return false;
}

// ── Single-pair scoring ─────────────────────────────────────────────

function scorePair(expected: ExpectedAction, actual: ExpectedAction): number {
  const typeMatch = expected.type === actual.type;
  if (!typeMatch) return 0;

  const ps = paramMatchScore(expected.params, actual.params);
  return TYPE_WEIGHT + PARAM_WEIGHT * ps;
}

// ── Greedy matching ─────────────────────────────────────────────────

/**
 * Score actual actions against a test case's expected actions.
 *
 * Uses greedy best-match: for each expected action, finds the
 * highest-scoring unmatched actual action. Unmatched expected
 * actions score 0.
 */
export function scoreTestCase(
  testCase: FrozenTestCase,
  actualActions: ExpectedAction[],
): ScoreResult {
  const used = new Set<number>();
  const matches: ActionMatch[] = [];

  for (const expected of testCase.expectedActions) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < actualActions.length; i++) {
      if (used.has(i)) continue;
      const s = scorePair(expected, actualActions[i]);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore > 0) {
      used.add(bestIdx);
      const actual = actualActions[bestIdx];
      matches.push({
        expected,
        actual,
        typeMatch: expected.type === actual.type,
        paramScore: paramMatchScore(expected.params, actual.params),
        score: bestScore,
      });
    } else {
      matches.push({
        expected,
        actual: null,
        typeMatch: false,
        paramScore: 0,
        score: 0,
      });
    }
  }

  const overall =
    matches.length > 0
      ? matches.reduce((sum, m) => sum + m.score, 0) / matches.length
      : 0;

  return {
    testCaseId: testCase.id,
    matches,
    score: overall,
  };
}

/**
 * Score multiple test cases and return individual + aggregate results.
 */
export function scoreBatch(
  testCases: FrozenTestCase[],
  actualPerCase: Map<string, ExpectedAction[]>,
): { results: ScoreResult[]; meanScore: number } {
  const results: ScoreResult[] = [];

  for (const tc of testCases) {
    const actual = actualPerCase.get(tc.id) ?? [];
    results.push(scoreTestCase(tc, actual));
  }

  const meanScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;

  return { results, meanScore };
}
