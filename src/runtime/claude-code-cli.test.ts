import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { createClaudeCliRuntime } from './claude-code-cli.js';

beforeEach(() => {
  (execa as any).mockReset?.();
});

function makeProcessText(args: { stdout: string; stderr?: string; exitCode: number }) {
  const p: any = Promise.resolve({
    stdout: args.stdout,
    stderr: args.stderr ?? '',
    exitCode: args.exitCode,
  });
  // Must be present or the adapter yields an error.
  p.stdout = Readable.from([]);
  p.stderr = Readable.from([]);
  return p;
}

function makeProcessStreamJson(args: { lines: string[]; exitCode: number }) {
  const p: any = Promise.resolve({ exitCode: args.exitCode });
  p.stdout = Readable.from(args.lines.map((l) => l + '\n'));
  p.stderr = Readable.from([]);
  return p;
}

describe('Claude CLI runtime adapter (smoke)', () => {
  it('text mode yields text_final', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'hello', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'p',
      model: 'opus',
      cwd: '/tmp',
      sessionId: 'sess',
      tools: ['Read', 'Bash'],
      addDirs: ['/w', '/c'],
      timeoutMs: 1234,
    })) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('hello');

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--model');
    expect(callArgs).toContain('opus');
    expect(callArgs).toContain('--session-id');
    expect(callArgs).toContain('sess');
    expect(callArgs).toContain('--tools');
    expect(callArgs).toContain('Read,Bash');

    // --add-dir should be repeated per directory
    const addDirIndices = callArgs
      .map((v: string, i: number) => v === '--add-dir' ? i : -1)
      .filter((i: number) => i >= 0);
    expect(addDirIndices).toHaveLength(2);
    expect(callArgs[addDirIndices[0] + 1]).toBe('/w');
    expect(callArgs[addDirIndices[1] + 1]).toBe('/c');

    // Prompt must follow `--` separator
    const sepIdx = callArgs.indexOf('--');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(callArgs[sepIdx + 1]).toBe('p');
  });

  it('stream-json mode yields merged text_final', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJson({
      lines: [
        JSON.stringify({ type: 'message_delta', text: 'Hello' }),
        JSON.stringify({ type: 'message_delta', text: ' world' }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'stream-json',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'p',
      model: 'opus',
      cwd: '/tmp',
    })) {
      events.push(evt);
    }

    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toBe('Hello world');
    expect(events.find((e) => e.type === 'text_final')?.text).toBe('Hello world');

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--output-format');
    expect(callArgs).toContain('stream-json');
    expect(callArgs).toContain('--dangerously-skip-permissions');
    expect(callArgs).toContain('--include-partial-messages');

    // Prompt must follow `--` separator
    const sepIdx = callArgs.indexOf('--');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(callArgs[sepIdx + 1]).toBe('p');
  });

  it('explicit empty tools uses --tools= syntax', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'p',
      model: 'opus',
      cwd: '/tmp',
      tools: [],
    })) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('ok');
    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];

    // Should use `--tools=` (single element) not `--tools` + `''` (two elements)
    expect(callArgs).toContain('--tools=');
    expect(callArgs.filter((x: string) => x === '--tools')).toHaveLength(0);

    // Prompt must follow `--` separator
    const sepIdx = callArgs.indexOf('--');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(callArgs[sepIdx + 1]).toBe('p');
  });

  it('--strict-mcp-config is passed when enabled', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      strictMcpConfig: true,
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--strict-mcp-config');
  });

  it('--strict-mcp-config is omitted when disabled', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      strictMcpConfig: false,
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--strict-mcp-config');
  });
});
