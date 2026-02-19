import type { RuntimeAdapter, RuntimeInvokeParams, EngineEvent } from '../runtime/types.js';

export type StepContext = {
  stepIndex: number;
  /** Text output from the immediately preceding step, or empty string for the first step. */
  previousOutput: string;
  /** Text outputs from all preceding steps, in order. Empty for the first step. */
  allOutputs: readonly string[];
};

export type PromptStep = {
  kind: 'prompt';
  /** Optional identifier for named template references (`{{steps.<id>.output}}`). */
  id?: string;
  /**
   * Prompt to send to the runtime. Static strings may contain template variables:
   * - `{{prev.output}}` — output from the immediately preceding step.
   * - `{{steps.<id>.output}}` — output from the step with the given id.
   * Unresolvable references are left as-is (literal text).
   * A function form is also accepted; it receives full step context.
   */
  prompt: string | ((ctx: StepContext) => string);
  /** How to handle a runtime error for this step. Default: 'fail' (throws). */
  onError?: 'fail' | 'skip';
  /** Per-step runtime override. Uses the pipeline-level runtime when absent. */
  runtime?: RuntimeAdapter;
  model?: string;
  tools?: string[];
  addDirs?: string[];
  timeoutMs?: number;
  sessionId?: string | null;
  sessionKey?: string | null;
};

export type PipelineDef = {
  steps: PromptStep[];
  runtime: RuntimeAdapter;
  /** Working directory passed to each runtime invocation. */
  cwd: string;
  /** Default model used when a step does not specify its own model. */
  model: string;
  signal?: AbortSignal;
  /** Called after each step completes (or is skipped). Message contains the step id. */
  onProgress?: (message: string) => void;
};

export type PipelineResult = {
  /** Text output collected from each step, in order. Skipped steps produce an empty string. */
  outputs: string[];
};

/**
 * Replace `{{prev.output}}` and `{{steps.<id>.output}}` variables in a static
 * prompt string. Unresolvable references are returned verbatim.
 */
function interpolateTemplate(
  template: string,
  stepIndex: number,
  steps: readonly PromptStep[],
  outputs: string[],
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, key: string) => {
    if (key === 'prev.output') {
      return stepIndex > 0 ? (outputs[stepIndex - 1] ?? '') : '';
    }
    const stepRef = /^steps\.(\w+)\.output$/.exec(key);
    if (stepRef) {
      const refId = stepRef[1];
      const refIdx = steps.findIndex((s, idx) => s.id === refId && idx < stepIndex);
      if (refIdx === -1) return match; // unresolvable — leave as literal
      return outputs[refIdx] ?? match;
    }
    return match; // unrecognized pattern — leave as literal
  });
}

/** Drain a runtime event stream, collecting final text. Throws on error events. */
async function collectText(events: AsyncIterable<EngineEvent>, signal?: AbortSignal): Promise<string> {
  let finalText = '';
  let deltaText = '';
  for await (const evt of events) {
    if (evt.type === 'text_final') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      throw new Error(evt.message);
    }
    // Check abort after processing the current event so we don't discard it.
    if (signal?.aborted) break;
  }
  return finalText || deltaText;
}

/**
 * Execute a sequence of prompt steps where each step's text output is made
 * available as context for the next step's prompt.
 */
export async function runPipeline(def: PipelineDef): Promise<PipelineResult> {
  const { steps, runtime, cwd, model, signal, onProgress } = def;
  const outputs: string[] = [];

  // Validate step IDs — duplicates are rejected up-front.
  const seenIds = new Set<string>();
  for (const s of steps) {
    if (s.id !== undefined) {
      if (seenIds.has(s.id)) throw new Error(`Duplicate step ID: "${s.id}"`);
      seenIds.add(s.id);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) break;

    const step = steps[i];
    const stepId = step.id ?? String(i);
    const ctx: StepContext = {
      stepIndex: i,
      previousOutput: outputs.length > 0 ? outputs[outputs.length - 1] : '',
      allOutputs: outputs,
    };

    const resolvedPrompt =
      typeof step.prompt === 'function'
        ? step.prompt(ctx)
        : interpolateTemplate(step.prompt, i, steps, outputs);

    const stepRuntime = step.runtime ?? runtime;

    const invokeParams: RuntimeInvokeParams = {
      prompt: resolvedPrompt,
      model: step.model ?? model,
      cwd,
      signal,
      ...(step.tools !== undefined && { tools: step.tools }),
      ...(step.addDirs !== undefined && { addDirs: step.addDirs }),
      ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
      ...(step.sessionId !== undefined && { sessionId: step.sessionId }),
      ...(step.sessionKey !== undefined && { sessionKey: step.sessionKey }),
    };

    let text: string;
    try {
      text = await collectText(stepRuntime.invoke(invokeParams), signal);
    } catch (err) {
      if (step.onError === 'skip') {
        outputs.push('');
        onProgress?.(`step ${stepId}: skipped`);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Pipeline step ${i} failed: ${message}`);
    }

    outputs.push(text);
    onProgress?.(`step ${stepId}: done`);
  }

  return { outputs };
}
