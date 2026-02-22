import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineEvent } from './types.js';
import { SessionFileScanner } from './session-scanner.js';
import { toolActivityLabel } from './tool-labels.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join('/tmp', 'scanner-test-'));
  // Mock os.homedir() to point at our temp dir so the scanner finds session files there.
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function sessionDir(cwd: string): string {
  const escaped = cwd.replace(/\//g, '-');
  return path.join(tmpDir, '.claude', 'projects', escaped);
}

async function ensureSessionFile(cwd: string, sessionId: string): Promise<string> {
  const dir = sessionDir(cwd);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, '', 'utf8');
  return filePath;
}

function makeToolUse(id: string, name: string, input?: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id, name, input: input ?? {} },
      ],
    },
  });
}

function makeToolResult(toolUseId: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError },
      ],
    },
  });
}

describe('SessionFileScanner', () => {
  it('detects tool_use and emits tool_start', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-1';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    // Write a tool_use line after start.
    await fsp.appendFile(filePath, makeToolUse('block-1', 'Read', { file_path: '/tmp/foo.ts' }) + '\n');

    // Give the watcher/poll time to pick it up.
    await new Promise((r) => setTimeout(r, 300));

    scanner.stop();

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({
      type: 'tool_start',
      name: 'Read',
      input: { file_path: '/tmp/foo.ts' },
    });
  });

  it('detects tool_result and emits tool_end with correct name/ok', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-2';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    await fsp.appendFile(filePath, makeToolUse('block-2', 'Bash') + '\n');
    await fsp.appendFile(filePath, makeToolResult('block-2', false) + '\n');

    await new Promise((r) => setTimeout(r, 300));
    scanner.stop();

    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]).toMatchObject({
      type: 'tool_end',
      name: 'Bash',
      ok: true,
    });
  });

  it('handles tool_result with is_error=true', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-err';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    await fsp.appendFile(filePath, makeToolUse('block-e', 'Edit') + '\n');
    await fsp.appendFile(filePath, makeToolResult('block-e', true) + '\n');

    await new Promise((r) => setTimeout(r, 300));
    scanner.stop();

    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]).toMatchObject({
      type: 'tool_end',
      name: 'Edit',
      ok: false,
    });
  });

  it('handles multiple sequential tools', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-3';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    await fsp.appendFile(filePath,
      makeToolUse('b1', 'Read') + '\n' +
      makeToolResult('b1') + '\n' +
      makeToolUse('b2', 'Bash') + '\n' +
      makeToolResult('b2') + '\n',
    );

    await new Promise((r) => setTimeout(r, 300));
    scanner.stop();

    const starts = events.filter((e) => e.type === 'tool_start');
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]).toMatchObject({ name: 'Read' });
    expect(starts[1]).toMatchObject({ name: 'Bash' });
    expect(ends[0]).toMatchObject({ name: 'Read' });
    expect(ends[1]).toMatchObject({ name: 'Bash' });
  });

  it('handles partial line buffering', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-4';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    // Write a partial line (no newline).
    const fullLine = makeToolUse('b-partial', 'Grep');
    const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2));
    const half2 = fullLine.slice(Math.floor(fullLine.length / 2));

    await fsp.appendFile(filePath, half1);
    await new Promise((r) => setTimeout(r, 300));

    // No events yet — line is incomplete.
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(0);

    // Complete the line.
    await fsp.appendFile(filePath, half2 + '\n');
    await new Promise((r) => setTimeout(r, 300));

    scanner.stop();

    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ name: 'Grep' });
  });

  it('degrades gracefully when file does not exist', async () => {
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId: 'nonexistent', cwd: '/nonexistent/path' },
      { onEvent: (evt) => events.push(evt) },
    );

    // Should not throw, should resolve within ~10s.
    // We set a shorter timeout by testing that it doesn't crash.
    await scanner.start();
    scanner.stop();

    expect(events).toHaveLength(0);
  }, 15_000);

  it('skips pre-existing content', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-5';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    // Write content before scanner starts.
    await fsp.appendFile(filePath, makeToolUse('old-1', 'Read') + '\n');
    await fsp.appendFile(filePath, makeToolResult('old-1') + '\n');

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    // Write new content after scanner starts.
    await fsp.appendFile(filePath, makeToolUse('new-1', 'Bash') + '\n');
    await new Promise((r) => setTimeout(r, 300));

    scanner.stop();

    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ name: 'Bash' });
  });

  it('emits no events after stop()', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-6';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();
    scanner.stop();

    const countAfterStop = events.length;

    // Write content after stop.
    await fsp.appendFile(filePath, makeToolUse('late-1', 'Write') + '\n');
    await new Promise((r) => setTimeout(r, 500));

    expect(events).toHaveLength(countAfterStop);
  });

  it('stop() emits tool_end for still-active tools', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-7';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    // Start a tool but don't finish it.
    await fsp.appendFile(filePath, makeToolUse('dangling', 'Bash') + '\n');
    await new Promise((r) => setTimeout(r, 300));

    scanner.stop();

    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ name: 'Bash', ok: true });
  });

  it('concurrent readNewBytes calls do not produce duplicate events', async () => {
    const cwd = '/home/test/code/proj';
    const sessionId = 'test-session-concurrent';
    const filePath = await ensureSessionFile(cwd, sessionId);
    const events: EngineEvent[] = [];

    const scanner = new SessionFileScanner(
      { sessionId, cwd },
      { onEvent: (evt) => events.push(evt) },
    );

    await scanner.start();

    // Write a tool_use line.
    await fsp.appendFile(filePath, makeToolUse('conc-1', 'Read') + '\n');

    // Trigger readNewBytes concurrently by calling the scanner's
    // internal method multiple times. Access via the poll/watch mechanism
    // by triggering a rapid series of file changes.
    await fsp.appendFile(filePath, makeToolUse('conc-2', 'Bash') + '\n');
    await fsp.appendFile(filePath, makeToolResult('conc-1') + '\n');
    await fsp.appendFile(filePath, makeToolResult('conc-2') + '\n');

    await new Promise((r) => setTimeout(r, 500));
    scanner.stop();

    // Verify each tool_start appears exactly once.
    const starts = events.filter((e) => e.type === 'tool_start');
    const readStarts = starts.filter((e) => e.type === 'tool_start' && e.name === 'Read');
    const bashStarts = starts.filter((e) => e.type === 'tool_start' && e.name === 'Bash');
    expect(readStarts).toHaveLength(1);
    expect(bashStarts).toHaveLength(1);

    // Verify each tool_end appears exactly once.
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends).toHaveLength(2);
  });
});

describe('toolActivityLabel', () => {
  it('returns file-specific label for Read', () => {
    expect(toolActivityLabel('Read', { file_path: '/home/user/code/proj/src/index.ts' }))
      .toBe('Reading .../src/index.ts');
  });

  it('returns generic label for Read without input', () => {
    expect(toolActivityLabel('Read')).toBe('Reading file...');
  });

  it('returns label for Bash', () => {
    expect(toolActivityLabel('Bash')).toBe('Running command...');
  });

  it('returns label for Grep', () => {
    expect(toolActivityLabel('Grep')).toBe('Searching content...');
  });

  it('returns fallback for unknown tools', () => {
    expect(toolActivityLabel('CustomTool')).toBe('Running CustomTool...');
  });

  it('handles short paths without truncation', () => {
    expect(toolActivityLabel('Read', { file_path: 'src/foo.ts' }))
      .toBe('Reading src/foo.ts');
  });
});
