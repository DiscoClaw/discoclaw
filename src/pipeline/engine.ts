import { execa } from 'execa';
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

export type ShellStep = {
  kind: 'shell';
  /** Optional identifier for named template references (`{{steps.<id>.output}}`). */
  id?: string;
  /** Command to execute. First element is the binary; remaining elements are arguments. */
  command: string[];
  /** Working directory override. Falls back to the pipeline-level cwd when absent. */
  cwd?: string;
  timeoutMs?: number;
  /** How to handle execution failure. Default: 'fail' (throws). */
  onError?: 'fail' | 'skip';
  /** When true, skips execution and emits a redacted progress message instead. */
  dryRun?: boolean;
  /** When true, requires confirmAllowed=true on the pipeline definition. */
  confirm?: boolean;
};

export type DiscordActionStep = {
  kind: 'discord-action';
  /** Optional identifier for named template references (`{{steps.<id>.output}}`). */
  id?: string;
  /**
   * Actions to dispatch. Static arrays may contain objects with string values that
   * support the same template variables as prompt steps. A function form is also
   * accepted; it receives full step context and must return the actions array.
   */
  actions: unknown[] | ((ctx: StepContext) => unknown[]);
  /** How to handle a failure for this step. Default: 'fail' (throws). */
  onError?: 'fail' | 'skip';
  /**
   * Executor provided by the caller. Receives the interpolated actions array and
   * returns a result entry for each action. The caller binds its own Discord
   * context at pipeline construction time, keeping the engine decoupled from
   * Discord imports.
   */
  execute: (actions: unknown[]) => Promise<Array<{ ok: boolean; summary?: string; error?: string }>>;
};

export type PipelineStep = PromptStep | ShellStep | DiscordActionStep;

export type PipelineDef = {
  steps: PipelineStep[];
  runtime: RuntimeAdapter;
  /** Working directory passed to each runtime invocation. */
  cwd: string;
  /** Default model used when a step does not specify its own model. */
  model: string;
  signal?: AbortSignal;
  /** Called after each step completes (or is skipped). Message contains the step id. */
  onProgress?: (message: string) => void;
  /** Must be true for any shell step with confirm=true to be allowed. */
  confirmAllowed?: boolean;
};

export type PipelineResult = {
  /** Text output collected from each step, in order. Skipped steps produce an empty string. */
  outputs: string[];
};

/**
 * Replace `{{prev.output}}` and `{{steps.<id>.output}}` variables in a static
 * string. Unresolvable references are returned verbatim.
 */
function interpolateTemplate(
  template: string,
  stepIndex: number,
  steps: readonly PipelineStep[],
  outputs: string[],
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (match, keyRaw: string) => {
    const key = keyRaw.trim();
    if (key === 'prev.output') {
      return stepIndex > 0 ? (outputs[stepIndex - 1] ?? '') : '';
    }
    const stepRef = /^steps\.(.+)\.output$/.exec(key);
    if (stepRef) {
      const refId = stepRef[1];
      const refIdx = steps.findIndex((s, idx) => s.id === refId && idx < stepIndex);
      if (refIdx === -1) return match; // unresolvable — leave as literal
      return outputs[refIdx] ?? match;
    }
    return match; // unrecognized pattern — leave as literal
  });
}

/**
 * Recursively walk a JSON-like value and apply `interpolateTemplate` to every
 * string leaf. Non-string primitives and `null` are returned as-is.
 */
function interpolateDeep(
  value: unknown,
  stepIndex: number,
  steps: readonly PipelineStep[],
  outputs: string[],
): unknown {
  if (typeof value === 'string') {
    return interpolateTemplate(value, stepIndex, steps, outputs);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, stepIndex, steps, outputs));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateDeep(v, stepIndex, steps, outputs);
    }
    return result;
  }
  return value;
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
 * Execute a sequence of steps where each step's text output is made
 * available as context for subsequent steps.
 */
export async function runPipeline(def: PipelineDef): Promise<PipelineResult> {
  const { steps, runtime, cwd, model, signal, onProgress, confirmAllowed } = def;
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

    // --- Shell step ---
    if (step.kind === 'shell') {
      const shellBinary = step.command[0];
      if (!shellBinary || shellBinary.trim() === '') {
        throw new Error(`Pipeline step ${i} failed: shell: command must include a non-empty executable`);
      }

      if (step.confirm && !confirmAllowed) {
        throw new Error(`Pipeline step ${i}: confirm=true requires confirmAllowed on the pipeline`);
      }

      if (step.dryRun) {
        outputs.push('');
        const argCount = step.command.length - 1;
        onProgress?.(`step ${stepId}: dry-run (${shellBinary}, ${argCount} arg${argCount !== 1 ? 's' : ''})`);
        continue;
      }

      // Interpolate template variables in command args before execution.
      const interpolatedCommand = step.command.map((arg) =>
        interpolateTemplate(arg, i, steps, outputs)
      );
      if (!interpolatedCommand[0] || interpolatedCommand[0].trim() === '') {
        throw new Error(`Pipeline step ${i} failed: shell: command resolved to an empty executable`);
      }

      let text: string;
      try {
        const result = await execa(interpolatedCommand[0], interpolatedCommand.slice(1), {
          reject: false,
          timeout: step.timeoutMs,
          cancelSignal: signal,
          cwd: step.cwd ?? cwd,
        });

        if (result.isCanceled) {
          throw new Error('shell: command canceled');
        }

        if (result.timedOut) {
          throw new Error(`shell: command timed out after ${step.timeoutMs ?? 0}ms`);
        }

        if (result.failed && result.exitCode == null) {
          throw new Error('shell: command failed to spawn');
        }

        if (result.exitCode !== 0) {
          const parts = [`shell: command exited with code ${result.exitCode}`];
          if (result.signal) parts.push(`(signal: ${result.signal})`);
          throw new Error(parts.join(' '));
        }

        text = result.stdout.trimEnd();
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
      continue;
    }

    // --- Discord action step ---
    if (step.kind === 'discord-action') {
      const resolvedActions =
        typeof step.actions === 'function' ? step.actions(ctx) : step.actions;

      const interpolatedActions = interpolateDeep(resolvedActions, i, steps, outputs) as unknown[];

      let results: Array<{ ok: boolean; summary?: string; error?: string }>;
      try {
        results = await step.execute(interpolatedActions);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          const errorMsg = failed.map((r) => r.error ?? 'action failed').join('; ');
          throw new Error(errorMsg);
        }
      } catch (err) {
        if (step.onError === 'skip') {
          outputs.push('');
          onProgress?.(`step ${stepId}: skipped`);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Pipeline step ${i} failed: ${message}`);
      }

      outputs.push(JSON.stringify(results));
      onProgress?.(`step ${stepId}: done`);
      continue;
    }

    // --- Prompt step ---
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
