// ── Console reporter ────────────────────────────────────────────────
//
// Formats scoring results as a human-readable table and summary line
// for the CLI entry point.

import type { ScoreResult } from './types.js';

// ── Table formatting ────────────────────────────────────────────────

/**
 * Format scoring results as a padded console table.
 *
 * Columns: Test Case ID | Score | Matched/Total | Status
 */
export function formatConsoleTable(results: ScoreResult[], meanScore: number): string {
  const header = ['Test Case ID', 'Score', 'Actions', 'Status'];
  const rows: string[][] = [];

  for (const r of results) {
    const matched = r.matches.filter((m) => m.score > 0).length;
    const total = r.matches.length;
    const status =
      r.score >= 1.0 ? 'pass' : r.score > 0 ? 'partial' : 'fail';

    rows.push([
      r.testCaseId,
      r.score.toFixed(3),
      `${matched}/${total}`,
      status,
    ]);
  }

  // Calculate column widths.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  const lines = [
    header.map((h, i) => pad(h, widths[i])).join('  '),
    sep,
    ...rows.map((row) => row.map((cell, i) => pad(cell, widths[i])).join('  ')),
    sep,
    `Mean score: ${meanScore.toFixed(3)}`,
  ];

  return lines.join('\n');
}

// ── Summary line ────────────────────────────────────────────────────

/**
 * Format a one-line iteration summary.
 */
export function formatSummary(
  meanScore: number,
  previousBest: number,
  promoted: boolean,
): string {
  const delta = meanScore - previousBest;
  const sign = delta >= 0 ? '+' : '';
  const promotedTag = promoted ? ' [PROMOTED]' : '';
  return `Score: ${meanScore.toFixed(3)} (prev best: ${previousBest.toFixed(3)}, delta: ${sign}${delta.toFixed(3)})${promotedTag}`;
}
