// ── Test-case runner ────────────────────────────────────────────────
//
// Invokes a RuntimeAdapter with mutated instructions + a frozen test
// case prompt, collects engine events, and extracts actions for scoring.

import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from '../runtime/types.js';
import { buildPromptPreamble } from '../discord/prompt-common.js';
import {
  parseActionsForScoring,
  allActionCategoryFlags,
  discordActionsPromptSection,
} from '../discord/actions.js';
import type { FrozenTestCase, ExpectedAction, RunResult, RunnerOpts } from './types.js';

// ── Single test case ────────────────────────────────────────────────

/**
 * Run a single frozen test case through a runtime adapter.
 *
 * Builds a system prompt from the mutated instructions via
 * `buildPromptPreamble`, sends the test case's prompt as the user
 * message, accumulates text from `text_delta`/`text_final` events,
 * then parses actions for the scorer.
 */
export async function runTestCase(
  testCase: FrozenTestCase,
  instructions: string,
  adapter: RuntimeAdapter,
  opts?: RunnerOpts,
): Promise<RunResult> {
  let systemPrompt = buildPromptPreamble(instructions, { skipTrackedTools: true });

  // Inject the full Discord action schema so the model can emit actions.
  // Without this, positive tests (expecting actions) fail trivially and
  // negative tests (forbidding actions) pass vacuously.
  if (opts?.injectActionSchema !== false) {
    const actionSchema = discordActionsPromptSection(allActionCategoryFlags());
    systemPrompt += '\n\n---\n' + actionSchema;
  }

  const invokeParams: RuntimeInvokeParams = {
    prompt: testCase.prompt,
    systemPrompt,
    model: opts?.model ?? adapter.defaultModel ?? '',
    cwd: opts?.cwd ?? process.cwd(),
    timeoutMs: opts?.timeoutMs,
  };

  const events: EngineEvent[] = [];
  let text = '';
  let sawFinal = false;
  const start = Date.now();

  for await (const evt of adapter.invoke(invokeParams)) {
    events.push(evt);

    if (evt.type === 'text_delta' && !sawFinal) {
      text += evt.text;
    } else if (evt.type === 'text_final') {
      text = evt.text;
      sawFinal = true;
    }
  }

  const { actions, parseFailures } = parseActionsForScoring(text);

  return {
    testCaseId: testCase.id,
    text,
    actions,
    parseFailures,
    events,
    durationMs: Date.now() - start,
  };
}

// ── Error result factory ────────────────────────────────────────────

/** Build a RunResult representing a test case that threw. */
function errorResult(testCaseId: string, err: unknown, durationMs: number): RunResult {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  return {
    testCaseId,
    text: '',
    actions: [],
    parseFailures: 0,
    events: [],
    durationMs,
    error: message,
  };
}

// ── Suite runner ────────────────────────────────────────────────────

/**
 * Run all test cases in a suite and collect actions per case.
 *
 * Individual test case failures are captured as error results —
 * they do **not** abort the rest of the suite. The optional
 * `opts.onProgress` callback fires after each case, and
 * `opts.signal` can abort remaining work early.
 *
 * When `opts.concurrency` > 1, test cases run in parallel using a pool.
 * Results are returned in the original case order regardless of
 * execution order.
 *
 * Returns a `Map<testCaseId, ExpectedAction[]>` suitable for
 * passing directly to `scoreBatch`.
 */
export async function runSuite(
  cases: FrozenTestCase[],
  instructions: string,
  adapter: RuntimeAdapter,
  opts?: RunnerOpts,
): Promise<{ results: RunResult[]; actionsMap: Map<string, ExpectedAction[]> }> {
  const concurrency = Math.max(1, opts?.concurrency ?? 1);
  let completedCount = 0;

  /** Run a single case with error isolation and progress reporting. */
  async function safeSingle(tc: FrozenTestCase, idx: number): Promise<RunResult> {
    // Abort early if signal is already raised.
    if (opts?.signal?.aborted) {
      return errorResult(tc.id, 'Aborted', 0);
    }

    const start = Date.now();
    let result: RunResult;
    try {
      result = await runTestCase(tc, instructions, adapter, opts);
    } catch (err) {
      result = errorResult(tc.id, err, Date.now() - start);
    }

    completedCount++;
    opts?.onProgress?.({
      index: completedCount,
      total: cases.length,
      testCaseId: tc.id,
      status: result.error ? 'error' : 'pass',
      durationMs: result.durationMs,
      error: result.error,
    });

    return result;
  }

  if (concurrency <= 1 || cases.length <= 1) {
    // Sequential path.
    const results: RunResult[] = [];
    const actionsMap = new Map<string, ExpectedAction[]>();
    for (let i = 0; i < cases.length; i++) {
      if (opts?.signal?.aborted) {
        results.push(errorResult(cases[i].id, 'Aborted', 0));
        continue;
      }
      const result = await safeSingle(cases[i], i);
      results.push(result);
      actionsMap.set(cases[i].id, result.actions);
    }
    return { results, actionsMap };
  }

  // Parallel path — run up to `concurrency` cases at once.
  const resultSlots: RunResult[] = new Array(cases.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < cases.length) {
      if (opts?.signal?.aborted) break;
      const idx = nextIdx++;
      const tc = cases[idx];
      resultSlots[idx] = await safeSingle(tc, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, cases.length) }, () => worker());
  await Promise.all(workers);

  // Fill any remaining slots that were skipped due to abort.
  const actionsMap = new Map<string, ExpectedAction[]>();
  for (let i = 0; i < resultSlots.length; i++) {
    if (!resultSlots[i]) {
      resultSlots[i] = errorResult(cases[i].id, 'Aborted', 0);
    }
    actionsMap.set(resultSlots[i].testCaseId, resultSlots[i].actions);
  }

  return { results: resultSlots, actionsMap };
}
