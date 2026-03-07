import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapterStrategy } from './cli-strategy.js';
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
    expect(events).toEqual([
      { type: 'error', message: 'aborted' },
      { type: 'done' },
    ]);
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

    expect(events).toContainEqual({ type: 'error', message: 'exit=17; stderr=bad flag' });
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
});
