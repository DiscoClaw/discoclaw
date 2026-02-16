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
    expect(rt.capabilities.has('tools_fs')).toBe(true);
    expect(rt.capabilities.has('sessions')).toBe(true);
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

  it('passes --add-dir flags from params.addDirs', async () => {
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
      addDirs: ['/home/user/project', '/home/user/shared'],
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    // Should contain --add-dir /home/user/project --add-dir /home/user/shared
    const firstIdx = callArgs.indexOf('--add-dir');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(callArgs[firstIdx + 1]).toBe('/home/user/project');
    const secondIdx = callArgs.indexOf('--add-dir', firstIdx + 2);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(callArgs[secondIdx + 1]).toBe('/home/user/shared');
  });

  it('omits --add-dir when addDirs is empty', async () => {
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
      addDirs: [],
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--add-dir');
  });

  it('omits --add-dir when addDirs is undefined', async () => {
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
      // addDirs intentionally omitted (undefined)
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--add-dir');
  });

  // --- Session persistence tests ---

  it('sessionKey omits --ephemeral and adds --json', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"abc-123"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: jsonlOutput,
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
      sessionKey: 'test-session-1',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    // Should NOT have --ephemeral.
    expect(callArgs).not.toContain('--ephemeral');
    // Should have --json.
    expect(callArgs).toContain('--json');
    // Should start with 'exec' (not 'exec resume' on first call).
    expect(callArgs[0]).toBe('exec');
    expect(callArgs[1]).not.toBe('resume');

    // Should extract text from JSONL.
    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('hello');
  });

  it('second call with same sessionKey uses codex exec resume', async () => {
    const jsonlOutput1 = [
      '{"type":"thread.started","thread_id":"thread-uuid-456"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first response"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';
    const jsonlOutput2 = [
      '{"type":"thread.started","thread_id":"thread-uuid-456"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second response"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    // First call — establishes the session.
    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
    await collectEvents(rt.invoke({
      prompt: 'Round 1',
      model: '',
      cwd: '/tmp',
      sessionKey: 'audit-session',
    }));

    // Second call — should resume.
    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlOutput2, exitCode: 0 }));
    const events2 = await collectEvents(rt.invoke({
      prompt: 'Round 2',
      model: '',
      cwd: '/tmp',
      sessionKey: 'audit-session',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(2);
    const callArgs2 = mockExeca.mock.calls[1][1] as string[];
    // Should use 'exec resume <thread_id>'.
    expect(callArgs2[0]).toBe('exec');
    expect(callArgs2[1]).toBe('resume');
    expect(callArgs2[2]).toBe('thread-uuid-456');

    const final2 = events2.find((e) => e.type === 'text_final');
    expect((final2 as { text: string }).text).toBe('second response');
  });

  it('without sessionKey still uses --ephemeral (backward compat)', async () => {
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
      // no sessionKey
    }));

    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--ephemeral');
    expect(callArgs).not.toContain('--json');
  });

  it('different sessionKeys get independent sessions', async () => {
    const jsonlA = [
      '{"type":"thread.started","thread_id":"thread-aaa"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';
    const jsonlB = [
      '{"type":"thread.started","thread_id":"thread-bbb"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';
    const jsonlA2 = [
      '{"type":"thread.started","thread_id":"thread-aaa"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"a2"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlA, exitCode: 0 }));
    await collectEvents(rt.invoke({ prompt: 'a1', model: '', cwd: '/tmp', sessionKey: 'session-a' }));

    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlB, exitCode: 0 }));
    await collectEvents(rt.invoke({ prompt: 'b1', model: '', cwd: '/tmp', sessionKey: 'session-b' }));

    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlA2, exitCode: 0 }));
    await collectEvents(rt.invoke({ prompt: 'a2', model: '', cwd: '/tmp', sessionKey: 'session-a' }));

    // Third call should resume session-a's thread, not session-b's.
    const callArgs3 = mockExeca.mock.calls[2][1] as string[];
    expect(callArgs3[1]).toBe('resume');
    expect(callArgs3[2]).toBe('thread-aaa');
  });
});
