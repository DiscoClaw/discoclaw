import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  createClaudeCliRuntime,
  extractImageFromUnknownEvent,
  extractResultContentBlocks,
  imageDedupeKey,
} from './claude-code-cli.js';

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

  it('stream-json prefers result event text over merged deltas', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJson({
      lines: [
        JSON.stringify({ type: 'message_delta', text: 'thinking...' }),
        JSON.stringify({ type: 'message_delta', text: '<tool_use>read file</tool_use>' }),
        JSON.stringify({ type: 'message_delta', text: 'The answer is 42.' }),
        JSON.stringify({ type: 'result', result: 'The answer is 42.' }),
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

    // Should use the clean result text, not the merged deltas with tool_use blocks.
    expect(events.find((e) => e.type === 'text_final')?.text).toBe('The answer is 42.');
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

  it('--fallback-model is passed when set', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      fallbackModel: 'sonnet',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--fallback-model');
    expect(callArgs[callArgs.indexOf('--fallback-model') + 1]).toBe('sonnet');
  });

  it('--fallback-model is omitted when unset', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--fallback-model');
  });

  it('--max-budget-usd is passed when set', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      maxBudgetUsd: 5,
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--max-budget-usd');
    expect(callArgs[callArgs.indexOf('--max-budget-usd') + 1]).toBe('5');
  });

  it('--max-budget-usd is omitted when unset', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--max-budget-usd');
  });

  it('--append-system-prompt is passed when set', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      appendSystemPrompt: 'You are Weston.',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--append-system-prompt');
    expect(callArgs[callArgs.indexOf('--append-system-prompt') + 1]).toBe('You are Weston.');
  });

  it('--append-system-prompt is omitted when unset', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--append-system-prompt');
  });

  it('--verbose is passed when enabled', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    // Note: verbose: true with outputFormat: 'text' is prevented by the config layer,
    // but we test the runtime layer in isolation here.
    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'stream-json',
      verbose: true,
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--verbose');
  });

  it('--verbose is omitted when disabled', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      verbose: false,
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--verbose');
  });

  it('--verbose is omitted when unset', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    for await (const _evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).not.toContain('--verbose');
  });

  it('stream-json emits image_data from streaming content blocks', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJson({
      lines: [
        JSON.stringify({ type: 'message_delta', text: 'Here is an image:' }),
        JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'stream-json',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      events.push(evt);
    }

    const imageEvents = events.filter((e) => e.type === 'image_data');
    expect(imageEvents).toHaveLength(1);
    expect(imageEvents[0].image.mediaType).toBe('image/png');
    expect(imageEvents[0].image.base64).toBe('iVBORw0KGgo=');
  });

  it('stream-json emits image_data from result content block arrays', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJson({
      lines: [
        JSON.stringify({
          type: 'result',
          result: [
            { type: 'text', text: 'Generated image:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
          ],
        }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'stream-json',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      events.push(evt);
    }

    const imageEvents = events.filter((e) => e.type === 'image_data');
    expect(imageEvents).toHaveLength(1);
    expect(imageEvents[0].image.mediaType).toBe('image/jpeg');
    expect(events.find((e) => e.type === 'text_final')?.text).toBe('Generated image:');
  });

  it('deduplicates identical images from streaming and result events', async () => {
    const imgData = 'iVBORw0KGgo=';
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJson({
      lines: [
        JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } }),
        JSON.stringify({
          type: 'result',
          result: [
            { type: 'text', text: 'Done' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } },
          ],
        }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'stream-json',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) {
      events.push(evt);
    }

    const imageEvents = events.filter((e) => e.type === 'image_data');
    expect(imageEvents).toHaveLength(1);
  });
});

describe('extractImageFromUnknownEvent', () => {
  it('extracts direct image content block', () => {
    const evt = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } };
    const result = extractImageFromUnknownEvent(evt);
    expect(result).toEqual({ base64: 'abc123', mediaType: 'image/png' });
  });

  it('extracts content_block_start wrapper', () => {
    const evt = { content_block: { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'xyz' } } };
    const result = extractImageFromUnknownEvent(evt);
    expect(result).toEqual({ base64: 'xyz', mediaType: 'image/webp' });
  });

  it('returns null for missing fields', () => {
    expect(extractImageFromUnknownEvent(null)).toBeNull();
    expect(extractImageFromUnknownEvent({})).toBeNull();
    expect(extractImageFromUnknownEvent({ type: 'image' })).toBeNull();
    expect(extractImageFromUnknownEvent({ type: 'image', source: { type: 'url' } })).toBeNull();
  });

  it('returns null for oversized base64', () => {
    const bigData = 'a'.repeat(26 * 1024 * 1024);
    const evt = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigData } };
    expect(extractImageFromUnknownEvent(evt)).toBeNull();
  });
});

describe('extractResultContentBlocks', () => {
  it('extracts text and images from array result', () => {
    const evt = {
      type: 'result',
      result: [
        { type: 'text', text: 'Hello' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
    };
    const result = extractResultContentBlocks(evt);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Hello');
    expect(result!.images).toHaveLength(1);
    expect(result!.images[0].mediaType).toBe('image/png');
  });

  it('returns null for plain string result', () => {
    const evt = { type: 'result', result: 'just text' };
    expect(extractResultContentBlocks(evt)).toBeNull();
  });

  it('returns null for non-result event', () => {
    expect(extractResultContentBlocks({ type: 'message_delta', text: 'hi' })).toBeNull();
  });

  it('handles empty array', () => {
    const result = extractResultContentBlocks({ type: 'result', result: [] });
    expect(result).not.toBeNull();
    expect(result!.text).toBe('');
    expect(result!.images).toHaveLength(0);
  });
});

describe('imageDedupeKey', () => {
  it('creates consistent key for same image', () => {
    const img = { base64: 'abc', mediaType: 'image/png' };
    expect(imageDedupeKey(img)).toBe('image/png:3:abc');
    expect(imageDedupeKey(img)).toBe(imageDedupeKey({ ...img }));
  });

  it('different images produce different keys', () => {
    const a = { base64: 'abc', mediaType: 'image/png' };
    const b = { base64: 'xyz', mediaType: 'image/png' };
    expect(imageDedupeKey(a)).not.toBe(imageDedupeKey(b));
  });

  it('uses prefix + length to avoid storing full base64', () => {
    const longData = 'a'.repeat(1000);
    const img = { base64: longData, mediaType: 'image/png' };
    const key = imageDedupeKey(img);
    // Key should be much shorter than the full base64 string
    expect(key.length).toBeLessThan(200);
    expect(key).toContain(':1000:');
  });

  it('distinguishes images with same prefix but different lengths', () => {
    const a = { base64: 'a'.repeat(100), mediaType: 'image/png' };
    const b = { base64: 'a'.repeat(200), mediaType: 'image/png' };
    expect(imageDedupeKey(a)).not.toBe(imageDedupeKey(b));
  });
});

describe('one-shot with images', () => {
  function makeProcessStreamJsonWithStdin(args: { lines: string[]; exitCode: number }) {
    const p: any = Promise.resolve({ exitCode: args.exitCode });
    p.stdout = Readable.from(args.lines.map((l) => l + '\n'));
    p.stderr = Readable.from([]);
    p.stdin = { write: vi.fn(), end: vi.fn() };
    return p;
  }

  it('uses stdin pipe + stream-json input when images are present', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJsonWithStdin({
      lines: [
        JSON.stringify({ type: 'message_delta', text: 'I see a cat' }),
        JSON.stringify({ type: 'result', result: 'I see a cat' }),
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
      prompt: 'What is in this image?',
      model: 'opus',
      cwd: '/tmp',
      images: [{ base64: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('I see a cat');

    // Verify args
    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--input-format');
    expect(callArgs).toContain('stream-json');
    // Prompt should NOT be in positional args
    expect(callArgs).not.toContain('--');
    expect(callArgs).not.toContain('What is in this image?');

    // Verify stdin options
    const callOpts = execaMock.mock.calls[0]?.[2] ?? {};
    expect(callOpts.stdin).toBe('pipe');

    // Verify stdin was written with content blocks
    const proc = execaMock.mock.results[0].value;
    expect(proc.stdin.write).toHaveBeenCalledOnce();
    const written = proc.stdin.write.mock.calls[0][0];
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('user');
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(parsed.message.content[1].type).toBe('image');
    expect(parsed.message.content[1].source.media_type).toBe('image/png');
    expect(proc.stdin.end).toHaveBeenCalledOnce();
  });

  it('without images: uses positional arg and stdin ignore (no regression)', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'hello', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'plain text prompt',
      model: 'opus',
      cwd: '/tmp',
    })) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('hello');

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    // Prompt must follow `--` separator
    const sepIdx = callArgs.indexOf('--');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(callArgs[sepIdx + 1]).toBe('plain text prompt');
    // Should NOT have --input-format
    expect(callArgs).not.toContain('--input-format');

    const callOpts = execaMock.mock.calls[0]?.[2] ?? {};
    expect(callOpts.stdin).toBe('ignore');
  });

  it('no duplicate --output-format when images override text format', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJsonWithStdin({
      lines: [
        JSON.stringify({ type: 'result', result: 'ok' }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
    });

    for await (const _evt of rt.invoke({
      prompt: 'describe',
      model: 'opus',
      cwd: '/tmp',
      images: [{ base64: 'abc', mediaType: 'image/jpeg' }],
    })) {
      // drain
    }

    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    const outputFormatCount = callArgs.filter((a: string) => a === '--output-format').length;
    expect(outputFormatCount).toBe(1);
  });

  it('images with text outputFormat forces stream-json output', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessStreamJsonWithStdin({
      lines: [
        JSON.stringify({ type: 'result', result: 'Described image' }),
      ],
      exitCode: 0,
    }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'describe',
      model: 'opus',
      cwd: '/tmp',
      images: [{ base64: 'abc', mediaType: 'image/jpeg' }],
    })) {
      events.push(evt);
    }

    expect(events.find((e) => e.type === 'text_final')?.text).toBe('Described image');

    // Even though opts.outputFormat is 'text', args should include stream-json output
    const callArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(callArgs).toContain('--input-format');
    // Should have --output-format stream-json added for images
    const outputFormatIdx = callArgs.lastIndexOf('--output-format');
    expect(callArgs[outputFormatIdx + 1]).toBe('stream-json');
  });
});

describe('pool forwarding (multi-turn opts wiring)', () => {
  it('forwards fallbackModel, maxBudgetUsd, and appendSystemPrompt to LongRunningProcess', async () => {
    const execaMock = execa as any;
    // The pool path will spawn a LongRunningProcess which calls execa internally.
    // makeProcessText returns an immediately-resolved process, so the LRP detects a
    // dead subprocess and falls back to one-shot. We verify both calls: the first
    // (LRP spawn) should have multi-turn flags, the second (one-shot fallback) should
    // have the same runtime opts.
    execaMock.mockImplementation(() => {
      return makeProcessText({ stdout: 'ok', exitCode: 0 });
    });

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
      fallbackModel: 'sonnet',
      maxBudgetUsd: 10,
      appendSystemPrompt: 'You are a helpful PA.',
      multiTurn: true,
      multiTurnMaxProcesses: 2,
      multiTurnHangTimeoutMs: 1000,
      multiTurnIdleTimeoutMs: 5000,
    });

    // Invoke with a sessionKey to trigger the pool path.
    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'test prompt',
      model: 'opus',
      cwd: '/tmp',
      sessionKey: 'test-session',
    })) {
      events.push(evt);
    }

    // Must have at least 2 execa calls: LRP spawn + one-shot fallback.
    expect(execaMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // First call is the LRP spawn — must have --input-format stream-json (LRP signature).
    const lrpArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(lrpArgs).toContain('--input-format');
    expect(lrpArgs[lrpArgs.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(lrpArgs).toContain('--fallback-model');
    expect(lrpArgs[lrpArgs.indexOf('--fallback-model') + 1]).toBe('sonnet');
    expect(lrpArgs).toContain('--max-budget-usd');
    expect(lrpArgs[lrpArgs.indexOf('--max-budget-usd') + 1]).toBe('10');
    expect(lrpArgs).toContain('--append-system-prompt');
    expect(lrpArgs[lrpArgs.indexOf('--append-system-prompt') + 1]).toBe('You are a helpful PA.');

    // Second call is the one-shot fallback — should also carry the runtime opts.
    const oneShotArgs = execaMock.mock.calls[1]?.[1] ?? [];
    expect(oneShotArgs).toContain('--fallback-model');
    expect(oneShotArgs[oneShotArgs.indexOf('--fallback-model') + 1]).toBe('sonnet');
    expect(oneShotArgs).toContain('--max-budget-usd');
    expect(oneShotArgs[oneShotArgs.indexOf('--max-budget-usd') + 1]).toBe('10');
    expect(oneShotArgs).toContain('--append-system-prompt');
    expect(oneShotArgs[oneShotArgs.indexOf('--append-system-prompt') + 1]).toBe('You are a helpful PA.');
  });

  it('forwards --verbose to LongRunningProcess', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
      verbose: true,
      multiTurn: true,
      multiTurnMaxProcesses: 2,
      multiTurnHangTimeoutMs: 1000,
      multiTurnIdleTimeoutMs: 5000,
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'test prompt',
      model: 'opus',
      cwd: '/tmp',
      sessionKey: 'test-session',
    })) {
      events.push(evt);
    }

    // First call is the LRP spawn (has --input-format stream-json as LRP signature).
    const lrpArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(lrpArgs).toContain('--verbose');

    // Second call (one-shot fallback) should also have --verbose.
    if (execaMock.mock.calls.length >= 2) {
      const oneShotArgs = execaMock.mock.calls[1]?.[1] ?? [];
      expect(oneShotArgs).toContain('--verbose');
    }
  });

  it('--verbose is omitted from LongRunningProcess when disabled', async () => {
    const execaMock = execa as any;
    execaMock.mockImplementation(() => makeProcessText({ stdout: 'ok', exitCode: 0 }));

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: true,
      outputFormat: 'text',
      verbose: false,
      multiTurn: true,
      multiTurnMaxProcesses: 2,
      multiTurnHangTimeoutMs: 1000,
      multiTurnIdleTimeoutMs: 5000,
    });

    const events: any[] = [];
    for await (const evt of rt.invoke({
      prompt: 'test prompt',
      model: 'opus',
      cwd: '/tmp',
      sessionKey: 'test-session',
    })) {
      events.push(evt);
    }

    // First call is the LRP spawn.
    const lrpArgs = execaMock.mock.calls[0]?.[1] ?? [];
    expect(lrpArgs).not.toContain('--verbose');
  });
});

describe('one-shot stream stall timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Create a mock process with controllable stdout/stderr streams and deferred exit. */
  function makeControllableProcess() {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveProcess: (val: any) => void;
    const processPromise: any = new Promise((r) => { resolveProcess = r; });
    processPromise.stdout = stdout;
    processPromise.stderr = stderr;
    processPromise.stdin = 'ignore';
    processPromise.kill = vi.fn(() => {
      stdout.end();
      stderr.end();
      resolveProcess!({ exitCode: null, failed: true, killed: true });
    });
    processPromise.then = processPromise.then.bind(processPromise);
    processPromise.catch = processPromise.catch.bind(processPromise);
    return { proc: processPromise, stdout, stderr, resolve: resolveProcess!, kill: processPromise.kill };
  }

  it('fires stall timer and kills process when no stdout arrives', async () => {
    const { proc } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 5000,
    });

    const events: any[] = [];
    const iter = rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' });
    const drainPromise = (async () => {
      for await (const evt of iter) events.push(evt);
    })();

    // Advance past the stall timeout.
    await vi.advanceTimersByTimeAsync(6000);
    await drainPromise;

    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('resets stall timer when stdout data arrives', async () => {
    const { proc, stdout, stderr, resolve } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 5000,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    // Advance 3s, push data (resets timer), then advance 3s more.
    await vi.advanceTimersByTimeAsync(3000);
    stdout.write('hello');
    // Let microtasks propagate the 'data' event handler (which calls resetStallTimer).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    // Should not have stalled (3s + 3s = 6s but timer was reset at 3s, so only 3s of silence).
    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(false);

    // Clean up: end the process normally.
    stdout.end();
    stderr.end();
    resolve({ exitCode: 0, stdout: 'hello', stderr: '' });
    await vi.advanceTimersByTimeAsync(100);
    await drainPromise;
  });

  it('resets stall timer when stderr data arrives', async () => {
    const { proc, stderr, resolve, stdout } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 5000,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    // Advance 3s, push stderr (resets timer), then advance 3s more.
    await vi.advanceTimersByTimeAsync(3000);
    stderr.write('debug output');
    await vi.advanceTimersByTimeAsync(3000);

    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(false);

    stdout.end();
    stderr.end();
    resolve({ exitCode: 0, stdout: '', stderr: 'debug output' });
    await vi.advanceTimersByTimeAsync(100);
    await drainPromise;
  });

  it('does not fire stall timer when set to 0 (disabled)', async () => {
    const { proc, resolve, stdout, stderr } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 0,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    // Advance past what would be a timeout.
    await vi.advanceTimersByTimeAsync(200000);
    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(false);

    stdout.write('ok');
    stdout.end();
    stderr.end();
    resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
    await vi.advanceTimersByTimeAsync(100);
    await drainPromise;
  });

  it('cleans up stall timer on normal process exit', async () => {
    const { proc, stdout, stderr, resolve } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 10000,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    // Normal exit before stall timeout.
    stdout.write('done');
    stdout.end();
    stderr.end();
    resolve({ exitCode: 0, stdout: 'done', stderr: '' });
    await vi.advanceTimersByTimeAsync(100);
    await drainPromise;

    // Advance well past the stall timeout — should not fire (timer was cleaned up).
    await vi.advanceTimersByTimeAsync(20000);
    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(false);
  });

  it('emits only one error+done when stall timer fires and process rejects', async () => {
    // When the stall timer fires it pushes error+done and kills the process.
    // If the kill causes the process promise to reject (as real execa does),
    // the .catch() handler must not push a second error+done pair.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let rejectProcess: (err: any) => void;
    const processPromise: any = new Promise((_r, rej) => { rejectProcess = rej; });
    processPromise.stdout = stdout;
    processPromise.stderr = stderr;
    processPromise.stdin = 'ignore';
    processPromise.kill = vi.fn(() => {
      stdout.end();
      stderr.end();
      rejectProcess!(Object.assign(new Error('killed'), { killed: true, failed: true }));
    });
    processPromise.then = processPromise.then.bind(processPromise);
    processPromise.catch = processPromise.catch.bind(processPromise);

    const execaMock = execa as any;
    execaMock.mockImplementation(() => processPromise);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'text',
      streamStallTimeoutMs: 5000,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    await vi.advanceTimersByTimeAsync(6000);
    await drainPromise;

    const errors = events.filter((e) => e.type === 'error');
    const dones = events.filter((e) => e.type === 'done');
    expect(errors).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(errors[0].message).toContain('stream stall');
  });

  it('works with stream-json output format', async () => {
    const { proc } = makeControllableProcess();
    const execaMock = execa as any;
    execaMock.mockImplementation(() => proc);

    const rt = createClaudeCliRuntime({
      claudeBin: 'claude',
      dangerouslySkipPermissions: false,
      outputFormat: 'stream-json',
      streamStallTimeoutMs: 5000,
    });

    const events: any[] = [];
    const drainPromise = (async () => {
      for await (const evt of rt.invoke({ prompt: 'p', model: 'opus', cwd: '/tmp' })) events.push(evt);
    })();

    await vi.advanceTimersByTimeAsync(6000);
    await drainPromise;

    expect(events.some((e) => e.type === 'error' && e.message.includes('stream stall'))).toBe(true);
  });
});
