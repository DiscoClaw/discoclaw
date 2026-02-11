import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

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
