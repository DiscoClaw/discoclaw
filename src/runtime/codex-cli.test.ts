import fs from 'node:fs';
import path from 'node:path';
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

function jsonl(lines: string[]): string {
  return `${lines.join('\n')}\n`;
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
  const originalHardening = process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING;
  const originalStableHome = process.env.DISCOCLAW_CODEX_STABLE_HOME;

  beforeEach(() => {
    mockExeca.mockReset();
    delete process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING;
    delete process.env.DISCOCLAW_CODEX_STABLE_HOME;
  });

  afterEach(() => {
    if (originalHardening === undefined) {
      delete process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING;
    } else {
      process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING = originalHardening;
    }
    if (originalStableHome === undefined) {
      delete process.env.DISCOCLAW_CODEX_STABLE_HOME;
    } else {
      process.env.DISCOCLAW_CODEX_STABLE_HOME = originalStableHome;
    }
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

  it('inserts -- argument terminator before prompt to prevent flag parsing', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: '--- SOUL.md ---\ntext',
      model: '',
      cwd: '/tmp',
    }));

    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const dashdashIdx = callArgs.indexOf('--');
    expect(dashdashIdx).toBeGreaterThan(-1);
    expect(callArgs[dashdashIdx + 1]).toBe('--- SOUL.md ---\ntext');
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
    expect(callArgs).toContain('--');
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
    expect(rt.capabilities.has('tools_exec')).toBe(true);
    expect(rt.capabilities.has('tools_web')).toBe(true);
    expect(rt.capabilities.has('sessions')).toBe(true);
    expect(rt.capabilities.has('workspace_instructions')).toBe(true);
    expect(rt.capabilities.has('mcp')).toBe(true);
  });

  it('disableSessions removes sessions capability and forces ephemeral mode', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      disableSessions: true,
    });

    expect(rt.capabilities.has('sessions')).toBe(false);

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
      sessionKey: 'should-be-ignored',
    }));

    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--ephemeral');
    expect(callArgs).not.toContain('--json');
    expect(callArgs).not.toContain('resume');
  });

  it('empty stdout emits empty text_final and done', async () => {
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

    expect(events.find((e) => e.type === 'text_final')).toEqual({ type: 'text_final', text: '' });
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

  it('error sanitization skips Codex banner/chatter and surfaces actionable error line', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      stderr: [
        'OpenAI Codex v0.101.0 (research preview)',
        '--------',
        'workdir: /tmp',
        'model: gpt-5-mini',
        'user',
        'TOP SECRET PROMPT DATA',
        'Reconnecting... 5/5 (stream disconnected before completion)',
        'ERROR: stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)',
      ].join('\n'),
      exitCode: 1,
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
    expect(msg).toContain('stream disconnected before completion');
    expect(msg).not.toContain('OpenAI Codex');
    expect(msg).not.toContain('TOP SECRET');
  });

  it('error sanitization maps rollout path corruption to a clear remediation message', async () => {
    process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING = '0';
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      stderr: '2026-02-16T23:36:26.244364Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c5957-beea-7e92-aca4-42b5c15af63d',
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
    expect(msg).toContain('codex session state appears corrupted');
    expect(msg).toContain('CODEX_HOME');
  });

  it('launcher state hardening retries once with stable CODEX_HOME on rollout-path errors', async () => {
    process.env.DISCOCLAW_CODEX_STABLE_HOME = '/tmp/discoclaw-codex-stable-home-test';

    mockExeca
      .mockImplementationOnce(() => createMockSubprocess({
        stdout: '',
        stderr: 'ERROR codex_core::rollout::list: state db missing rollout path for thread abc',
        exitCode: 1,
      }))
      .mockImplementationOnce(() => createMockSubprocess({
        stdout: 'Recovered answer',
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

    expect(mockExeca).toHaveBeenCalledTimes(2);
    const retryEnv = mockExeca.mock.calls[1][2] as { env?: Record<string, string | undefined> };
    expect(retryEnv.env?.CODEX_HOME).toBe('/tmp/discoclaw-codex-stable-home-test');
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'text_final')).toEqual({ type: 'text_final', text: 'Recovered answer' });
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('launcher state hardening uses repo-stable default home when DISCOCLAW_CODEX_STABLE_HOME is unset', async () => {
    mockExeca
      .mockImplementationOnce(() => createMockSubprocess({
        stdout: '',
        stderr: 'ERROR codex_core::rollout::list: state db missing rollout path for thread abc',
        exitCode: 1,
      }))
      .mockImplementationOnce(() => createMockSubprocess({
        stdout: 'Recovered answer',
        exitCode: 0,
      }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
    });

    await collectEvents(rt.invoke({
      prompt: 'Say hello',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(2);
    const retryEnv = mockExeca.mock.calls[1][2] as { env?: Record<string, string | undefined> };
    expect(retryEnv.env?.CODEX_HOME).toBe(path.resolve(process.cwd(), '.codex-home-discoclaw'));
  });

  it('launcher state hardening can be disabled explicitly', async () => {
    process.env.DISCOCLAW_CLI_LAUNCHER_STATE_HARDENING = '0';

    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: '',
      stderr: 'ERROR codex_core::rollout::list: state db missing rollout path for thread abc',
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

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'error')).toBeDefined();
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

  it('dangerous bypass flag replaces read-only sandbox on exec', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(callArgs).not.toContain('-s');
    expect(callArgs).not.toContain('read-only');
  });

  it('does not force reasoning summaries when preview/debug flags are off', async () => {
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
    expect(callArgs).not.toContain('model_reasoning_summary="auto"');
  });

  it('forces model_reasoning_summary=auto when itemTypeDebug is enabled', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      itemTypeDebug: true,
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain('-c');
    expect(callArgs).toContain('model_reasoning_summary="auto"');
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

  it('passes appendSystemPrompt as -c developer_instructions', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      appendSystemPrompt: 'You are Weston.',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const idx = callArgs.indexOf('developer_instructions="You are Weston."');
    expect(idx).toBeGreaterThan(-1);
    expect(callArgs[idx - 1]).toBe('-c');
  });

  it('omits developer_instructions when appendSystemPrompt is unset', async () => {
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
    expect(callArgs.join(' ')).not.toContain('developer_instructions');
  });

  it('escapes quotes in appendSystemPrompt value', async () => {
    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: 'ok',
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      appendSystemPrompt: 'Say "hello" to the user.',
    });

    await collectEvents(rt.invoke({
      prompt: 'Hi',
      model: '',
      cwd: '/tmp',
    }));

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const callArgs = mockExeca.mock.calls[0][1] as string[];
    const devInstr = callArgs.find((a) => a.startsWith('developer_instructions='));
    expect(devInstr).toBe('developer_instructions="Say \\"hello\\" to the user."');
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

  it('resume without images still uses codex exec resume', async () => {
    const jsonlOutput1 = jsonl([
      '{"type":"thread.started","thread_id":"thread-uuid-456"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first response"}}',
      '{"type":"turn.completed","usage":{}}',
    ]);
    const jsonlOutput2 = jsonl([
      '{"type":"thread.started","thread_id":"thread-uuid-456"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second response"}}',
      '{"type":"turn.completed","usage":{}}',
    ]);

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

  it('dangerous bypass flag is passed on resume calls', async () => {
    const jsonlOutput1 = [
      '{"type":"thread.started","thread_id":"thread-danger-1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';
    const jsonlOutput2 = [
      '{"type":"thread.started","thread_id":"thread-danger-1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
    await collectEvents(rt.invoke({
      prompt: 'Round 1',
      model: '',
      cwd: '/tmp',
      sessionKey: 'danger-session',
    }));

    mockExeca.mockReturnValue(createMockSubprocess({ stdout: jsonlOutput2, exitCode: 0 }));
    await collectEvents(rt.invoke({
      prompt: 'Round 2',
      model: '',
      cwd: '/tmp',
      sessionKey: 'danger-session',
    }));

    const callArgs2 = mockExeca.mock.calls[1][1] as string[];
    expect(callArgs2[0]).toBe('exec');
    expect(callArgs2[1]).toBe('resume');
    expect(callArgs2).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(callArgs2).not.toContain('-s');
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

  it('reasoning items emit text_delta but text_final contains only agent_message', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"reason-thread-1"}',
      '{"type":"item.completed","item":{"type":"reasoning","summary":"Let me think step by step..."}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"Considering the options..."}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"The answer is 42."}}',
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
      prompt: 'What is the answer?',
      model: '',
      cwd: '/tmp',
      sessionKey: 'reason-session',
    }));

    // text_delta events should include reasoning text.
    const deltas = events.filter((e) => e.type === 'text_delta');
    const deltaTexts = deltas.map((d) => (d as { text: string }).text);
    expect(deltaTexts).toContain('Let me think step by step...');
    expect(deltaTexts).toContain('Considering the options...');
    expect(deltaTexts).toContain('The answer is 42.');

    // text_final should contain only the agent_message, not reasoning text.
    const final = events.find((e) => e.type === 'text_final');
    expect(final).toBeDefined();
    expect((final as { text: string }).text).toBe('The answer is 42.');
    expect((final as { text: string }).text).not.toContain('Let me think');
    expect((final as { text: string }).text).not.toContain('Considering the options');
  });

  it('without agent_message, reasoning deltas do not become text_final', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"reason-thread-no-agent"}',
      '{"type":"item.completed","item":{"type":"reasoning","summary":"Thinking through options..."}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"Still reasoning..."}}',
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
      prompt: 'Reason only',
      model: '',
      cwd: '/tmp',
      sessionKey: 'reason-session-no-agent',
    }));

    const deltaTexts = events
      .filter((e) => e.type === 'text_delta')
      .map((d) => (d as { text: string }).text);
    expect(deltaTexts).toContain('Thinking through options...');
    expect(deltaTexts).toContain('Still reasoning...');

    const final = events.find((e) => e.type === 'text_final');
    expect(final).toEqual({ type: 'text_final', text: '' });
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('reasoning item with empty or missing text is silently skipped', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"reason-thread-2"}',
      '{"type":"item.completed","item":{"type":"reasoning","summary":""}}',
      '{"type":"item.completed","item":{"type":"reasoning"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
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
      prompt: 'Do something',
      model: '',
      cwd: '/tmp',
      sessionKey: 'reason-session-2',
    }));

    // Should not emit empty text_delta events.
    const deltas = events.filter((e) => e.type === 'text_delta');
    const emptyDeltas = deltas.filter((d) => !(d as { text: string }).text);
    expect(emptyDeltas).toHaveLength(0);

    // Only the agent_message delta should be present.
    const deltaTexts = deltas.map((d) => (d as { text: string }).text);
    expect(deltaTexts).toEqual(['Done.']);

    // Streaming continues to completion.
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('reasoning item with non-string text field is silently skipped and streaming continues', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"reason-thread-3"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":42}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":{"nested":"object"}}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Still works."}}',
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
      prompt: 'Do something',
      model: '',
      cwd: '/tmp',
      sessionKey: 'reason-session-3',
    }));

    // Non-string text fields should produce no text_delta.
    const deltas = events.filter((e) => e.type === 'text_delta');
    const deltaTexts = deltas.map((d) => (d as { text: string }).text);
    expect(deltaTexts).toEqual(['Still works.']);

    // No error events — streaming continues without error.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('maps command_execution items to tool_start/tool_end streaming events', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"tool-thread-1"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"cat package.json\\"","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"cat package.json\\"","aggregated_output":"{\\n  \\"name\\": \\"discoclaw\\"\\n}\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"discoclaw"}}',
      '{"type":"turn.completed","usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168}}',
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
      prompt: 'Read package name',
      model: '',
      cwd: '/tmp',
      sessionKey: 'tool-session',
    }));

    expect(events).toContainEqual({
      type: 'tool_start',
      name: 'command_execution',
      input: { command: '/bin/bash -lc "cat package.json"' },
    });

    const toolEnd = events.find((e) => e.type === 'tool_end') as Extract<EngineEvent, { type: 'tool_end' }> | undefined;
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.name).toBe('command_execution');
    expect(toolEnd!.ok).toBe(true);
    expect(toolEnd!.output).toMatchObject({
      command: '/bin/bash -lc "cat package.json"',
      exitCode: 0,
    });

    const usageEvt = events.find((e) => e.type === 'usage') as Extract<EngineEvent, { type: 'usage' }> | undefined;
    expect(usageEvt).toBeDefined();
    expect(usageEvt).toMatchObject({ inputTokens: 123, outputTokens: 45, totalTokens: 168 });
  });

  it('verbosePreview emits richer item lifecycle log lines for Codex reasoning/commands', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"verbose-thread-1"}',
      '{"type":"item.started","item":{"type":"reasoning","status":"in_progress"}}',
      '{"type":"item.completed","item":{"type":"reasoning","summary":"Planning the approach carefully."}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls -la","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","aggregated_output":"total 8\\n-rw-r--r-- file","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: jsonlOutput,
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      verbosePreview: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Show verbose preview',
      model: '',
      cwd: '/tmp',
      sessionKey: 'verbose-session',
    }));

    const logLines = events
      .filter((e): e is Extract<EngineEvent, { type: 'log_line' }> => e.type === 'log_line')
      .map((e) => e.line);
    expect(logLines.some((line) => line.includes('Reasoning started'))).toBe(true);
    expect(logLines.some((line) => line.includes('Reasoning completed:'))).toBe(true);
    expect(logLines.some((line) => line.includes('Command started:'))).toBe(true);
    expect(logLines.some((line) => line.includes('Command output:'))).toBe(true);
  });

  it('itemTypeDebug emits structured preview_debug item lifecycle events', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"debug-thread-1"}',
      '{"type":"item.started","item":{"id":"item_reason_1","type":"reasoning","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_reason_1","type":"reasoning","summary":"Planning."}}',
      '{"type":"item.started","item":{"id":"item_cmd_1","type":"command_execution","command":"pwd","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_cmd_1","type":"command_execution","command":"pwd","aggregated_output":"/tmp","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n') + '\n';

    mockExeca.mockReturnValue(createMockSubprocess({
      stdout: jsonlOutput,
      exitCode: 0,
    }));

    const rt = createCodexCliRuntime({
      codexBin: 'codex',
      defaultModel: 'gpt-5.3-codex',
      itemTypeDebug: true,
    });

    const events = await collectEvents(rt.invoke({
      prompt: 'Show raw debug item types',
      model: '',
      cwd: '/tmp',
      sessionKey: 'debug-session',
    }));

    const debugEvents = events
      .filter((e): e is Extract<EngineEvent, { type: 'preview_debug' }> => e.type === 'preview_debug');
    expect(debugEvents.some((e) => e.phase === 'started' && e.itemType === 'reasoning')).toBe(true);
    expect(debugEvents.some((e) => e.phase === 'completed' && e.itemType === 'reasoning')).toBe(true);
    expect(debugEvents.some((e) => e.phase === 'started' && e.itemType === 'command_execution')).toBe(true);
    expect(debugEvents.some((e) => e.phase === 'completed' && e.itemType === 'command_execution')).toBe(true);
    expect(debugEvents.some((e) => e.itemType === 'reasoning' && e.itemId === 'item_reason_1')).toBe(true);
    expect(debugEvents.some((e) => e.itemType === 'reasoning' && e.phase === 'completed' && e.label === 'Reasoning: Planning.')).toBe(true);
    expect(debugEvents.some((e) => e.itemType === 'command_execution' && e.itemId === 'item_cmd_1')).toBe(true);
    expect(debugEvents.some((e) => e.itemType === 'agent_message')).toBe(false);
  });

  it('uses the generic reasoning-start preview_debug label even when a summary is present', async () => {
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"reasoning-start-thread-1"}',
      '{"type":"item.started","item":{"id":"item_reason_start_1","type":"reasoning","summary":"Planning the filesystem scan.","status":"in_progress"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
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
      prompt: 'Preview reasoning start',
      model: '',
      cwd: '/tmp',
      sessionKey: 'reasoning-start-session',
    }));

    expect(events).toContainEqual({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'reasoning',
      itemId: 'item_reason_start_1',
      status: 'in_progress',
      label: 'Hypothesis: reasoning in progress.',
    });
  });

  // --- One-shot with images tests ---

  describe('one-shot with images', () => {
    it('includes --image flags in args before -- when images are present', async () => {
      mockExeca.mockImplementation(() => createMockSubprocess({
        stdout: 'image received',
        exitCode: 0,
      }));

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      await collectEvents(rt.invoke({
        prompt: 'Describe this image',
        model: '',
        cwd: '/tmp',
        images: [
          { base64: 'aVZCT1JXMA==', mediaType: 'image/png' },
          { base64: '/9j/4AAQ', mediaType: 'image/jpeg' },
        ],
      }));

      expect(mockExeca).toHaveBeenCalledTimes(1);
      const callArgs = mockExeca.mock.calls[0][1] as string[];

      // --image flags should appear before --
      const dashDashIdx = callArgs.indexOf('--');
      expect(dashDashIdx).toBeGreaterThan(-1);

      const imageIndices: number[] = [];
      for (let i = 0; i < callArgs.length; i++) {
        if (callArgs[i] === '--image') imageIndices.push(i);
      }

      expect(imageIndices).toHaveLength(2);
      for (const idx of imageIndices) {
        expect(idx).toBeLessThan(dashDashIdx);
      }

      // Values after --image should be file paths with correct extensions
      expect(callArgs[imageIndices[0]! + 1]).toMatch(/\.png$/);
      expect(callArgs[imageIndices[1]! + 1]).toMatch(/\.jpg$/);
    });

    it('creates temp files with correct extensions matching media types', async () => {
      mockExeca.mockImplementation(() => createMockSubprocess({
        stdout: 'ok',
        exitCode: 0,
      }));

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      await collectEvents(rt.invoke({
        prompt: 'Check extensions',
        model: '',
        cwd: '/tmp',
        images: [
          { base64: 'AAAA', mediaType: 'image/png' },
          { base64: 'BBBB', mediaType: 'image/jpeg' },
          { base64: 'CCCC', mediaType: 'image/webp' },
        ],
      }));

      const callArgs = mockExeca.mock.calls[0][1] as string[];
      const imagePaths: string[] = [];
      for (let i = 0; i < callArgs.length; i++) {
        if (callArgs[i] === '--image') imagePaths.push(callArgs[i + 1]!);
      }

      expect(imagePaths).toHaveLength(3);
      expect(imagePaths[0]).toMatch(/image-0\.png$/);
      expect(imagePaths[1]).toMatch(/image-1\.jpg$/);
      expect(imagePaths[2]).toMatch(/image-2\.webp$/);
    });

    it('cleanup removes the temp directory after invocation completes', async () => {
      mockExeca.mockImplementation(() => createMockSubprocess({
        stdout: 'ok',
        exitCode: 0,
      }));

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      await collectEvents(rt.invoke({
        prompt: 'cleanup test',
        model: '',
        cwd: '/tmp',
        images: [
          { base64: 'AAAA', mediaType: 'image/png' },
        ],
      }));

      const callArgs = mockExeca.mock.calls[0][1] as string[];
      const imgIdx = callArgs.indexOf('--image');
      const imgPath = callArgs[imgIdx + 1]!;
      const tmpDir = path.dirname(imgPath);

      // After collection completes, the temp directory should be cleaned up.
      expect(fs.existsSync(tmpDir)).toBe(false);
    });

    it('resume with images builds fresh exec args with --image flags instead of resume args', async () => {
      const jsonlOutput1 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput2 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-new"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"fresh"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      // First call establishes the resumable session.
      mockExeca.mockImplementation(() => createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 1',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session',
      }));

      // Second call has images, so it should start a fresh session instead of resuming.
      mockExeca.mockImplementation(() => createMockSubprocess({ stdout: jsonlOutput2, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'What about now?',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session',
        images: [{ base64: 'BBBB', mediaType: 'image/jpeg' }],
      }));

      const callArgs2 = mockExeca.mock.calls[1][1] as string[];
      expect(callArgs2.slice(0, 2)).toEqual(['exec', '-m']);
      expect(callArgs2).not.toContain('resume');
      expect(callArgs2).not.toContain('img-thread-old');
      expect(callArgs2).toContain('--json');
      expect(callArgs2).toContain('--image');
    });

    it('emits a reset notification when a resumed image turn starts fresh', async () => {
      const jsonlOutput1 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput2 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-new"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"fresh"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 1',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-notice',
      }));

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput2, exitCode: 0 }));
      const events = await collectEvents(rt.invoke({
        prompt: 'Round 2',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-notice',
        images: [{ base64: 'BBBB', mediaType: 'image/jpeg' }],
      }));

      expect(events).toContainEqual({
        type: 'text_delta',
        text: '*(Session reset — image attachments require a fresh Codex session because `codex exec resume` does not support `--image`. Starting fresh.)*\n\n',
      });
    });

    it('spawn failure on a fresh image attempt preserves the old thread mapping for later resume', async () => {
      const jsonlOutput1 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput3 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"third"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 1',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-spawn-fail',
      }));

      mockExeca.mockImplementationOnce(() => createMockSubprocess({
        stdout: '',
        exitCode: undefined as any,
        failed: true,
        resultExtra: {
          exitCode: null,
          failed: true,
          code: 'ENOENT',
          originalMessage: 'spawn codex ENOENT',
          shortMessage: 'Command failed: codex exec ENOENT',
        },
      }));
      await collectEvents(rt.invoke({
        prompt: 'Round 2 with image',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-spawn-fail',
        images: [{ base64: 'BBBB', mediaType: 'image/jpeg' }],
      }));

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput3, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 3',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-spawn-fail',
      }));

      const callArgs3 = mockExeca.mock.calls[2][1] as string[];
      expect(callArgs3[0]).toBe('exec');
      expect(callArgs3[1]).toBe('resume');
      expect(callArgs3[2]).toBe('img-thread-old');
    });

    it('post-reset success replaces the stored thread and later turns resume the new thread', async () => {
      const jsonlOutput1 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput2 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-new"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput3 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-new"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"third"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 1',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-replaced',
      }));

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput2, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 2 with image',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-replaced',
        images: [{ base64: 'BBBB', mediaType: 'image/jpeg' }],
      }));

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput3, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 3',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-replaced',
      }));

      const callArgs3 = mockExeca.mock.calls[2][1] as string[];
      expect(callArgs3[0]).toBe('exec');
      expect(callArgs3[1]).toBe('resume');
      expect(callArgs3[2]).toBe('img-thread-new');
    });

    it('launcher-state retry on an image-reset turn preserves the old thread when the retry ends in spawn failure', async () => {
      process.env.DISCOCLAW_CODEX_STABLE_HOME = '/tmp/discoclaw-codex-reset-retry-home';

      const jsonlOutput1 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);
      const jsonlOutput4 = jsonl([
        '{"type":"thread.started","thread_id":"img-thread-old"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"third"}}',
        '{"type":"turn.completed","usage":{}}',
      ]);

      const rt = createCodexCliRuntime({
        codexBin: 'codex',
        defaultModel: 'gpt-5.3-codex',
      });

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput1, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 1',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-reset-retry',
      }));

      mockExeca
        .mockImplementationOnce(() => createMockSubprocess({
          stdout: '',
          stderr: 'ERROR codex_core::rollout::list: state db missing rollout path for thread img-thread-old',
          exitCode: 1,
        }))
        .mockImplementationOnce(() => createMockSubprocess({
          stdout: '',
          exitCode: undefined as any,
          failed: true,
          resultExtra: {
            exitCode: null,
            failed: true,
            code: 'ENOENT',
            originalMessage: 'spawn codex ENOENT',
            shortMessage: 'Command failed: codex exec ENOENT',
          },
        }));
      await collectEvents(rt.invoke({
        prompt: 'Round 2 with image',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-reset-retry',
        images: [{ base64: 'BBBB', mediaType: 'image/jpeg' }],
      }));

      const retryEnv = mockExeca.mock.calls[2][2] as { env?: Record<string, string | undefined> };
      expect(retryEnv.env?.CODEX_HOME).toBe('/tmp/discoclaw-codex-reset-retry-home');

      mockExeca.mockImplementationOnce(() => createMockSubprocess({ stdout: jsonlOutput4, exitCode: 0 }));
      await collectEvents(rt.invoke({
        prompt: 'Round 3',
        model: '',
        cwd: '/tmp',
        sessionKey: 'img-session-reset-retry',
      }));

      const callArgs4 = mockExeca.mock.calls[3][1] as string[];
      expect(callArgs4[0]).toBe('exec');
      expect(callArgs4[1]).toBe('resume');
      expect(callArgs4[2]).toBe('img-thread-old');
    });
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
