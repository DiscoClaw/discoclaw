import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { LongRunningProcess, type LongRunningProcessOpts } from './long-running-process.js';

function createMockSubprocess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), end: vi.fn() };
  let resolvePromise: (val: any) => void;
  let rejectPromise: (err: any) => void;
  const promise = new Promise<any>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });
  const proc: any = Object.assign(promise, {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdout, stderr, stdin, resolve: resolvePromise!, reject: rejectPromise! };
}

const baseOpts: LongRunningProcessOpts = {
  claudeBin: 'claude',
  model: 'opus',
  cwd: '/tmp',
  dangerouslySkipPermissions: true,
  hangTimeoutMs: 5000,
  idleTimeoutMs: 10000,
};

beforeEach(() => {
  vi.useFakeTimers();
  (execa as any).mockReset?.();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LongRunningProcess', () => {
  it('spawns with correct args', () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess({ ...baseOpts, tools: ['Read', 'Bash'], addDirs: ['/workspace'] });
    const ok = proc.spawn();

    expect(ok).toBe(true);
    expect(proc.state).toBe('idle');
    expect(proc.isAlive).toBe(true);

    const callArgs = (execa as any).mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--input-format');
    expect(callArgs).toContain('stream-json');
    expect(callArgs).toContain('--output-format');
    expect(callArgs).toContain('--verbose');
    expect(callArgs).toContain('--include-partial-messages');
    expect(callArgs).toContain('--model');
    expect(callArgs).toContain('opus');
    expect(callArgs).toContain('--dangerously-skip-permissions');
    expect(callArgs).toContain('--tools');
    expect(callArgs).toContain('Read,Bash');
    expect(callArgs).toContain('--add-dir');
    expect(callArgs).toContain('/workspace');
    // -p is required for --input-format stream-json
    expect(callArgs).toContain('-p');
  });

  it('first turn yields text_delta and text_final from stream', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    const events: any[] = [];
    const gen = proc.sendTurn('Hello');

    // Simulate stdout data arriving
    const resultLine = JSON.stringify({ type: 'message_delta', text: 'Hi there' });
    const finalLine = JSON.stringify({ type: 'result', result: 'Hi there' });

    // Process events in microtasks
    queueMicrotask(() => {
      mock.stdout.emit('data', resultLine + '\n' + finalLine + '\n');
    });

    for await (const evt of gen) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_delta')?.text).toBe('Hi there');
    expect(events.find((e) => e.type === 'text_final')?.text).toBe('Hi there');
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
    expect(proc.state).toBe('idle');

    // Verify stdin was written with correct NDJSON (API-shaped message)
    const written = mock.stdin.write.mock.calls[0]?.[0];
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('Hello');
  });

  it('second turn reuses the same process', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    // First turn
    queueMicrotask(() => {
      mock.stdout.emit('data', JSON.stringify({ type: 'result', result: 'response1' }) + '\n');
    });
    const events1: any[] = [];
    for await (const evt of proc.sendTurn('turn1')) {
      events1.push(evt);
    }
    expect(events1.find((e) => e.type === 'text_final')?.text).toBe('response1');
    expect(proc.state).toBe('idle');

    // Second turn (should reuse, not respawn)
    queueMicrotask(() => {
      mock.stdout.emit('data', JSON.stringify({ type: 'result', result: 'response2' }) + '\n');
    });
    const events2: any[] = [];
    for await (const evt of proc.sendTurn('turn2')) {
      events2.push(evt);
    }
    expect(events2.find((e) => e.type === 'text_final')?.text).toBe('response2');
    expect(proc.state).toBe('idle');

    // execa should have been called only once
    expect((execa as any).mock.calls).toHaveLength(1);
  });

  it('hang timeout triggers error and kills process', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess({ ...baseOpts, hangTimeoutMs: 1000 });
    proc.spawn();

    const events: any[] = [];
    const genPromise = (async () => {
      for await (const evt of proc.sendTurn('Hello')) {
        events.push(evt);
      }
    })();

    // No stdout data arrives — advance past hang timeout
    await vi.advanceTimersByTimeAsync(1100);

    await genPromise;

    expect(events.find((e) => e.type === 'error')?.message).toContain('hang detected');
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
    expect(proc.state).toBe('dead');
  });

  it('idle timeout kills idle process', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess({ ...baseOpts, idleTimeoutMs: 2000 });
    proc.spawn();
    expect(proc.state).toBe('idle');

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(2100);

    expect(proc.state).toBe('dead');
  });

  it('process crash during turn emits error + done', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    const events: any[] = [];
    const genPromise = (async () => {
      for await (const evt of proc.sendTurn('Hello')) {
        events.push(evt);
      }
    })();

    // Simulate process exit while busy
    queueMicrotask(() => {
      mock.resolve({ exitCode: 1 });
    });

    await genPromise;

    expect(events.find((e) => e.type === 'error')?.message).toContain('process exited unexpectedly');
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
    expect(proc.state).toBe('dead');
  });

  it('kill() while busy unblocks the consumer (emits done)', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    const events: any[] = [];
    const genPromise = (async () => {
      for await (const evt of proc.sendTurn('Hello')) {
        events.push(evt);
      }
    })();

    queueMicrotask(() => {
      proc.kill();
    });

    await genPromise;

    expect(events.find((e) => e.type === 'done')).toBeTruthy();
    expect(proc.state).toBe('dead');
    expect(events.find((e) => e.type === 'error')?.message).toBe('multi-turn: terminated');
  });

  it('forceKill() while busy unblocks the consumer (emits done)', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    const events: any[] = [];
    const genPromise = (async () => {
      for await (const evt of proc.sendTurn('Hello')) {
        events.push(evt);
      }
    })();

    queueMicrotask(() => {
      proc.forceKill();
    });

    await genPromise;

    expect(events.find((e) => e.type === 'done')).toBeTruthy();
    expect(proc.state).toBe('dead');
    expect(events.find((e) => e.type === 'error')?.message).toBe('multi-turn: terminated');
  });

  it('sendTurn on non-idle process yields error', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();
    proc.kill();

    const events: any[] = [];
    for await (const evt of proc.sendTurn('Hello')) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'error')?.message).toContain('cannot send turn');
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
  });

  it('kill() transitions to dead', () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();
    expect(proc.isAlive).toBe(true);

    proc.kill();
    expect(proc.state).toBe('dead');
    expect(proc.isAlive).toBe(false);
  });

  it('strips tool use blocks from final text', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    queueMicrotask(() => {
      mock.stdout.emit('data',
        JSON.stringify({ type: 'message_delta', text: 'thinking...' }) + '\n' +
        JSON.stringify({ type: 'message_delta', text: '<tool_use>read</tool_use>' }) + '\n' +
        JSON.stringify({ type: 'message_delta', text: 'The answer is 42.' }) + '\n' +
        JSON.stringify({ type: 'result', result: 'The answer is 42.' }) + '\n'
      );
    });

    const events: any[] = [];
    for await (const evt of proc.sendTurn('test')) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('The answer is 42.');
  });

  it('sendTurn with images writes content-block array to stdin', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    queueMicrotask(() => {
      mock.stdout.emit('data', JSON.stringify({ type: 'result', result: 'I see an image' }) + '\n');
    });

    const images = [{ base64: 'iVBORw0KGgo=', mediaType: 'image/png' }];
    const events: any[] = [];
    for await (const evt of proc.sendTurn('Describe this', images)) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('I see an image');

    // Verify stdin was written with content-block array
    const written = mock.stdin.write.mock.calls[0]?.[0];
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content[0]).toEqual({ type: 'text', text: 'Describe this' });
    expect(parsed.message.content[1].type).toBe('image');
    expect(parsed.message.content[1].source.type).toBe('base64');
    expect(parsed.message.content[1].source.media_type).toBe('image/png');
    expect(parsed.message.content[1].source.data).toBe('iVBORw0KGgo=');
  });

  it('spawns with --fallback-model, --max-budget-usd, --append-system-prompt when set', () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess({
      ...baseOpts,
      fallbackModel: 'sonnet',
      maxBudgetUsd: 7.5,
      appendSystemPrompt: 'You are Weston.',
    });
    proc.spawn();

    const callArgs = (execa as any).mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--fallback-model');
    expect(callArgs[callArgs.indexOf('--fallback-model') + 1]).toBe('sonnet');
    expect(callArgs).toContain('--max-budget-usd');
    expect(callArgs[callArgs.indexOf('--max-budget-usd') + 1]).toBe('7.5');
    expect(callArgs).toContain('--append-system-prompt');
    expect(callArgs[callArgs.indexOf('--append-system-prompt') + 1]).toBe('You are Weston.');
  });

  it('omits new flags when not set', () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    const callArgs = (execa as any).mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--fallback-model');
    expect(callArgs).not.toContain('--max-budget-usd');
    expect(callArgs).not.toContain('--append-system-prompt');
  });

  it('sendTurn without images writes plain string content (no regression)', async () => {
    const mock = createMockSubprocess();
    (execa as any).mockReturnValue(mock.proc);

    const proc = new LongRunningProcess(baseOpts);
    proc.spawn();

    queueMicrotask(() => {
      mock.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
    });

    const events: any[] = [];
    for await (const evt of proc.sendTurn('Hello')) {
      events.push(evt);
    }

    const written = mock.stdin.write.mock.calls[0]?.[0];
    const parsed = JSON.parse(written.trim());
    expect(parsed.message.content).toBe('Hello');
  });
});
