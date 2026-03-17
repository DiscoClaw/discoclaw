// ── Test-case runner ────────────────────────────────────────────────
//
// Invokes a RuntimeAdapter with mutated instructions + a frozen test
// case prompt, collects engine events, and extracts actions for scoring.

import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from '../runtime/types.js';
import { buildPromptPreamble } from '../discord/prompt-common.js';
import { parseActionsForScoring } from '../discord/actions.js';
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
  const systemPrompt = buildPromptPreamble(instructions, { skipTrackedTools: true });

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

// ── Suite runner ────────────────────────────────────────────────────

/**
 * Run all test cases in a suite and collect actions per case.
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
  const results: RunResult[] = [];
  const actionsMap = new Map<string, ExpectedAction[]>();

  for (const tc of cases) {
    const result = await runTestCase(tc, instructions, adapter, opts);
    results.push(result);
    actionsMap.set(tc.id, result.actions);
  }

  return { results, actionsMap };
}
