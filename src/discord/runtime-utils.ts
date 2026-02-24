import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';
import { matchesDestructivePattern } from '../runtime/tool-call-gate.js';

/**
 * Collect the final text from a runtime invocation, streaming through all events.
 *
 * When `opts.requireFinalEvent` is true, throws if the stream ends without
 * a `text_final` event (distinguishes a complete response from a truncated one).
 *
 * When `opts.onEvent` is provided, each event is forwarded to it before
 * processing — used to drive live streaming preview in Discord progress messages.
 *
 * When `opts.toolCallGate` is true, each `tool_start` event is checked against
 * the destructive-pattern registry. A match throws immediately, halting the
 * current phase so the orchestration loop stops before the next phase begins.
 */
export async function collectRuntimeText(
  runtime: RuntimeAdapter,
  prompt: string,
  model: string,
  cwd: string,
  tools: string[],
  addDirs: string[],
  timeoutMs: number,
  opts?: { requireFinalEvent?: boolean; sessionKey?: string; signal?: AbortSignal; onEvent?: (evt: EngineEvent) => void; toolCallGate?: boolean },
): Promise<string> {
  let text = '';
  let sawFinal = false;
  for await (const evt of runtime.invoke({
    prompt,
    model,
    cwd,
    tools,
    addDirs: addDirs.length > 0 ? addDirs : undefined,
    timeoutMs,
    ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })) {
    try { opts?.onEvent?.(evt); } catch { /* UI callback errors must not abort execution */ }
    if (opts?.toolCallGate && evt.type === 'tool_start') {
      const { matched, reason } = matchesDestructivePattern(evt.name, evt.input);
      if (matched) {
        throw new Error(`Destructive tool call blocked by safety gate: ${reason}`);
      }
    }
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
  if (opts?.requireFinalEvent && !sawFinal) {
    throw new Error('Runtime stream ended without text_final event (response may be truncated)');
  }
  return text;
}
