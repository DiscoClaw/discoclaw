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
  /** Static prompt string, or a function that receives context from previous steps. */
  prompt: string | ((ctx: StepContext) => string);
  model?: string;
  tools?: string[];
  addDirs?: string[];
  timeoutMs?: number;
  sessionId?: string | null;
  sessionKey?: string | null;
};

/** Union of step kinds — only 'prompt' in this first iteration. */
export type PipelineStep = PromptStep;

export type PipelineParams = {
  steps: PipelineStep[];
  runtime: RuntimeAdapter;
  /** Working directory passed to each runtime invocation. */
  cwd: string;
  /** Default model used when a step does not specify its own model. */
  model: string;
  signal?: AbortSignal;
};

export type PipelineResult = {
  /** Text output collected from each step, in order. */
  outputs: string[];
};

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
export async function runPipeline(params: PipelineParams): Promise<PipelineResult> {
  const { steps, runtime, cwd, model, signal } = params;
  const outputs: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) break;

    const step = steps[i];
    const ctx: StepContext = {
      stepIndex: i,
      previousOutput: outputs.length > 0 ? outputs[outputs.length - 1] : '',
      allOutputs: outputs,
    };

    const resolvedPrompt = typeof step.prompt === 'function' ? step.prompt(ctx) : step.prompt;

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
      text = await collectText(runtime.invoke(invokeParams), signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Pipeline step ${i} failed: ${message}`);
    }

    outputs.push(text);
  }

  return { outputs };
}
