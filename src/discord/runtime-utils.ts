import type { RuntimeAdapter, EngineEvent, RuntimeSupervisorPolicy } from '../runtime/types.js';
import { LoopDetector, type LoopDetectorOpts } from '../runtime/loop-detector.js';

/**
 * Collect the final text from a runtime invocation, streaming through all events.
 *
 * When `opts.requireFinalEvent` is true, throws if the stream ends without
 * a `text_final` event (distinguishes a complete response from a truncated one).
 * When `opts.requireDoneEvent` is true, throws if the stream ends without a
 * terminal `done` event (distinguishes terminal completion from non-terminal progress).
 *
 * When `opts.onEvent` is provided, each event is forwarded to it before
 * processing — used to drive live streaming preview in Discord progress messages.
 *
 * When `opts.loopDetect` is not `false`, a `LoopDetector` monitors `tool_start`
 * events for degenerate patterns (consecutive repeats, ping-pong, frequency
 * dominance). If the critical threshold is hit, the runtime stream is aborted.
 * Pass a partial `LoopDetectorOpts` to override thresholds, or `false` to disable.
 *
 * Collected output is sanitized before return to remove non-terminal
 * `[progress]` lines that should never be treated as final answer content.
 */
export async function collectRuntimeText(
  runtime: RuntimeAdapter,
  prompt: string,
  model: string,
  cwd: string,
  tools: string[],
  addDirs: string[],
  timeoutMs: number,
  opts?: {
    requireFinalEvent?: boolean;
    requireDoneEvent?: boolean;
    sessionKey?: string;
    signal?: AbortSignal;
    onEvent?: (evt: EngineEvent) => void;
    loopDetect?: false | LoopDetectorOpts;
    supervisor?: RuntimeSupervisorPolicy;
    reasoningEffort?: string;
  },
): Promise<string> {
  // --- Loop detection setup ---
  const loopEnabled = opts?.loopDetect !== false;
  const loopAc = loopEnabled ? new AbortController() : undefined;
  let loopPattern: string | undefined;

  const detector = loopEnabled
    ? new LoopDetector({
        ...(typeof opts?.loopDetect === 'object' ? opts.loopDetect : {}),
        onCritical(pattern) {
          loopPattern = pattern;
          loopAc!.abort();
        },
      })
    : undefined;

  // Compose caller signal with loop-detector signal so either can cancel.
  const callerSignal = opts?.signal;
  const combinedSignal =
    loopAc && callerSignal
      ? AbortSignal.any([callerSignal, loopAc.signal])
      : loopAc
        ? loopAc.signal
        : callerSignal;

  let text = '';
  let sawFinal = false;
  let sawDone = false;
  try {
    for await (const evt of runtime.invoke({
      prompt,
      model,
      cwd,
      tools,
      addDirs: addDirs.length > 0 ? addDirs : undefined,
      timeoutMs,
      ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(combinedSignal ? { signal: combinedSignal } : {}),
      ...(opts?.supervisor ? { supervisor: opts.supervisor } : {}),
      ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    })) {
      if (sawDone) {
        throw new Error(`Runtime stream emitted ${evt.type} event after done (done must be terminal)`);
      }

      // Feed event to loop detector before any other processing.
      detector?.onEvent(evt);

      try { opts?.onEvent?.(evt); } catch { /* UI callback errors must not abort execution */ }
      if (evt.type === 'text_final') {
        text = evt.text;
        sawFinal = true;
      } else if (evt.type === 'text_delta') {
        // Accumulate deltas only until text_final is seen.
        if (!sawFinal) text += evt.text;
      } else if (evt.type === 'done') {
        sawDone = true;
      } else if (evt.type === 'error') {
        throw new Error(`Runtime error: ${evt.message}`);
      }
    }
  } finally {
    detector?.dispose();
  }

  // If the loop detector triggered the abort, throw a descriptive error.
  if (loopPattern) {
    throw new Error(`Runtime aborted: runaway tool-calling loop detected — ${loopPattern}`);
  }

  if (opts?.requireFinalEvent && !sawFinal) {
    throw new Error('Runtime stream ended without text_final event (response may be truncated)');
  }
  if (opts?.requireDoneEvent && !sawDone) {
    throw new Error('Runtime stream ended without done event (response may be non-terminal)');
  }
  return sanitizeCollectedRuntimeText(text);
}

const NON_TERMINAL_PROGRESS_LINE_RE = /^[ \t]*\[progress\].*(?:\r?\n|$)/gim;

function sanitizeCollectedRuntimeText(text: string): string {
  return text.replace(NON_TERMINAL_PROGRESS_LINE_RE, '');
}
