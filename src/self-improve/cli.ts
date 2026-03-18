#!/usr/bin/env node
// ── Self-improvement harness CLI ────────────────────────────────────
//
// Entry point that wires loader → runner → scorer → keeper → reporter
// into an iterative improvement loop.
//
// Usage:
//   npx tsx src/self-improve/cli.ts --target workspace/AGENTS.md
//   npx tsx src/self-improve/cli.ts --suite test-suites/action-compliance --iterations 3
//   npx tsx src/self-improve/cli.ts --target workspace/AGENTS.md --tag crons --tag plans
//   npx tsx src/self-improve/cli.ts --target workspace/AGENTS.md --ai-mutate

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadTestCasesFromDir, filterByTags } from './loader.js';
import { applyMutation, generateRandomMutation, generateMutation } from './mutator.js';
import { generateAiMutation } from './ai-mutator.js';
import { runSuite } from './runner.js';
import { scoreBatch } from './scorer.js';
import { loadLedger, saveLedger, shouldPromote, promote, cleanupStagingFiles, cleanupOrphanedStagingFiles, computeCaseSetHash, caseSetChanged, recordIteration } from './keeper.js';
import { formatConsoleTable, formatSummary } from './reporter.js';
import { createClaudeCliRuntime } from '../runtime/claude-code-cli.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { RunResult, ScoreResult } from './types.js';

// ── Arg parsing ─────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'test-suites/action-compliance' },
    target: { type: 'string' },
    iterations: { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
    'baseline-only': { type: 'boolean', default: false },
    'target-label': { type: 'string' },
    'random-only': { type: 'boolean', default: false },
    'ai-mutate': { type: 'boolean', default: false },
    'mutator-model': { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    model: { type: 'string' },
    adapter: { type: 'string', default: 'claude_code' },
    tag: { type: 'string', multiple: true },
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
const baselineOnly = values['baseline-only']!;
const targetLabel = values['target-label'] ?? targetPath.split('/').pop() ?? targetPath;
const randomOnly = values['random-only']!;
const aiMutate = values['ai-mutate']!;
const mutatorModel = values['mutator-model'];
const concurrency = Math.max(1, parseInt(values.concurrency!, 10) || 1);
const modelOverride = values.model;
const adapterName = values.adapter!;
const tagFilter = values.tag;

// ── Log file ────────────────────────────────────────────────────────
// Always tee output to a log file next to the ledger so background runs
// leave evidence.

const logFilePath = targetPath + '.harness.log';

async function log(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  await appendFile(logFilePath, line, 'utf-8');
}

// ── Signal handling ─────────────────────────────────────────────────

const abortController = new AbortController();
let interrupted = false;

async function handleInterrupt(): Promise<void> {
  if (interrupted) return; // Second signal → hard exit below.
  interrupted = true;
  console.error('\nInterrupted — cleaning up staging files…');
  abortController.abort();
  await cleanupStagingFiles();
  await cleanupOrphanedStagingFiles(dirname(targetPath));
  process.exit(130);
}

process.on('SIGINT', () => {
  handleInterrupt().catch(() => process.exit(130));
  // If cleanup takes too long, second SIGINT force-kills.
});
process.on('SIGTERM', () => {
  handleInterrupt().catch(() => process.exit(143));
});

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

// ── Progress callback ───────────────────────────────────────────────

function logProgress(info: {
  index: number;
  total: number;
  testCaseId: string;
  status: 'pass' | 'error';
  durationMs: number;
  error?: string;
}): void {
  const tag = info.status === 'error' ? 'ERR' : 'OK';
  const dur = (info.durationMs / 1000).toFixed(1);
  const suffix = info.error ? ` — ${info.error}` : '';
  console.log(`  [${info.index}/${info.total}] ${info.testCaseId} ${tag} (${dur}s)${suffix}`);
}

// ── Failure diagnostics ─────────────────────────────────────────────

function printFailureDiagnostics(results: RunResult[]): void {
  const failures = results.filter((r) => r.error);
  if (failures.length === 0) return;

  console.log(`\n── ${failures.length} test case(s) failed with errors ──`);
  for (const f of failures) {
    console.log(`  • ${f.testCaseId}: ${f.error}`);
  }
}

// ── Main loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Clean orphaned staging files from prior interrupted runs.
  const orphans = await cleanupOrphanedStagingFiles(dirname(targetPath));
  if (orphans > 0) {
    await log(`Cleaned up ${orphans} orphaned staging file(s)`);
  }

  const adapter = resolveAdapter(adapterName);
  let testCases = await loadTestCasesFromDir(suitePath);
  if (tagFilter && tagFilter.length > 0) {
    testCases = filterByTags(testCases, tagFilter);
    await log(`Filtered to ${testCases.length} case(s) matching tags: ${tagFilter.join(', ')}`);
  }
  if (testCases.length === 0) {
    console.error(`No test cases found in ${suitePath}${tagFilter ? ` (tags: ${tagFilter.join(', ')})` : ''}`);
    process.exit(1);
  }
  await log(`Loaded ${testCases.length} test case(s) from ${suitePath}`);
  if (concurrency > 1) {
    await log(`Concurrency: ${concurrency}`);
  }

  // ── AI mutator setup ──
  // Uses OpenAI-compatible API (OpenRouter by default). Falls back to OPENAI_API_KEY if no OpenRouter key.
  const aiMutatorApiKey = aiMutate
    ? (process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '')
    : '';
  if (aiMutate && !aiMutatorApiKey) {
    console.error('Error: --ai-mutate requires OPENROUTER_API_KEY or OPENAI_API_KEY environment variable');
    process.exit(1);
  }
  // Auto-detect base URL: OpenRouter if using that key, otherwise OpenAI-compatible default.
  const aiMutatorBaseUrl = process.env.OPENROUTER_API_KEY
    ? 'https://openrouter.ai/api'
    : 'https://api.openai.com';

  const runOpts = {
    model: modelOverride,
    cwd: process.cwd(),
    concurrency,
    onProgress: logProgress,
    signal: abortController.signal,
  };
  const ledgerPath = targetPath + '.ledger.json';
  let ledger = await loadLedger(ledgerPath);

  // Track last score results for AI mutator feedback loop.
  let lastScoreResults: ScoreResult[] | null = null;
  let lastMeanScore = 0;

  // ── Case-set change detection ──
  // Hash the current test-case IDs so we can detect when a stale ledger
  // from a different tag filter or suite is being reused.
  const currentCaseHash = computeCaseSetHash(testCases.map((tc) => tc.id));
  const caseSetStale = caseSetChanged(ledger, currentCaseHash);
  if (caseSetStale) {
    await log(`Case set changed (ledger hash: ${ledger.caseSetHash}, current: ${currentCaseHash}) — forcing fresh baseline`);
  }

  // ── Establish baseline score ──
  // Run baseline when: explicitly requested, first run (no score), or case set changed.
  const needsBaseline = baselineOnly || (ledger.iteration === 0 && ledger.bestScore === 0) || caseSetStale;
  if (needsBaseline) {
    await log(`\n── Baseline: ${targetLabel} ──`);
    const instructions = await readFile(targetPath, 'utf-8');
    const { results: runResults, actionsMap } = await runSuite(testCases, instructions, adapter, runOpts);

    printFailureDiagnostics(runResults);

    const { results: scoreResults, meanScore } = scoreBatch(testCases, actionsMap);
    const totalViolations = scoreResults.reduce((sum, r) => sum + r.violations.length, 0);
    const errorCount = runResults.filter((r) => r.error).length;
    console.log('\n' + formatConsoleTable(scoreResults, meanScore));
    await log(
      `Baseline score for ${targetLabel}: ${meanScore.toFixed(3)}` +
      (totalViolations > 0 ? ` (${totalViolations} violation(s))` : '') +
      (errorCount > 0 ? ` (${errorCount} error(s))` : ''),
    );

    ledger = {
      bestScore: meanScore,
      iteration: 0,
      promotedAt: new Date().toISOString(),
      caseSetHash: currentCaseHash,
      history: [],
    };
    // Record baseline in history.
    ledger = await recordIteration(ledgerPath, ledger, {
      iteration: 0,
      score: meanScore,
      promoted: true,
      mutationDescription: 'baseline',
      timestamp: new Date().toISOString(),
    });
    lastScoreResults = scoreResults;
    lastMeanScore = meanScore;

    if (baselineOnly) {
      await log('Baseline-only mode — done.');
      return;
    }
  }

  // ── Mutation iterations ──
  for (let i = 1; i <= iterations; i++) {
    if (abortController.signal.aborted) {
      await log('\nAborted — stopping iterations.');
      break;
    }

    await log(`\n── Iteration ${i}/${iterations} ──`);

    // Read the current best instruction text.
    const instructions = await readFile(targetPath, 'utf-8');

    // Generate mutation: AI-guided → structural → random
    let mutation;
    if (aiMutate && lastScoreResults) {
      const aiMutation = await generateAiMutation(
        instructions,
        lastScoreResults,
        lastMeanScore,
        {
          apiKey: aiMutatorApiKey,
          baseUrl: aiMutatorBaseUrl,
          model: mutatorModel,
        },
      );
      mutation = aiMutation ?? (randomOnly ? generateRandomMutation(instructions) : generateMutation(instructions));
    } else {
      mutation = randomOnly
        ? generateRandomMutation(instructions)
        : generateMutation(instructions);
    }

    const { mutated } = applyMutation(instructions, mutation);
    await log(`Mutation: ${mutation.description}`);

    // Run the suite with mutated instructions.
    const { results: runResults, actionsMap } = await runSuite(
      testCases,
      mutated,
      adapter,
      runOpts,
    );

    printFailureDiagnostics(runResults);

    // Score.
    const { results: scoreResults, meanScore } = scoreBatch(testCases, actionsMap);

    // Update feedback for next iteration's AI mutator.
    lastScoreResults = scoreResults;
    lastMeanScore = meanScore;

    // Report.
    console.log('\n' + formatConsoleTable(scoreResults, meanScore));

    // Keep / revert decision — promote the mutated text only if it improves.
    const promoted = !dryRun && shouldPromote(ledger, meanScore);

    if (promoted) {
      ledger = await promote(targetPath, mutated, ledgerPath, meanScore);
    }

    // Always record the iteration outcome — even when not promoted.
    ledger = await recordIteration(ledgerPath, ledger, {
      iteration: i,
      score: meanScore,
      promoted,
      mutationDescription: mutation.description,
      timestamp: new Date().toISOString(),
    });

    const summary = formatSummary(meanScore, ledger.bestScore, promoted);
    await log(summary);

    // Log durations and error count.
    const totalMs = runResults.reduce((sum, r) => sum + r.durationMs, 0);
    const errorCount = runResults.filter((r) => r.error).length;
    await log(
      `Total runtime: ${(totalMs / 1000).toFixed(1)}s across ${runResults.length} case(s)` +
      (errorCount > 0 ? ` (${errorCount} errored)` : ''),
    );
  }

  await log(`\n── Run complete. Final best score: ${ledger.bestScore.toFixed(3)} ──`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  // Best-effort cleanup before exit.
  cleanupStagingFiles().finally(() => process.exit(1));
});
