import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapterStrategy } from './cli-strategy.js';
import { normalizeRuntimeFailure } from './runtime-failure.js';
import type { EngineEvent } from './types.js';

const mockExeca = vi.fn();
vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

const { createCliRuntime } = await import('./cli-adapter.js');

type StreamListener = (...args: unknown[]) => void;

type MockStream = {
  on: (event: string, cb: StreamListener) => MockStream;
  emit: (event: string, ...args: unknown[]) => void;
};

function createMockStream(): MockStream {
  const listeners = new Map<string, StreamListener[]>();
  return {
    on(event: string, cb: StreamListener): MockStream {
      const current = listeners.get(event) ?? [];
      current.push(cb);
      listeners.set(event, current);
      return this;
    },
    emit(event: string, ...args: unknown[]): void {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

function createMockSubprocess(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  failed?: boolean;
  timedOut?: boolean;
  rejectWith?: unknown;
}) {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const stdin = { write: vi.fn(), end: vi.fn() };

  let resolveProc!: (value: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
  }) => void;
  let rejectProc!: (reason: unknown) => void;
  const completion = new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
  }>((resolve, reject) => {
    resolveProc = resolve;
    rejectProc = reject;
  });

  const subprocess = Object.assign(completion, {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    kill: vi.fn(),
  });

  queueMicrotask(() => {
    for (const chunk of opts.stdoutChunks ?? []) stdout.emit('data', Buffer.from(chunk));
    for (const chunk of opts.stderrChunks ?? []) stderr.emit('data', Buffer.from(chunk));
    stdout.emit('end');
    stderr.emit('end');

    if (opts.rejectWith !== undefined) {
      rejectProc(opts.rejectWith);
      return;
    }

    const stdoutJoined = (opts.stdoutChunks ?? []).join('');
    const stderrJoined = (opts.stderrChunks ?? []).join('');
    const exitCode = opts.exitCode ?? 0;
    resolveProc({
      exitCode,
      stdout: stdoutJoined,
      stderr: stderrJoined,
      failed: opts.failed ?? exitCode !== 0,
      timedOut: opts.timedOut ?? false,
    });
  });

  return subprocess;
}

function createControlledSubprocess() {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const stdin = { write: vi.fn(), end: vi.fn() };

  let resolveProc!: (value: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
  }) => void;
  let rejectProc!: (reason: unknown) => void;
  const completion = new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
  }>((resolve, reject) => {
    resolveProc = resolve;
    rejectProc = reject;
  });

  let stdoutText = '';
  let stderrText = '';
  let stdoutClosed = false;
  let stderrClosed = false;
  const endStreams = () => {
    if (!stdoutClosed) {
      stdoutClosed = true;
      stdout.emit('end');
    }
    if (!stderrClosed) {
      stderrClosed = true;
      stderr.emit('end');
    }
  };

  const subprocess = Object.assign(completion, {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    kill: vi.fn(),
  });

  return {
    subprocess,
    emitStdout(chunk: string): void {
      stdoutText += chunk;
      stdout.emit('data', Buffer.from(chunk));
    },
    emitStderr(chunk: string): void {
      stderrText += chunk;
      stderr.emit('data', Buffer.from(chunk));
    },
    resolve(opts?: { exitCode?: number | null; failed?: boolean; timedOut?: boolean }): void {
      endStreams();
      const exitCode = opts?.exitCode ?? 0;
      resolveProc({
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        failed: opts?.failed ?? exitCode !== 0,
        timedOut: opts?.timedOut ?? false,
      });
    },
    reject(reason: unknown): void {
      endStreams();
      rejectProc(reason);
    },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const evt of iter) events.push(evt);
  return events;
}

function baseStrategy(overrides: Partial<CliAdapterStrategy> = {}): CliAdapterStrategy {
  return {
    id: 'other',
    binaryDefault: 'mock-cli',
    defaultModel: 'default-model',
    capabilities: ['streaming_text'],
    buildArgs: () => ['--prompt'],
    getOutputMode: () => 'text',
    multiTurnMode: 'none',
    ...overrides,
  };
}

describe('createCliRuntime', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('returns aborted events and skips spawn when signal is already aborted', async () => {
    const rt = createCliRuntime(baseStrategy(), {});
    const ctrl = new AbortController();
    ctrl.abort();

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
      signal: ctrl.signal,
    }));

    expect(mockExeca).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'error',
      failure: expect.objectContaining({ message: 'aborted' }),
    });
    expect((events[0] as { message: string }).message).toBe('aborted');
    expect(normalizeRuntimeFailure((events[0] as { message: string }).message).message).toBe('aborted');
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('parses JSONL output via parseLine and emits text_final from resultText', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [
        '{"type":"delta","text":"A"}\n',
        '{"type":"delta","text":"B"}\n',
        '{"type":"result","text":"Final text"}\n',
      ],
      exitCode: 0,
    }));

    const rt = createCliRuntime(baseStrategy({
      getOutputMode: () => 'jsonl',
      parseLine: (evt) => {
        if (!evt || typeof evt !== 'object') return null;
        const value = evt as { type?: unknown; text?: unknown };
        if (value.type === 'delta' && typeof value.text === 'string') {
          return { text: value.text };
        }
        if (value.type === 'result' && typeof value.text === 'string') {
          return { resultText: value.text };
        }
        return null;
      },
    }), {});

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    const deltaText = events
      .filter((evt): evt is Extract<EngineEvent, { type: 'text_delta' }> => evt.type === 'text_delta')
      .map((evt) => evt.text)
      .join('');
    expect(deltaText).toBe('AB');
    expect(events).toContainEqual({ type: 'text_final', text: 'Final text' });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('successful JSONL mode without resultText keeps text_final empty', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [
        '{"type":"delta","text":"A"}\n',
        '{"type":"delta","text":"B"}\n',
      ],
      exitCode: 0,
    }));

    const rt = createCliRuntime(baseStrategy({
      getOutputMode: () => 'jsonl',
      parseLine: (evt) => {
        if (!evt || typeof evt !== 'object') return null;
        const value = evt as { type?: unknown; text?: unknown };
        if (value.type === 'delta' && typeof value.text === 'string') {
          return { text: value.text };
        }
        return null;
      },
    }), {});

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    const deltaText = events
      .filter((evt): evt is Extract<EngineEvent, { type: 'text_delta' }> => evt.type === 'text_delta')
      .map((evt) => evt.text)
      .join('');
    expect(deltaText).toBe('AB');
    expect(events).toContainEqual({ type: 'text_final', text: '' });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('successful text mode with empty output emits text_final then done', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [],
      exitCode: 0,
    }));

    const rt = createCliRuntime(baseStrategy(), {});

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toEqual([
      { type: 'text_final', text: '' },
      { type: 'done' },
    ]);
  });

  it('successful JSONL mode with empty output emits text_final then done', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [],
      exitCode: 0,
    }));

    const rt = createCliRuntime(baseStrategy({
      getOutputMode: () => 'jsonl',
    }), {});

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toEqual([
      { type: 'text_final', text: '' },
      { type: 'done' },
    ]);
  });

  it('uses strategy handleExitError for non-zero exits', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: ['partial text'],
      stderrChunks: ['bad flag'],
      exitCode: 17,
    }));

    const rt = createCliRuntime(baseStrategy({
      handleExitError: (exitCode, stderr) => `exit=${exitCode}; stderr=${stderr}`,
    }), {});

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'exit=17; stderr=bad flag',
      failure: expect.objectContaining({ message: 'exit=17; stderr=bad flag' }),
    }));
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('logs spawn, first stdio bytes, and first parsed event telemetry for one-shot invocations', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [
        '{"type":"delta","text":"A"}\n',
        '{"type":"result","text":"Final text"}\n',
      ],
      stderrChunks: ['warming up\n'],
      exitCode: 0,
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy({
      getOutputMode: () => 'jsonl',
      parseLine: (evt) => {
        if (!evt || typeof evt !== 'object') return null;
        const value = evt as { type?: unknown; text?: unknown };
        if (value.type === 'delta' && typeof value.text === 'string') {
          return { text: value.text };
        }
        if (value.type === 'result' && typeof value.text === 'string') {
          return { resultText: value.text };
        }
        return null;
      },
    }), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      pid: 4242,
      spawnedAtMs: expect.any(Number),
      outputMode: 'jsonl',
      useStdin: false,
    }), 'one-shot: subprocess spawned');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      stream: 'stdout',
      firstByteAtMs: expect.any(Number),
      spawnToFirstByteMs: expect.any(Number),
    }), 'one-shot: first stdout byte');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      stream: 'stderr',
      firstByteAtMs: expect.any(Number),
      spawnToFirstByteMs: expect.any(Number),
    }), 'one-shot: first stderr byte');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      eventSource: 'strategy_parser',
      eventType: 'text_delta',
      firstParsedEventAtMs: expect.any(Number),
      spawnToFirstParsedEventMs: expect.any(Number),
    }), 'one-shot: first parsed runtime event');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      firstStdoutByteAtMs: expect.any(Number),
      firstStderrByteAtMs: expect.any(Number),
      firstParsedEventAtMs: expect.any(Number),
      firstParsedEventType: 'text_delta',
      firstParsedEventSource: 'strategy_parser',
      spawnToFirstStdoutMs: expect.any(Number),
      spawnToFirstStderrMs: expect.any(Number),
      spawnToFirstEventMs: expect.any(Number),
      totalMs: expect.any(Number),
    }), 'one-shot: timing summary');
  });

  it('records first parsed telemetry for default JSONL parsing', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: ['{"text":"fallback text"}\n'],
      exitCode: 0,
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy({
      getOutputMode: () => 'jsonl',
    }), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toContainEqual({ type: 'text_delta', text: 'fallback text' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      eventSource: 'default_parser',
      eventType: 'text_delta',
      firstParsedEventAtMs: expect.any(Number),
      spawnToFirstParsedEventMs: expect.any(Number),
    }), 'one-shot: first parsed runtime event');
  });

  it('records the first parsed runtime event for text mode output', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: ['plain text output'],
      exitCode: 0,
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy(), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toContainEqual({ type: 'text_delta', text: 'plain text output' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      eventSource: 'default_parser',
      eventType: 'text_delta',
      firstParsedEventAtMs: expect.any(Number),
      spawnToFirstParsedEventMs: expect.any(Number),
    }), 'one-shot: first parsed runtime event');
  });

  it('logs a timing summary for immediate exits without runtime output', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdoutChunks: [],
      stderrChunks: [],
      exitCode: 0,
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy(), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      completionReason: 'success',
      firstStdoutByteAtMs: null,
      firstStderrByteAtMs: null,
      firstParsedEventAtMs: null,
      spawnToFirstStdoutMs: null,
      spawnToFirstStderrMs: null,
      spawnToFirstEventMs: null,
      totalMs: expect.any(Number),
    }), 'one-shot: timing summary');
  });

  it('clears resumable session state after a jsonl stream stall so the next call starts fresh', async () => {
    const first = createControlledSubprocess();
    const second = createControlledSubprocess();
    mockExeca
      .mockReturnValueOnce(first.subprocess)
      .mockReturnValueOnce(second.subprocess);

    const rt = createCliRuntime(baseStrategy({
      multiTurnMode: 'session-resume',
      getOutputMode: (ctx) => (ctx.params.sessionKey ? 'jsonl' : 'text'),
      buildArgs: (ctx) => {
        const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey : '';
        const existingThreadId = sessionKey ? ctx.sessionMap?.get(sessionKey) : undefined;
        return existingThreadId
          ? ['exec', 'resume', existingThreadId, '--', String(ctx.params.prompt)]
          : ['exec', '--json', '--', String(ctx.params.prompt)];
      },
      parseLine: (evt, ctx) => {
        if (!evt || typeof evt !== 'object') return null;
        const value = evt as {
          type?: unknown;
          thread_id?: unknown;
          item?: { type?: unknown; text?: unknown };
        };
        if (value.type === 'thread.started' && typeof value.thread_id === 'string' && ctx.params.sessionKey && ctx.sessionMap) {
          ctx.sessionMap.set(ctx.params.sessionKey, value.thread_id);
          return {};
        }
        if (
          value.type === 'item.completed'
          && value.item?.type === 'agent_message'
          && typeof value.item.text === 'string'
        ) {
          return { text: value.item.text, resultText: value.item.text };
        }
        return null;
      },
    }), {
      streamStallTimeoutMs: 10,
      log: {
        info: vi.fn(),
        debug: vi.fn(),
      } as any,
    });

    const firstRun = collectEvents(rt.invoke({
      prompt: 'first',
      model: '',
      cwd: '/tmp',
      sessionKey: 'session-a',
    }));

    await Promise.resolve();
    first.emitStdout('{"type":"thread.started","thread_id":"thread-stalled"}\n');
    first.emitStdout('{"type":"turn.started"}\n');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const firstEvents = await firstRun;
    expect(first.subprocess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('stream stall'),
    }));

    const secondRun = collectEvents(rt.invoke({
      prompt: 'second',
      model: '',
      cwd: '/tmp',
      sessionKey: 'session-a',
    }));
    await Promise.resolve();
    second.emitStdout('{"type":"thread.started","thread_id":"thread-fresh"}\n');
    second.emitStdout('{"type":"item.completed","item":{"type":"agent_message","text":"fresh output"}}\n');
    second.emitStdout('{"type":"turn.completed","usage":{}}\n');
    second.resolve();
    const secondEvents = await secondRun;

    expect(mockExeca).toHaveBeenCalledTimes(2);
    const secondArgs = mockExeca.mock.calls[1]![1] as string[];
    expect(secondArgs[0]).toBe('exec');
    expect(secondArgs[1]).not.toBe('resume');
    expect(secondEvents).toContainEqual({ type: 'text_final', text: 'fresh output' });
  }, 10_000);

  it('logs a timing summary for stderr-only exits', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stderrChunks: ['fatal startup error\n'],
      exitCode: 2,
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy(), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      completionReason: 'nonzero_exit',
      firstStdoutByteAtMs: null,
      firstStderrByteAtMs: expect.any(Number),
      firstParsedEventAtMs: null,
      spawnToFirstStdoutMs: null,
      spawnToFirstStderrMs: expect.any(Number),
      spawnToFirstEventMs: null,
      totalMs: expect.any(Number),
    }), 'one-shot: timing summary');
  });

  it('logs a timing summary when the invocation is aborted before output arrives', async () => {
    const controlled = createControlledSubprocess();
    mockExeca.mockReturnValue(controlled.subprocess);

    const info = vi.fn();
    const ctrl = new AbortController();
    const rt = createCliRuntime(baseStrategy(), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    const pending = collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
      signal: ctrl.signal,
    }));
    await Promise.resolve();
    await Promise.resolve();
    ctrl.abort();
    controlled.resolve();

    const events = await pending;
    const errorEvt = events.find((e) => e.type === 'error') as { message: string; failure?: { message: string } } | undefined;
    expect(errorEvt).toBeDefined();
    expect(errorEvt?.message).toBe('aborted');
    expect(errorEvt?.failure?.message).toBe('aborted');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      completionReason: 'aborted',
      firstStdoutByteAtMs: null,
      firstStderrByteAtMs: null,
      firstParsedEventAtMs: null,
      totalMs: expect.any(Number),
    }), 'one-shot: timing summary');
  });

  it('logs a timing summary when the subprocess promise rejects', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      rejectWith: new Error('spawn exploded'),
    }));

    const info = vi.fn();
    const rt = createCliRuntime(baseStrategy(), {
      log: {
        info,
        debug: vi.fn(),
      } as any,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'spawn exploded',
      failure: expect.objectContaining({ message: 'spawn exploded' }),
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 'other',
      attempt: 1,
      completionReason: 'process_rejected',
      firstStdoutByteAtMs: null,
      firstStderrByteAtMs: null,
      firstParsedEventAtMs: null,
      totalMs: expect.any(Number),
    }), 'one-shot: timing summary');
  });
});
