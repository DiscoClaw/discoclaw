import { describe, expect, it } from 'vitest';

import { runPipeline } from './engine.js';
import type { PipelineParams, PromptStep, StepContext } from './engine.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  events: EngineEvent[] | ((prompt: string) => EngineEvent[]),
): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(['streaming_text']),
    async *invoke(params): AsyncIterable<EngineEvent> {
      const evts = typeof events === 'function' ? events(params.prompt) : events;
      for (const evt of evts) {
        yield evt;
      }
    },
  };
}

function step(prompt: string | PromptStep['prompt'], overrides?: Partial<PromptStep>): PromptStep {
  return { kind: 'prompt', prompt, ...overrides };
}

function baseParams(overrides?: Partial<PipelineParams>): PipelineParams {
  return {
    steps: [],
    runtime: makeRuntime([{ type: 'done' }]),
    cwd: '/tmp',
    model: 'test-model',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  it('returns empty outputs for an empty steps array', async () => {
    const result = await runPipeline(baseParams());
    expect(result.outputs).toEqual([]);
  });

  it('runs a single-step pipeline and returns output', async () => {
    const result = await runPipeline(
      baseParams({
        steps: [step('Say hello')],
        runtime: makeRuntime([{ type: 'text_final', text: 'Hello!' }, { type: 'done' }]),
      }),
    );
    expect(result.outputs).toEqual(['Hello!']);
  });

  it('accumulates text_delta events when text_final is absent', async () => {
    const result = await runPipeline(
      baseParams({
        steps: [step('prompt')],
        runtime: makeRuntime([
          { type: 'text_delta', text: 'Hello ' },
          { type: 'text_delta', text: 'world' },
          { type: 'done' },
        ]),
      }),
    );
    expect(result.outputs[0]).toBe('Hello world');
  });

  it('prefers text_final over accumulated text_delta', async () => {
    const result = await runPipeline(
      baseParams({
        steps: [step('prompt')],
        runtime: makeRuntime([
          { type: 'text_delta', text: 'partial' },
          { type: 'text_final', text: 'final text' },
          { type: 'done' },
        ]),
      }),
    );
    expect(result.outputs[0]).toBe('final text');
  });

  it('feeds previous step output into next step as previousOutput', async () => {
    const capturedPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: 'text_final', text: `out:${params.prompt}` };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('first'),
          step((ctx: StepContext) => `second prev="${ctx.previousOutput}"`),
        ],
        runtime,
      }),
    );

    expect(capturedPrompts[1]).toBe('second prev="out:first"');
  });

  it('provides allOutputs from all preceding steps to dynamic prompts', async () => {
    let capturedCtx: StepContext | undefined;
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: `r:${params.prompt}` };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('a'),
          step('b'),
          step((ctx: StepContext) => {
            capturedCtx = { ...ctx, allOutputs: [...ctx.allOutputs] };
            return 'c';
          }),
        ],
        runtime,
      }),
    );

    expect(capturedCtx?.stepIndex).toBe(2);
    expect(capturedCtx?.previousOutput).toBe('r:b');
    expect(capturedCtx?.allOutputs).toEqual(['r:a', 'r:b']);
  });

  it('uses step-level model override instead of pipeline model', async () => {
    const usedModels: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        usedModels.push(params.model);
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('first'),
          step('second', { model: 'override-model' }),
        ],
        runtime,
        model: 'default-model',
      }),
    );

    expect(usedModels[0]).toBe('default-model');
    expect(usedModels[1]).toBe('override-model');
  });

  it('throws with step index on runtime error event', async () => {
    await expect(
      runPipeline(
        baseParams({
          steps: [step('bad')],
          runtime: makeRuntime([{ type: 'error', message: 'boom' }]),
        }),
      ),
    ).rejects.toThrow('Pipeline step 0 failed: boom');
  });

  it('includes the correct step index in the error message for later steps', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        if (params.prompt === 'bad') {
          yield { type: 'error', message: 'oops' };
        } else {
          yield { type: 'text_final', text: 'ok' };
          yield { type: 'done' };
        }
      },
    };

    await expect(
      runPipeline(
        baseParams({
          steps: [step('good'), step('bad')],
          runtime,
        }),
      ),
    ).rejects.toThrow('Pipeline step 1 failed: oops');
  });

  it('skips all steps when signal is already aborted', async () => {
    const invoked: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        invoked.push(params.prompt);
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    const controller = new AbortController();
    controller.abort();

    const result = await runPipeline(
      baseParams({
        steps: [step('step-one'), step('step-two')],
        runtime,
        signal: controller.signal,
      }),
    );

    expect(invoked).toHaveLength(0);
    expect(result.outputs).toEqual([]);
  });

  it('stops between steps when signal is aborted after the first step', async () => {
    const controller = new AbortController();
    const invoked: string[] = [];

    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        invoked.push(params.prompt);
        if (params.prompt === 'first') controller.abort();
        yield { type: 'text_final', text: `out:${params.prompt}` };
        yield { type: 'done' };
      },
    };

    const result = await runPipeline(
      baseParams({
        steps: [step('first'), step('second')],
        runtime,
        signal: controller.signal,
      }),
    );

    // First step ran; second was skipped because signal was aborted between steps.
    expect(invoked).toEqual(['first']);
    expect(result.outputs).toEqual(['out:first']);
  });

  it('passes step-level tools and addDirs to runtime', async () => {
    const capturedParams: Array<{ tools?: string[]; addDirs?: string[] }> = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedParams.push({ tools: params.tools, addDirs: params.addDirs });
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [step('go', { tools: ['Read', 'Glob'], addDirs: ['/workspace'] })],
        runtime,
      }),
    );

    expect(capturedParams[0].tools).toEqual(['Read', 'Glob']);
    expect(capturedParams[0].addDirs).toEqual(['/workspace']);
  });
});
