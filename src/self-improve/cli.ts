#!/usr/bin/env node
// ── Self-improvement harness CLI ────────────────────────────────────
//
// Entry point that wires loader → runner → scorer → keeper → reporter
// into an iterative improvement loop.
//
// Usage:
//   npx tsx src/self-improve/cli.ts --target workspace/AGENTS.md
//   npx tsx src/self-improve/cli.ts --suite test-suites/action-compliance --iterations 3

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadTestCasesFromDir } from './loader.js';
import { runSuite } from './runner.js';
import { scoreBatch } from './scorer.js';
import { loadLedger, shouldPromote, promote } from './keeper.js';
import { formatConsoleTable, formatSummary } from './reporter.js';
import { createClaudeCliRuntime } from '../runtime/claude-code-cli.js';
import type { RuntimeAdapter } from '../runtime/types.js';

// ── Arg parsing ─────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'test-suites/action-compliance' },
    target: { type: 'string' },
    iterations: { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
    model: { type: 'string' },
    adapter: { type: 'string', default: 'claude_code' },
  },
  strict: true,
});

if (!values.target) {
  console.error('Error: --target <path to instruction file> is required');
  process.exit(1);
}

const suitePath = resolve(values.suite!);
const targetPath = resolve(values.target);
const iterations = Math.max(1, parseInt(values.iterations!, 10) || 1);
const dryRun = values['dry-run']!;
const modelOverride = values.model;
const adapterName = values.adapter!;

// ── Preflight: git clean check ──────────────────────────────────────

if (!dryRun) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
    }).trim();
    if (status.length > 0) {
      console.error('Error: git working tree is dirty. Commit or stash changes first, or use --dry-run.');
      process.exit(1);
    }
  } catch {
    console.error('Warning: could not check git status; proceeding anyway.');
  }
}

// ── Adapter resolution ──────────────────────────────────────────────

function resolveAdapter(name: string): RuntimeAdapter {
  if (name === 'claude_code') {
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
    return createClaudeCliRuntime({
      claudeBin,
      dangerouslySkipPermissions: true,
      outputFormat: 'stream-json',
    });
  }
  throw new Error(`Unknown adapter: ${name}. Currently only "claude_code" is supported.`);
}

// ── Main loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const adapter = resolveAdapter(adapterName);
  const testCases = await loadTestCasesFromDir(suitePath);
  if (testCases.length === 0) {
    console.error(`No test cases found in ${suitePath}`);
    process.exit(1);
  }
  console.log(`Loaded ${testCases.length} test case(s) from ${suitePath}`);

  const ledgerPath = targetPath + '.ledger.json';
  let ledger = await loadLedger(ledgerPath);

  for (let i = 1; i <= iterations; i++) {
    console.log(`\n── Iteration ${i}/${iterations} ──`);

    // Read current instruction text.
    const instructions = await readFile(targetPath, 'utf-8');

    // Run the suite.
    const { results: runResults, actionsMap } = await runSuite(
      testCases,
      instructions,
      adapter,
      { model: modelOverride, cwd: process.cwd() },
    );

    // Score.
    const { results: scoreResults, meanScore } = scoreBatch(testCases, actionsMap);

    // Report.
    console.log('\n' + formatConsoleTable(scoreResults, meanScore));

    // Keep / revert decision.
    const promoted = !dryRun && shouldPromote(ledger, meanScore);

    if (promoted) {
      ledger = await promote(targetPath, instructions, ledgerPath, meanScore);
    }

    console.log(formatSummary(meanScore, ledger.bestScore, promoted));

    // Log durations.
    const totalMs = runResults.reduce((sum, r) => sum + r.durationMs, 0);
    console.log(`Total runtime: ${(totalMs / 1000).toFixed(1)}s across ${runResults.length} case(s)`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
