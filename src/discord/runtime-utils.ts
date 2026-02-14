import type { RuntimeAdapter } from '../runtime/types.js';

/**
 * Collect the final text from a runtime invocation, streaming through all events.
 *
 * When `opts.requireFinalEvent` is true, throws if the stream ends without
 * a `text_final` event (distinguishes a complete response from a truncated one).
 */
export async function collectRuntimeText(
  runtime: RuntimeAdapter,
  prompt: string,
  model: string,
  cwd: string,
  tools: string[],
  addDirs: string[],
  timeoutMs: number,
  opts?: { requireFinalEvent?: boolean; sessionKey?: string },
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
  })) {
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
