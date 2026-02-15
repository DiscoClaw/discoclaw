import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from './types.js';

// We mock execa at the module level so createCodexCliRuntime uses our mock.
const mockExeca = vi.fn();
vi.mock('execa', () => ({
  execa: (...args: any[]) => mockExeca(...args),
}));

// Import after mock setup.
const { createCodexCliRuntime, killActiveCodexSubprocesses } = await import('./codex-cli.js');

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const evt of iter) {
    events.push(evt);
  }
  return events;
}

/** Create a mock subprocess that mimics execa's ResultPromise shape. */
function createMockSubprocess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  failed?: boolean;
  /** Extra fields merged into the resolved result (e.g. code, errno, originalMessage). */
  resultExtra?: Record<string, unknown>;
  /** If set, the promise rejects with this error object instead of resolving. */
  rejectWith?: Record<string, unknown>;
}) {
  const stdoutChunks = opts.stdout ? [Buffer.from(opts.stdout)] : [];
  const stdoutListeners: Record<string, ((...args: any[]) => void)[]> = {};
  const stderrListeners: Record<string, ((...args: any[]) => void)[]> = {};

  let thenCb: ((result: any) => void) | null = null;
  let catchCb: ((err: any) => void) | null = null;

  const mockStdout = {
    on(event: string, cb: (...args: any[]) => void) {
      if (!stdoutListeners[event]) stdoutListeners[event] = [];
      stdoutListeners[event].push(cb);
      return mockStdout;
    },
  };

  const mockStderr = {
    on(event: string, cb: (...args: any[]) => void) {
      if (!stderrListeners[event]) stderrListeners[event] = [];
      stderrListeners[event].push(cb);
      return mockStderr;
    },
  };

  const mockStdin = {
    write: vi.fn(),
    end: vi.fn(),
  };

  const subprocess: any = {
    stdout: mockStdout,
    stderr: mockStderr,
    stdin: mockStdin,
    pid: 12345,
    kill: vi.fn(),
    then(cb: (result: any) => void) {
      thenCb = cb;
      return { catch(cb2: (err: any) => void) { catchCb = cb2; } };
    },
  };

  // Simulate async process completion.
  // Use queueMicrotask to fire after the generator sets up listeners.
  queueMicrotask(() => {
    // Emit stdout data
    for (const chunk of stdoutChunks) {
      for (const cb of (stdoutListeners['data'] || [])) {
        cb(chunk);
      }
    }
    // Emit stderr data
    if (opts.stderr) {
      for (const cb of (stderrListeners['data'] || [])) {
        cb(Buffer.from(opts.stderr));
      }
    }

    // End streams
    for (const cb of (stdoutListeners['end'] || [])) cb();
    for (const cb of (stderrListeners['end'] || [])) cb();

    // Resolve/reject the process promise.
    if (opts.rejectWith) {
      catchCb?.(opts.rejectWith);
    } else if (opts.timedOut) {
      catchCb?.({
        timedOut: true,
        message: 'timed out',
        originalMessage: 'timed out',
        shortMessage: 'timed out',
      });
    } else {
      const exitCode = opts.exitCode ?? 0;
      const result = {
        exitCode,
        stdout: opts.stdout ?? '',
        stderr: opts.stderr ?? '',
        timedOut: false,
        failed: exitCode !== 0 || (opts.failed ?? false),
        ...opts.resultExtra,
      };
      thenCb?.(result);
    }
  });

  return subprocess;
}

describe('Codex CLI runtime adapter', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('happy path: stdout text emits text_delta + text_final + done', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'Hello world',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Say hello',
      model: '',
      cwd: '/tmp',
    }));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => (d as { text: string }).text).join('')).toBe('Hello world');

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('Hello world');

    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('error path: non-zero exit code emits error + done', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      stderr: 'model not found',
      exitCode: 1,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Say hello',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('model not found');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('timeout path: timedOut flag emits timeout error + done', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      timedOut: true,
      exitCode: undefined as any,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Say hello',
      model: '',
      cwd: '/tmp',
      timeoutMs: 5000,
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('timed out');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('model override: params.model takes precedence over defaultModel', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: 'gpt-4o',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const modelIdx = callArgs.indexOf('-m');
    expect(callArgs[modelIdx + 1]).toBe('gpt-4o');
  });

  it('empty model fallback: params.model="" resolves to defaultModel', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const modelIdx = callArgs.indexOf('-m');
    expect(callArgs[modelIdx + 1]).toBe('gpt-5.3-codex');
  });

  it('large prompt uses stdin instead of positional arg', async () => {
    const largePrompt = 'x'.repeat(200_000);
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: largePrompt,
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    // Should end with `-` (stdin flag) instead of the large prompt text.
    expect(callArgs[callArgs.length - 1]).toBe('-');
    // Should NOT contain the large prompt as a positional arg.
    expect(callArgs).not.toContain(largePrompt);

    // Verify stdin was used.
    const execaOpts = mockExeca.mock.calls[0][2] as any;
    expect(execaOpts.stdin).toBe('pipe');
  });

  it('shutdown cleanup: killActiveCodexSubprocesses kills tracked processes', async () => {
    const sub = createMockSubprocess({
      stdout: '',
      exitCode: 0,
    });
    // Prevent the subprocess from resolving immediately so it stays tracked.
    sub.then = () => ({ catch: () => {} });

    mockExeca.mockReturnValue(sub);

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    // Start invoke but don't consume fully — just trigger subprocess creation.
    const iter = rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    });

    // Pull one event to start the generator (which adds the subprocess to tracking).
    const iterResult = iter as AsyncGenerator<EngineEvent>;
    // Actually call .next() to enter the generator body — the subprocess is
    // added to activeSubprocesses inside the generator, before the first yield.
    iterResult.next(); // don't await — we just need it to run up to the first yield/await
    await new Promise(r => setTimeout(r, 10));

    // Kill all tracked subprocesses.
    killActiveCodexSubprocesses();
    expect(sub.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('runtime has correct id and capabilities', () => {
    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    expect(rt.id).toBe('codex');
    expect(rt.capabilities.has('streaming_text')).toBe(true);
  });

  it('empty stdout emits done without text_final', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    // No text_final for empty response.
    expect(events.find((e) => e.type === 'text_final')).toBeUndefined();
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('error messages are sanitized: multi-line stderr truncated to first line', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      stderr: 'auth token expired\nfull prompt: You are a helpful assistant...\nsession: /tmp/codex/abc123',
      exitCode: 1,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Say hello',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    const msg = (errorEvt as { message: string }).message;
    // Should contain first line only.
    expect(msg).toContain('auth token expired');
    // Should NOT contain prompt or session content from subsequent lines.
    expect(msg).not.toContain('full prompt');
    expect(msg).not.toContain('session:');
  });

  it('ENOENT via tryFinalize: uses fixed message, never leaks prompt', async () => {
    // Simulates execa resolving (reject: false) with failed=true, exitCode=null, code=ENOENT.
    // The real execa shortMessage would contain the full command line including the prompt.
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      exitCode: undefined as any,
      failed: true,
      resultExtra: {
        exitCode: null,
        failed: true,
        code: 'ENOENT',
        originalMessage: 'spawn codex ENOENT',
        shortMessage: "Command failed: codex exec -m gpt-5.3-codex --skip-git-repo-check --ephemeral -s read-only 'TOP SECRET PROMPT DATA'\nspawn codex ENOENT",
      },
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'TOP SECRET PROMPT DATA',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    const msg = (errorEvt as { message: string }).message;
    // Should use the fixed "not found" message.
    expect(msg).toContain('codex binary not found');
    // Must never contain prompt text.
    expect(msg).not.toContain('TOP SECRET');
    expect(msg).not.toContain('Command failed');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('ENOENT via catch handler: uses fixed message, never leaks prompt', async () => {
    // Simulates the .catch() path — execa rejects with an error that includes the command line.
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      rejectWith: {
        code: 'ENOENT',
        originalMessage: 'spawn codex ENOENT',
        shortMessage: "Command failed: codex exec -m gpt-5.3-codex --skip-git-repo-check --ephemeral -s read-only 'TOP SECRET PROMPT DATA'\nspawn codex ENOENT",
        message: "Command failed: codex exec -m gpt-5.3-codex --skip-git-repo-check --ephemeral -s read-only 'TOP SECRET PROMPT DATA'\nspawn codex ENOENT",
      },
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'TOP SECRET PROMPT DATA',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    const msg = (errorEvt as { message: string }).message;
    // Should use the fixed "not found" message.
    expect(msg).toContain('codex binary not found');
    // Must never contain prompt text.
    expect(msg).not.toContain('TOP SECRET');
    expect(msg).not.toContain('Command failed');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('non-ENOENT spawn failure via catch handler: generic message, no raw error', async () => {
    // Simulates a non-ENOENT rejection (e.g. EACCES) — should get generic message.
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      rejectWith: {
        code: 'EACCES',
        originalMessage: 'spawn codex EACCES',
        shortMessage: "Command failed: codex exec -m gpt-5.3-codex --skip-git-repo-check --ephemeral -s read-only 'secret prompt'\nspawn codex EACCES",
        message: "Command failed: codex exec ...",
      },
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'secret prompt',
      model: '',
      cwd: '/tmp',
    }));

    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    const msg = (errorEvt as { message: string }).message;
    // Should use the generic fixed message with error code.
    expect(msg).toBe('codex process failed unexpectedly (EACCES)');
    // Must never contain prompt text or raw command.
    expect(msg).not.toContain('secret prompt');
    expect(msg).not.toContain('Command failed');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('args include read-only sandbox flag', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const sandboxIdx = callArgs.indexOf('-s');
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(callArgs[sandboxIdx + 1]).toBe('read-only');
  });
});
