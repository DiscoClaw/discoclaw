import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runPipeline } from './engine.js';
import type { PipelineDef, PromptStep, ShellStep, DiscordActionStep, StepContext } from './engine.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

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

function baseParams(overrides?: Partial<PipelineDef>): PipelineDef {
  return {
    steps: [],
    runtime: makeRuntime([{ type: 'done' }]),
    cwd: '/tmp',
    model: 'test-model',
    ...overrides,
  };
}

function makeExecaResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    failed: false,
    timedOut: false,
    isCanceled: false,
    signal: undefined,
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

  it('interpolates {{prev.output}} in a static prompt string', async () => {
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
        steps: [step('first'), step('second prev="{{prev.output}}"')],
        runtime,
      }),
    );

    expect(capturedPrompts[1]).toBe('second prev="out:first"');
  });

  it('interpolates {{steps.<id>.output}} for named step references', async () => {
    const capturedPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: 'text_final', text: `r:${params.prompt}` };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('alpha', { id: 'step1' }),
          step('beta'),
          step('result={{steps.step1.output}}'),
        ],
        runtime,
      }),
    );

    expect(capturedPrompts[2]).toBe('result=r:alpha');
  });

  it('interpolates {{steps.<id>.output}} when step id contains hyphens', async () => {
    const capturedPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: 'text_final', text: `r:${params.prompt}` };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('artifact', { id: 'build-artifact' }),
          step('deploy={{steps.build-artifact.output}}'),
        ],
        runtime,
      }),
    );

    expect(capturedPrompts[1]).toBe('deploy=r:artifact');
  });

  it('leaves unresolvable {{steps.nonexistent.output}} as literal text', async () => {
    const capturedPrompts: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [step('ref={{steps.nonexistent.output}}')],
        runtime,
      }),
    );

    expect(capturedPrompts[0]).toBe('ref={{steps.nonexistent.output}}');
  });

  it('feeds previous step output into next step via callback prompt', async () => {
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

  it('provides allOutputs from all preceding steps to callback prompts', async () => {
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

  it('uses step-level runtime override instead of pipeline runtime', async () => {
    const pipelineInvoked: string[] = [];
    const stepInvoked: string[] = [];

    const pipelineRuntime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        pipelineInvoked.push(params.prompt);
        yield { type: 'text_final', text: 'from-pipeline' };
        yield { type: 'done' };
      },
    };

    const stepRuntime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        stepInvoked.push(params.prompt);
        yield { type: 'text_final', text: 'from-step' };
        yield { type: 'done' };
      },
    };

    const result = await runPipeline(
      baseParams({
        steps: [
          step('first'),
          step('second', { runtime: stepRuntime }),
        ],
        runtime: pipelineRuntime,
      }),
    );

    expect(pipelineInvoked).toEqual(['first']);
    expect(stepInvoked).toEqual(['second']);
    expect(result.outputs[1]).toBe('from-step');
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

  it('onError skip: middle step fails and subsequent step still runs', async () => {
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        if (params.prompt === 'bad') {
          yield { type: 'error', message: 'boom' };
        } else {
          yield { type: 'text_final', text: `ok:${params.prompt}` };
          yield { type: 'done' };
        }
      },
    };

    const result = await runPipeline(
      baseParams({
        steps: [
          step('first'),
          step('bad', { onError: 'skip' }),
          step('third'),
        ],
        runtime,
      }),
    );

    expect(result.outputs).toEqual(['ok:first', '', 'ok:third']);
  });

  it('rejects duplicate step IDs before running any steps', async () => {
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

    await expect(
      runPipeline(
        baseParams({
          steps: [
            step('first', { id: 'dup' }),
            step('second', { id: 'dup' }),
          ],
          runtime,
        }),
      ),
    ).rejects.toThrow('Duplicate step ID: "dup"');

    expect(invoked).toHaveLength(0);
  });

  it('calls onProgress once per step with the step id in the message', async () => {
    const messages: string[] = [];

    await runPipeline(
      baseParams({
        steps: [
          step('hello', { id: 'alpha' }),
          step('world', { id: 'beta' }),
        ],
        runtime: makeRuntime([{ type: 'text_final', text: 'done' }, { type: 'done' }]),
        onProgress: (msg) => messages.push(msg),
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('alpha');
    expect(messages[1]).toContain('beta');
  });

  it('onProgress is called for skipped steps as well', async () => {
    const messages: string[] = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        if (params.prompt === 'bad') {
          yield { type: 'error', message: 'boom' };
        } else {
          yield { type: 'text_final', text: 'ok' };
          yield { type: 'done' };
        }
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('good', { id: 'step-ok' }),
          step('bad', { id: 'step-err', onError: 'skip' }),
        ],
        runtime,
        onProgress: (msg) => messages.push(msg),
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('step-ok');
    expect(messages[1]).toContain('step-err');
  });

  it('forwards step-level timeoutMs to runtime invoke params', async () => {
    const capturedTimeouts: Array<number | undefined> = [];
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        capturedTimeouts.push(params.timeoutMs);
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    await runPipeline(
      baseParams({
        steps: [
          step('first'),
          step('second', { timeoutMs: 5000 }),
        ],
        runtime,
      }),
    );

    expect(capturedTimeouts[0]).toBeUndefined();
    expect(capturedTimeouts[1]).toBe(5000);
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

  // ---------------------------------------------------------------------------
  // Shell step tests
  // ---------------------------------------------------------------------------

  describe('shell steps', () => {
    beforeEach(() => {
      vi.mocked(execa).mockReset();
    });

    function shellStep(command: string[], overrides?: Partial<ShellStep>): ShellStep {
      return { kind: 'shell', command, ...overrides };
    }

    it('runs a shell command and captures trimmed stdout as output', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: 'hello\n' }) as any);

      const result = await runPipeline(baseParams({ steps: [shellStep(['echo', 'hello'])] }));

      expect(result.outputs).toEqual(['hello']);
    });

    it('passes command array and options to execa', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: 'out' }) as any);

      await runPipeline(
        baseParams({
          steps: [shellStep(['ls', '-la'], { timeoutMs: 3000 })],
          cwd: '/project',
        }),
      );

      expect(vi.mocked(execa)).toHaveBeenCalledWith(
        'ls',
        ['-la'],
        expect.objectContaining({ reject: false, timeout: 3000, cwd: '/project' }),
      );
    });

    it('uses step-level cwd override instead of pipeline cwd', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: '' }) as any);

      await runPipeline(
        baseParams({
          steps: [shellStep(['pwd'], { cwd: '/override' })],
          cwd: '/pipeline',
        }),
      );

      expect(vi.mocked(execa)).toHaveBeenCalledWith(
        'pwd',
        [],
        expect.objectContaining({ cwd: '/override' }),
      );
    });

    it('falls back to pipeline cwd when step cwd is absent', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: '' }) as any);

      await runPipeline(
        baseParams({
          steps: [shellStep(['pwd'])],
          cwd: '/pipeline',
        }),
      );

      expect(vi.mocked(execa)).toHaveBeenCalledWith(
        'pwd',
        [],
        expect.objectContaining({ cwd: '/pipeline' }),
      );
    });

    it('dryRun skips execution and emits a redacted progress message', async () => {
      const messages: string[] = [];

      const result = await runPipeline(
        baseParams({
          steps: [shellStep(['rm', '-rf', '/data'], { dryRun: true, id: 'cleanup' })],
          onProgress: (msg) => messages.push(msg),
        }),
      );

      expect(vi.mocked(execa)).not.toHaveBeenCalled();
      expect(result.outputs).toEqual(['']);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('cleanup');
      expect(messages[0]).toContain('rm');
      // Must not contain any arg values
      expect(messages[0]).not.toContain('-rf');
      expect(messages[0]).not.toContain('/data');
    });

    it('dryRun message includes binary name and arg count', async () => {
      const messages: string[] = [];

      await runPipeline(
        baseParams({
          steps: [shellStep(['git', 'commit', '-m', 'msg'], { dryRun: true })],
          onProgress: (msg) => messages.push(msg),
        }),
      );

      expect(messages[0]).toContain('git');
      expect(messages[0]).toContain('3'); // 3 args
    });

    it('throws a validation error when shell command executable is missing', async () => {
      await expect(
        runPipeline(baseParams({ steps: [shellStep([])] })),
      ).rejects.toThrow('command must include a non-empty executable');

      expect(vi.mocked(execa)).not.toHaveBeenCalled();
    });

    it('throws a validation error when interpolated executable resolves to empty', async () => {
      await expect(
        runPipeline(
          baseParams({
            steps: [
              step(''),
              shellStep(['{{prev.output}}']),
            ],
            runtime: makeRuntime([{ type: 'text_final', text: '' }, { type: 'done' }]),
          }),
        ),
      ).rejects.toThrow('command resolved to an empty executable');

      expect(vi.mocked(execa)).not.toHaveBeenCalled();
    });

    it('confirm=true without confirmAllowed throws before execution', async () => {
      await expect(
        runPipeline(
          baseParams({
            steps: [shellStep(['rm', '-rf', '/'], { confirm: true })],
          }),
        ),
      ).rejects.toThrow('confirm=true requires confirmAllowed');

      expect(vi.mocked(execa)).not.toHaveBeenCalled();
    });

    it('confirm=true with confirmAllowed=true allows execution', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: 'ok' }) as any);

      const result = await runPipeline(
        baseParams({
          steps: [shellStep(['echo', 'ok'], { confirm: true })],
          confirmAllowed: true,
        }),
      );

      expect(result.outputs).toEqual(['ok']);
    });

    it('throws a sanitized timeout error without exposing command args', async () => {
      vi.mocked(execa).mockResolvedValue(
        makeExecaResult({ timedOut: true, failed: true }) as any,
      );

      await expect(
        runPipeline(
          baseParams({
            steps: [shellStep(['sleep', '999'], { timeoutMs: 100 })],
          }),
        ),
      ).rejects.toThrow('timed out after 100ms');
    });

    it('throws a sanitized spawn-failure error', async () => {
      vi.mocked(execa).mockResolvedValue(
        makeExecaResult({ failed: true, exitCode: null }) as any,
      );

      await expect(
        runPipeline(baseParams({ steps: [shellStep(['nonexistent_binary_xyz'])] })),
      ).rejects.toThrow('failed to spawn');
    });

    it('throws a sanitized non-zero exit error with exit code', async () => {
      vi.mocked(execa).mockResolvedValue(
        makeExecaResult({ exitCode: 2, failed: true }) as any,
      );

      await expect(
        runPipeline(baseParams({ steps: [shellStep(['false'])] })),
      ).rejects.toThrow('exited with code 2');
    });

    it('includes signal name in non-zero exit error when signal is present', async () => {
      vi.mocked(execa).mockResolvedValue(
        makeExecaResult({ exitCode: 1, failed: true, signal: 'SIGTERM' }) as any,
      );

      await expect(
        runPipeline(baseParams({ steps: [shellStep(['cmd'])] })),
      ).rejects.toThrow('signal: SIGTERM');
    });

    it('throws a sanitized canceled error', async () => {
      vi.mocked(execa).mockResolvedValue(
        makeExecaResult({ isCanceled: true, failed: true, exitCode: null }) as any,
      );

      await expect(
        runPipeline(baseParams({ steps: [shellStep(['sleep', '10'])] })),
      ).rejects.toThrow('canceled');
    });

    it('onError skip: failed shell step is skipped and pipeline continues', async () => {
      vi.mocked(execa)
        .mockResolvedValueOnce(makeExecaResult({ exitCode: 1, failed: true }) as any)
        .mockResolvedValueOnce(makeExecaResult({ stdout: 'second-ok' }) as any);

      const result = await runPipeline(
        baseParams({
          steps: [
            shellStep(['false'], { onError: 'skip' }),
            shellStep(['echo', 'second']),
          ],
        }),
      );

      expect(result.outputs).toEqual(['', 'second-ok']);
    });

    it('interpolates {{prev.output}} in command args before execution', async () => {
      vi.mocked(execa)
        .mockResolvedValueOnce(makeExecaResult({ stdout: 'step-one-result' }) as any)
        .mockResolvedValueOnce(makeExecaResult({ stdout: '' }) as any);

      await runPipeline(
        baseParams({
          steps: [
            shellStep(['echo', 'step-one-result']),
            shellStep(['process', '{{prev.output}}']),
          ],
        }),
      );

      expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
        2,
        'process',
        ['step-one-result'],
        expect.anything(),
      );
    });

    it('interpolates {{steps.<id>.output}} in command args', async () => {
      vi.mocked(execa)
        .mockResolvedValueOnce(makeExecaResult({ stdout: 'artifact' }) as any)
        .mockResolvedValueOnce(makeExecaResult({ stdout: '' }) as any)
        .mockResolvedValueOnce(makeExecaResult({ stdout: '' }) as any);

      await runPipeline(
        baseParams({
          steps: [
            shellStep(['echo', 'artifact'], { id: 'build' }),
            shellStep(['noop']),
            shellStep(['deploy', '{{steps.build.output}}']),
          ],
        }),
      );

      expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
        3,
        'deploy',
        ['artifact'],
        expect.anything(),
      );
    });

    it('shell step output is available to subsequent prompt steps via {{prev.output}}', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: 'shell-result' }) as any);

      const capturedPrompts: string[] = [];
      const runtime: RuntimeAdapter = {
        id: 'other',
        capabilities: new Set(['streaming_text']),
        async *invoke(params): AsyncIterable<EngineEvent> {
          capturedPrompts.push(params.prompt);
          yield { type: 'text_final', text: 'done' };
          yield { type: 'done' };
        },
      };

      await runPipeline(
        baseParams({
          steps: [
            shellStep(['get-data']),
            step('summarize: {{prev.output}}'),
          ],
          runtime,
        }),
      );

      expect(capturedPrompts[0]).toBe('summarize: shell-result');
    });

    it('calls onProgress with step id after successful shell step', async () => {
      vi.mocked(execa).mockResolvedValue(makeExecaResult({ stdout: '' }) as any);
      const messages: string[] = [];

      await runPipeline(
        baseParams({
          steps: [shellStep(['true'], { id: 'my-step' })],
          onProgress: (msg) => messages.push(msg),
        }),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('my-step');
    });

    it('error message wraps failure with step index', async () => {
      vi.mocked(execa)
        .mockResolvedValueOnce(makeExecaResult({ stdout: 'ok' }) as any)
        .mockResolvedValueOnce(makeExecaResult({ exitCode: 1, failed: true }) as any);

      await expect(
        runPipeline(
          baseParams({
            steps: [
              shellStep(['echo', 'first']),
              shellStep(['false']),
            ],
          }),
        ),
      ).rejects.toThrow('Pipeline step 1 failed:');
    });
  });

  // ---------------------------------------------------------------------------
  // Discord action step tests
  // ---------------------------------------------------------------------------

  describe('discord-action steps', () => {
    function discordStep(
      actions: DiscordActionStep['actions'],
      overrides?: Partial<Omit<DiscordActionStep, 'kind' | 'actions'>>,
    ): DiscordActionStep {
      return {
        kind: 'discord-action',
        actions,
        execute: vi.fn().mockResolvedValue([{ ok: true, summary: 'done' }]),
        ...overrides,
      };
    }

    it('runs execute and stores JSON-serialized results as output', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: true, summary: 'sent' }]);

      const result = await runPipeline(
        baseParams({
          steps: [discordStep([{ type: 'sendMessage', content: 'hello' }], { execute })],
        }),
      );

      expect(execute).toHaveBeenCalledWith([{ type: 'sendMessage', content: 'hello' }]);
      expect(result.outputs).toEqual([JSON.stringify([{ ok: true, summary: 'sent' }])]);
    });

    it('resolves actions callback with step context', async () => {
      let capturedCtx: StepContext | undefined;
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [
            step('first'),
            discordStep(
              (ctx: StepContext) => {
                capturedCtx = ctx;
                return [{ type: 'sendMessage', content: ctx.previousOutput }];
              },
              { execute },
            ),
          ],
          runtime: makeRuntime([{ type: 'text_final', text: 'hello' }, { type: 'done' }]),
        }),
      );

      expect(capturedCtx?.stepIndex).toBe(1);
      expect(capturedCtx?.previousOutput).toBe('hello');
      expect(execute).toHaveBeenCalledWith([{ type: 'sendMessage', content: 'hello' }]);
    });

    it('interpolates {{prev.output}} in action string values', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [
            step('world'),
            discordStep([{ type: 'sendMessage', content: 'hello {{prev.output}}' }], { execute }),
          ],
          runtime: makeRuntime([{ type: 'text_final', text: 'world' }, { type: 'done' }]),
        }),
      );

      expect(execute).toHaveBeenCalledWith([{ type: 'sendMessage', content: 'hello world' }]);
    });

    it('interpolates {{steps.<id>.output}} in action string values', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [
            step('ref-value', { id: 'src' }),
            step('ignored'),
            discordStep([{ type: 'taskUpdate', note: '{{steps.src.output}}' }], { execute }),
          ],
          runtime: makeRuntime([{ type: 'text_final', text: 'ref-value' }, { type: 'done' }]),
        }),
      );

      expect(execute).toHaveBeenCalledWith([{ type: 'taskUpdate', note: 'ref-value' }]);
    });

    it('interpolates string values inside nested objects and arrays', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [
            step('v'),
            discordStep(
              [{ type: 'taskUpdate', nested: { key: '{{prev.output}}' }, tags: ['tag-{{prev.output}}'] }],
              { execute },
            ),
          ],
          runtime: makeRuntime([{ type: 'text_final', text: 'v' }, { type: 'done' }]),
        }),
      );

      expect(execute).toHaveBeenCalledWith([
        { type: 'taskUpdate', nested: { key: 'v' }, tags: ['tag-v'] },
      ]);
    });

    it('throws when any result entry has ok: false', async () => {
      const execute = vi.fn().mockResolvedValue([
        { ok: true },
        { ok: false, error: 'channel not found' },
      ]);

      await expect(
        runPipeline(
          baseParams({
            steps: [discordStep([{ type: 'react' }, { type: 'sendMessage' }], { execute })],
          }),
        ),
      ).rejects.toThrow('channel not found');
    });

    it('wraps failure with Pipeline step index', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: false, error: 'boom' }]);

      await expect(
        runPipeline(
          baseParams({
            steps: [discordStep([], { execute })],
          }),
        ),
      ).rejects.toThrow('Pipeline step 0 failed: boom');
    });

    it('onError skip: failed discord-action step is skipped and pipeline continues', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: false, error: 'boom' }]);

      const result = await runPipeline(
        baseParams({
          steps: [
            discordStep([], { execute, onError: 'skip' }),
            step('next'),
          ],
          runtime: makeRuntime([{ type: 'text_final', text: 'ok' }, { type: 'done' }]),
        }),
      );

      expect(result.outputs).toEqual(['', 'ok']);
    });

    it('calls onProgress after successful discord-action step', async () => {
      const messages: string[] = [];
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [discordStep([], { id: 'notify', execute })],
          onProgress: (msg) => messages.push(msg),
        }),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('notify');
    });

    it('calls onProgress for skipped discord-action step', async () => {
      const messages: string[] = [];
      const execute = vi.fn().mockResolvedValue([{ ok: false, error: 'err' }]);

      await runPipeline(
        baseParams({
          steps: [discordStep([], { id: 'skipped-step', execute, onError: 'skip' })],
          onProgress: (msg) => messages.push(msg),
        }),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('skipped-step');
    });

    it('non-string leaves in action objects are passed through unchanged', async () => {
      const execute = vi.fn().mockResolvedValue([{ ok: true }]);

      await runPipeline(
        baseParams({
          steps: [discordStep([{ type: 'react', count: 42, active: true, data: null }], { execute })],
        }),
      );

      expect(execute).toHaveBeenCalledWith([{ type: 'react', count: 42, active: true, data: null }]);
    });
  });
});
