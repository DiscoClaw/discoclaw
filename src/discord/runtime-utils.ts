import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';
import { LoopDetector, type LoopDetectorOpts } from '../runtime/loop-detector.js';

/**
 * Collect the final text from a runtime invocation, streaming through all events.
 *
 * When `opts.requireFinalEvent` is true, throws if the stream ends without
 * a `text_final` event (distinguishes a complete response from a truncated one).
 *
 * When `opts.onEvent` is provided, each event is forwarded to it before
 * processing — used to drive live streaming preview in Discord progress messages.
 *
 * When `opts.loopDetect` is not `false`, a `LoopDetector` monitors `tool_start`
 * events for degenerate patterns (consecutive repeats, ping-pong, frequency
 * dominance). If the critical threshold is hit, the runtime stream is aborted.
 * Pass a partial `LoopDetectorOpts` to override thresholds, or `false` to disable.
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
    sessionKey?: string;
    signal?: AbortSignal;
    onEvent?: (evt: EngineEvent) => void;
    loopDetect?: false | LoopDetectorOpts;
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
    })) {
      // Feed event to loop detector before any other processing.
      detector?.onEvent(evt);

      try { opts?.onEvent?.(evt); } catch { /* UI callback errors must not abort execution */ }
      if (evt.type === 'text_final') {
        text = evt.text;
        sawFinal = true;
      } else if (evt.type === 'text_delta') {
        // Accumulate deltas in case text_final isn't emitted
        text += evt.text;
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
  return text;
}
