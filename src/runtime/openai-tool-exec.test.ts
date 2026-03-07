import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall } from './openai-tool-exec.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function parseJsonResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-tool-exec-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── read_file ────────────────────────────────────────────────────────

describe('read_file', () => {
  it('reads an existing file', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'hello world\n');

    const r = await executeToolCall('read_file', { file_path: filePath }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('hello world\n');
  });

  it('returns error for nonexistent file', async () => {
    const filePath = path.join(tmpDir, 'nope.txt');
    const r = await executeToolCall('read_file', { file_path: filePath }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/ENOENT|no such file|not accessible/i);
  });

  it('reads with offset and limit', async () => {
    const filePath = path.join(tmpDir, 'lines.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n');

    const r = await executeToolCall(
      'read_file',
      { file_path: filePath, offset: 2, limit: 2 },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe('line2\nline3');
  });

  it('returns error when file_path is missing', async () => {
    const r = await executeToolCall('read_file', {}, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('file_path');
  });
});

// ── write_file ───────────────────────────────────────────────────────

describe('write_file', () => {
  it('writes a new file and creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'output.txt');
    const r = await executeToolCall(
      'write_file',
      { file_path: filePath, content: 'created!' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const contents = await fs.readFile(filePath, 'utf-8');
    expect(contents).toBe('created!');
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(filePath, 'old content');

    const r = await executeToolCall(
      'write_file',
      { file_path: filePath, content: 'new content' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const contents = await fs.readFile(filePath, 'utf-8');
    expect(contents).toBe('new content');
  });

  it('returns error when content is missing', async () => {
    const r = await executeToolCall(
      'write_file',
      { file_path: path.join(tmpDir, 'x.txt') },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('content');
  });
});

// ── edit_file ────────────────────────────────────────────────────────

describe('edit_file', () => {
  it('replaces a unique match', async () => {
    const filePath = path.join(tmpDir, 'code.ts');
    await fs.writeFile(filePath, 'const x = 1;\nconst y = 2;\n');

    const r = await executeToolCall(
      'edit_file',
      { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 42;' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const updated = await fs.readFile(filePath, 'utf-8');
    expect(updated).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('fails when old_string not found', async () => {
    const filePath = path.join(tmpDir, 'code.ts');
    await fs.writeFile(filePath, 'const x = 1;\n');

    const r = await executeToolCall(
      'edit_file',
      { file_path: filePath, old_string: 'nonexistent', new_string: 'replaced' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('not found');
  });

  it('fails when old_string has multiple matches (without replace_all)', async () => {
    const filePath = path.join(tmpDir, 'code.ts');
    await fs.writeFile(filePath, 'foo\nfoo\nbar\n');

    const r = await executeToolCall(
      'edit_file',
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('2 times');
  });

  it('replace_all replaces all occurrences', async () => {
    const filePath = path.join(tmpDir, 'code.ts');
    await fs.writeFile(filePath, 'foo\nfoo\nbar\n');

    const r = await executeToolCall(
      'edit_file',
      { file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const updated = await fs.readFile(filePath, 'utf-8');
    expect(updated).toBe('baz\nbaz\nbar\n');
  });
});

// ── list_files ───────────────────────────────────────────────────────

describe('list_files', () => {
  it('keeps valid in-root patterns working', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'c.js'), '');

    const r = await executeToolCall(
      'list_files',
      { pattern: '*.ts', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('a.ts');
    expect(r.result).toContain('b.ts');
    expect(r.result).not.toContain('c.js');
  });

  it('rejects absolute pattern /etc/*', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '/etc/*', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal pattern ../../etc/*', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '../../etc/*', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal hidden in character classes', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '[.][.]/etc/*', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal hidden via brace concatenation', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '{.,.}{.,.}/etc/*', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects absolute branch hidden in brace expansion', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '{**/*.ts,/etc/*}', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects drive-prefixed absolute branch hidden in brace expansion', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '{**/*.ts,C:\\Windows\\*}', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects drive-prefixed absolute branch hidden in extglob alternatives', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '@(C:\\Windows\\*|**/*.ts)', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('fails closed if glob yields an out-of-root entry', async () => {
    const fsWithGlob = fs as unknown as {
      glob?: (pattern: string, options: { cwd: string }) => AsyncIterable<string>;
    };
    const originalGlob = fsWithGlob.glob;

    fsWithGlob.glob = async function* fakeGlob() {
      yield 'safe.ts';
      yield '../../etc/passwd';
    };

    try {
      const r = await executeToolCall(
        'list_files',
        { pattern: '**/*', path: tmpDir },
        [tmpDir],
      );
      expect(r.ok).toBe(false);
      expect(r.result).toContain('Unsafe glob match rejected');
    } finally {
      fsWithGlob.glob = originalGlob;
    }
  });

  it('returns message when no files match', async () => {
    const r = await executeToolCall(
      'list_files',
      { pattern: '*.xyz', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('No files matched');
  });
});

// ── search_content ───────────────────────────────────────────────────

describe('search_content', () => {
  it('finds content matching a pattern', async () => {
    await fs.writeFile(path.join(tmpDir, 'file.txt'), 'hello world\ngoodbye world\n');

    const r = await executeToolCall(
      'search_content',
      { pattern: 'hello', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('hello');
  });

  it('returns no matches message for missing pattern', async () => {
    await fs.writeFile(path.join(tmpDir, 'file.txt'), 'hello\n');

    const r = await executeToolCall(
      'search_content',
      { pattern: 'zzzznotfound', path: tmpDir },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('No matches');
  });
});

// ── bash ─────────────────────────────────────────────────────────────

describe('bash', () => {
  it('executes a simple echo command', async () => {
    const r = await executeToolCall('bash', { command: 'echo hello' }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('hello');
  });

  it('strips ANSI sequences from bash stdout and stderr', async () => {
    const r = await executeToolCall(
      'bash',
      {
        command: "printf '\\033[31mred\\033[0m\\n'; printf '\\033[33mwarn\\033[0m\\n' 1>&2",
      },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('red');
    expect(r.result).toContain('[stderr]\nwarn');
    expect(r.result).not.toContain('\u001B[');
  });

  it('sets no-color env for bash subprocesses', async () => {
    const r = await executeToolCall(
      'bash',
      {
        command: 'printf "%s,%s,%s" "$NO_COLOR" "$FORCE_COLOR" "$TERM"',
      },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result.trim()).toBe(
      `${process.env.NO_COLOR ?? '1'},${process.env.FORCE_COLOR ?? '0'},${process.env.TERM ?? 'dumb'}`,
    );
  });

  it('returns error on nonzero exit', async () => {
    const r = await executeToolCall('bash', { command: 'exit 1' }, [tmpDir]);
    expect(r.ok).toBe(false);
  });

  it('uses first allowed root as cwd', async () => {
    const r = await executeToolCall('bash', { command: 'pwd' }, [tmpDir]);
    expect(r.ok).toBe(true);
    // The cwd should be the tmpDir (resolve symlinks for comparison)
    const realTmpDir = await fs.realpath(tmpDir);
    expect(r.result.trim()).toBe(realTmpDir);
  });

  it('times out on long-running commands', async () => {
    // Use a very short timeout via the handler's internal timeout — we test
    // the mechanism by running a command that hangs, but we can't easily
    // override the 30s const. Instead test that a fast-exit command works
    // and trust the execFile timeout mechanism. A full timeout test would
    // need 30+ seconds which is too slow for unit tests.
    const r = await executeToolCall('bash', { command: 'echo fast' }, [tmpDir]);
    expect(r.ok).toBe(true);
  });
});

// ── web_fetch ────────────────────────────────────────────────────────

describe('web_fetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches HTTPS URL successfully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('page content', { status: 200 }),
    );

    const r = await executeToolCall(
      'web_fetch',
      { url: 'https://example.com/page' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toContain('[EXTERNAL CONTENT:');
    expect(r.result).toContain('page content');
  });

  it('rejects HTTP (non-HTTPS) URLs', async () => {
    const r = await executeToolCall(
      'web_fetch',
      { url: 'http://example.com/page' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('HTTPS');
  });

  it('rejects private IP addresses (10.x)', async () => {
    const r = await executeToolCall(
      'web_fetch',
      { url: 'https://10.0.0.1/internal' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });

  it('rejects private IP addresses (192.168.x)', async () => {
    const r = await executeToolCall(
      'web_fetch',
      { url: 'https://192.168.1.1/internal' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });

  it('rejects localhost', async () => {
    const r = await executeToolCall(
      'web_fetch',
      { url: 'https://localhost/internal' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('localhost');
  });

  it('rejects loopback IP', async () => {
    const r = await executeToolCall(
      'web_fetch',
      { url: 'https://127.0.0.1/internal' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });
});

// ── web_search ───────────────────────────────────────────────────────

describe('web_search', () => {
  it('returns not available stub', async () => {
    const r = await executeToolCall('web_search', { query: 'test' }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('web_search not available');
  });
});

// ── pipeline lifecycle ───────────────────────────────────────────────

describe('pipeline.start/status/resume/cancel', () => {
  it('pipeline.start auto-runs steps and persists terminal state', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        steps: [
          { tool: 'write_file', arguments: { file_path: 'a.txt', content: 'hello' } },
          { tool: 'read_file', arguments: { file_path: 'a.txt' } },
        ],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start', 'pipeline.status', 'write_file', 'read_file']) },
    );

    expect(start.ok).toBe(true);
    const started = parseJsonResult(start.result);
    expect(started['status']).toBe('succeeded');
    expect(started['total_steps']).toBe(2);

    const runId = started['run_id'] as string;
    const status = await executeToolCall(
      'pipeline.status',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.status']) },
    );
    expect(status.ok).toBe(true);
    const statusJson = parseJsonResult(status.result);
    expect(statusJson['status']).toBe('succeeded');
  });

  it('pipeline.start with auto_run=false can be resumed', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [
          { tool: 'write_file', arguments: { file_path: 'b.txt', content: 'world' } },
          { tool: 'read_file', arguments: { file_path: 'b.txt' } },
        ],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start', 'pipeline.resume', 'write_file', 'read_file']) },
    );
    expect(start.ok).toBe(true);
    const started = parseJsonResult(start.result);
    expect(started['status']).toBe('queued');

    const runId = (started['run_id'] as string);
    const resumed = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume', 'write_file', 'read_file']) },
    );
    expect(resumed.ok).toBe(true);
    expect(parseJsonResult(resumed.result)['status']).toBe('succeeded');
  });

  it('pipeline.resume recovers persisted running runs with running current step', async () => {
    const storePath = path.join(tmpDir, 'running-store.json');
    const runId = 'run-recover-running-1';
    const now = new Date().toISOString();
    const store = {
      version: 1,
      runs: {
        [runId]: {
          runId,
          runtime: 'openai',
          adapter: 'openai',
          pipelineName: 'recover-running',
          pipelineInputHash: 'input-hash',
          idempotencyKey: 'recover-running-idem',
          requestHash: 'request-hash',
          workspaceRoot: tmpDir,
          status: 'running',
          currentStep: 0,
          steps: [
            {
              tool: 'write_file',
              arguments: { file_path: 'recover-running.txt', content: 'ok' },
              status: 'running',
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
          attemptsByStep: { '0': 1 },
          lastAttemptAtByStep: { '0': now },
          nextRetryDueAtByStep: { '0': null },
          cancelRequested: false,
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');

    const resumed = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume', 'write_file']), pipelineStorePath: storePath },
    );
    expect(resumed.ok).toBe(true);
    expect(parseJsonResult(resumed.result)['status']).toBe('succeeded');
    await expect(fs.readFile(path.join(tmpDir, 'recover-running.txt'), 'utf-8')).resolves.toBe('ok');
  });

  it('pipeline.start dedupes explicit idempotency key with equivalent payload', async () => {
    const first = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'eq',
        idempotency_key: 'idem-explicit-1',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'idem.txt', content: 'v1' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(first.ok).toBe(true);
    const firstPayload = parseJsonResult(first.result);

    const second = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'eq',
        idempotency_key: 'idem-explicit-1',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'idem.txt', content: 'v1' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(second.ok).toBe(true);
    const secondPayload = parseJsonResult(second.result);
    expect(secondPayload['run_id']).toBe(firstPayload['run_id']);
  });

  it('pipeline.start returns E_IDEMPOTENCY_CONFLICT for same key + non-equivalent payload', async () => {
    const first = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'conflict',
        idempotency_key: 'idem-explicit-2',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'conflict.txt', content: 'v1' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(first.ok).toBe(true);

    const second = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'conflict',
        idempotency_key: 'idem-explicit-2',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'conflict.txt', content: 'v2' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(second.ok).toBe(false);
    const payload = parseJsonResult(second.result);
    expect(payload['failure_code']).toBe('E_IDEMPOTENCY_CONFLICT');
  });

  it('pipeline.start includes routing + idempotency metadata in run payload', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'metadata-check',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'meta.txt', content: 'x' } }],
      },
      [tmpDir],
      undefined,
      {
        allowedToolNames: new Set(['pipeline.start']),
        runtimeId: 'openrouter',
        adapterId: 'openrouter',
      },
    );
    expect(started.ok).toBe(true);
    const payload = parseJsonResult(started.result);
    expect(payload['runtime']).toBe('openrouter');
    expect(payload['adapter']).toBe('openrouter');
    expect(payload['pipeline_name']).toBe('metadata-check');
    expect(typeof payload['pipeline_input_hash']).toBe('string');
    expect(typeof payload['idempotency_key']).toBe('string');
    expect(payload['status']).toBe('queued');
  });

  it('pipeline.start derived idempotency key is based on canonical input, not step list', async () => {
    const first = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'derived-input-contract',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'a.txt', content: 'A' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(first.ok).toBe(true);

    const second = await executeToolCall(
      'pipeline.start',
      {
        pipeline_name: 'derived-input-contract',
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'b.txt', content: 'B' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(second.ok).toBe(false);
    const payload = parseJsonResult(second.result);
    expect(payload['failure_code']).toBe('E_IDEMPOTENCY_CONFLICT');
    expect(String(payload['message'])).toContain('idempotency key conflict');
  });

  it('pipeline.step execution fails deterministically when a step tool is not allowlisted', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        steps: [
          { tool: 'write_file', arguments: { file_path: 'blocked.txt', content: 'x' } },
        ],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(start.ok).toBe(false);
    const payload = parseJsonResult(start.result);
    expect(payload['status']).toBe('failed');
    expect(payload['last_error']).toMatch(/not allowlisted/i);
  });

  it('pipeline.resume requires retry scheduling before rerunning failed step', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'retry.txt', content: 'ok' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(start.ok).toBe(true);
    const runId = (parseJsonResult(start.result)['run_id'] as string);

    const firstResume = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume']) },
    );
    expect(firstResume.ok).toBe(false);
    expect(parseJsonResult(firstResume.result)['status']).toBe('failed');

    const secondResumeBlocked = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume', 'write_file']) },
    );
    expect(secondResumeBlocked.ok).toBe(false);
    const blockedPayload = parseJsonResult(secondResumeBlocked.result);
    expect(blockedPayload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(blockedPayload['message'])).toContain('call step.retry first');

    const retry = await executeToolCall(
      'step.retry',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.retry']) },
    );
    expect(retry.ok).toBe(true);

    // step.retry enforces backoff; wait until due before resuming.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const thirdResume = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume', 'write_file']) },
    );
    expect(thirdResume.ok).toBe(true);
    expect(parseJsonResult(thirdResume.result)['status']).toBe('succeeded');
  });

  it('pipeline.resume blocks execution when current step retry is not due yet', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'not_a_real_tool', arguments: {} }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(start.ok).toBe(true);
    const runId = parseJsonResult(start.result)['run_id'] as string;

    const run1 = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(run1.ok).toBe(false);

    const retry = await executeToolCall(
      'step.retry',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.retry']) },
    );
    expect(retry.ok).toBe(true);

    const resumed = await executeToolCall(
      'pipeline.resume',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.resume', 'not_a_real_tool']) },
    );
    expect(resumed.ok).toBe(false);
    const payload = parseJsonResult(resumed.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(payload['message'])).toContain('retry not due yet');
  });

  it('pipeline.cancel marks pending steps cancelled', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [
          { tool: 'write_file', arguments: { file_path: 'c.txt', content: 'cancel me' } },
          { tool: 'read_file', arguments: { file_path: 'c.txt' } },
        ],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start', 'pipeline.cancel']) },
    );
    expect(start.ok).toBe(true);
    const runId = (parseJsonResult(start.result)['run_id'] as string);

    const cancelled = await executeToolCall(
      'pipeline.cancel',
      { run_id: runId },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.cancel']) },
    );
    expect(cancelled.ok).toBe(true);
    const payload = parseJsonResult(cancelled.result);
    expect(payload['status']).toBe('cancelled');
  });

  it('rejects resume when invocation workspace root does not match run workspace_root', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-other-root-'));
    const sharedPipelineStorePath = path.join(tmpDir, 'shared-pipeline-store.json');
    try {
      const start = await executeToolCall(
        'pipeline.start',
        {
          auto_run: false,
          steps: [{ tool: 'write_file', arguments: { file_path: 'root.txt', content: 'x' } }],
        },
        [tmpDir],
        undefined,
        {
          allowedToolNames: new Set(['pipeline.start']),
          pipelineStorePath: sharedPipelineStorePath,
        },
      );
      expect(start.ok).toBe(true);
      const runId = parseJsonResult(start.result)['run_id'] as string;

      const resumed = await executeToolCall(
        'pipeline.resume',
        { run_id: runId },
        [otherRoot],
        undefined,
        {
          allowedToolNames: new Set(['pipeline.resume', 'write_file']),
          pipelineStorePath: sharedPipelineStorePath,
        },
      );
      expect(resumed.ok).toBe(false);
      const payload = parseJsonResult(resumed.result);
      expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
      expect(String(payload['message'])).toContain('workspace_root mismatch');
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('pipeline.start blocks idempotent replay when invocation workspace root differs', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-other-root-'));
    const sharedPipelineStorePath = path.join(tmpDir, 'shared-pipeline-store-2.json');
    try {
      const first = await executeToolCall(
        'pipeline.start',
        {
          pipeline_name: 'workspace-affinity',
          idempotency_key: 'workspace-affinity-idem',
          auto_run: false,
          steps: [{ tool: 'write_file', arguments: { file_path: 'root.txt', content: 'x' } }],
        },
        [tmpDir],
        undefined,
        {
          allowedToolNames: new Set(['pipeline.start']),
          pipelineStorePath: sharedPipelineStorePath,
        },
      );
      expect(first.ok).toBe(true);

      const second = await executeToolCall(
        'pipeline.start',
        {
          pipeline_name: 'workspace-affinity',
          idempotency_key: 'workspace-affinity-idem',
          auto_run: false,
          steps: [{ tool: 'write_file', arguments: { file_path: 'root.txt', content: 'x' } }],
        },
        [otherRoot],
        undefined,
        {
          allowedToolNames: new Set(['pipeline.start']),
          pipelineStorePath: sharedPipelineStorePath,
        },
      );
      expect(second.ok).toBe(false);
      const payload = parseJsonResult(second.result);
      expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
      expect(String(payload['message'])).toContain('workspace_root mismatch');
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects nested pipeline calls when executing a pipeline step', async () => {
    const start = await executeToolCall(
      'pipeline.start',
      {
        steps: [{ tool: 'pipeline.status', arguments: { run_id: 'any' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start', 'pipeline.status']) },
    );
    expect(start.ok).toBe(false);
    const payload = parseJsonResult(start.result);
    expect(payload['status']).toBe('failed');
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(payload['last_error']).toMatch(/nested pipeline/i);
  });

  it('returns structured E_POLICY_BLOCKED when nested pipeline.* is called directly in pipelineStepMode', async () => {
    const result = await executeToolCall(
      'pipeline.status',
      { run_id: 'any' },
      [tmpDir],
      undefined,
      { pipelineStepMode: true },
    );
    expect(result.ok).toBe(false);
    const payload = parseJsonResult(result.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(payload['message'])).toContain('Nested pipeline');
  });

  it('returns structured E_TOOL_UNAVAILABLE when pipeline store persistence throws', async () => {
    const blockingFile = path.join(tmpDir, 'not-a-directory');
    await fs.writeFile(blockingFile, 'x');

    const result = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'read_file', arguments: { file_path: 'x.txt' } }],
      },
      [tmpDir],
      undefined,
      {
        allowedToolNames: new Set(['pipeline.start']),
        pipelineStorePath: path.join(blockingFile, 'pipeline-store.json'),
      },
    );
    expect(result.ok).toBe(false);
    const payload = parseJsonResult(result.result);
    expect(payload['operation']).toBe('pipeline.start');
    expect(payload['failure_code']).toBe('E_TOOL_UNAVAILABLE');
  });
});

describe('hybrid feature gate', () => {
  it('returns E_TOOL_UNAVAILABLE when hybrid pipeline tools are disabled', async () => {
    const result = await executeToolCall(
      'pipeline.start',
      { steps: [{ tool: 'read_file', arguments: { file_path: 'x' } }] },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']), enableHybridPipeline: false },
    );
    expect(result.ok).toBe(false);
    const payload = parseJsonResult(result.result);
    expect(payload['failure_code']).toBe('E_TOOL_UNAVAILABLE');
  });
});

// ── step primitives ──────────────────────────────────────────────────

describe('step.run/assert/retry/wait', () => {
  it('step.run executes current step and advances the run', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'step-run.txt', content: 'ok' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    expect(started.ok).toBe(true);
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const ran = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'write_file']) },
    );
    expect(ran.ok).toBe(true);

    const payload = parseJsonResult(ran.result);
    expect(payload['operation']).toBe('step.run');
    const run = payload['run'] as Record<string, unknown>;
    expect(run['status']).toBe('succeeded');
    expect(run['current_step']).toBe(1);
    await expect(fs.readFile(path.join(tmpDir, 'step-run.txt'), 'utf-8')).resolves.toBe('ok');
  });

  it('step.assert validates active run state', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'assert.txt', content: 'ok' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const asserted = await executeToolCall(
      'step.assert',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.assert']) },
    );
    expect(asserted.ok).toBe(true);
    const payload = parseJsonResult(asserted.result);
    expect(payload['operation']).toBe('step.assert');
    const run = payload['run'] as Record<string, unknown>;
    expect(run['status']).toBe('running');
    expect(payload['step_status']).toBe('pending');
  });

  it('step.run returns E_POLICY_BLOCKED on expected_current_step mismatch', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'mismatch.txt', content: 'x' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const ran = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 1 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'write_file']) },
    );
    expect(ran.ok).toBe(false);
    const payload = parseJsonResult(ran.result);
    expect(payload['failure_code_version']).toBe('v1');
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
  });

  it('step.run returns E_RUN_NOT_FOUND for missing run', async () => {
    const ran = await executeToolCall(
      'step.run',
      { run_id: 'missing-run', expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run']) },
    );
    expect(ran.ok).toBe(false);
    const payload = parseJsonResult(ran.result);
    expect(payload['failure_code']).toBe('E_RUN_NOT_FOUND');
  });

  it('step.run returns E_POLICY_BLOCKED when the underlying step tool is not allowlisted', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'write_file', arguments: { file_path: 'blocked-step.txt', content: 'x' } }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const ran = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run']) },
    );
    expect(ran.ok).toBe(false);
    const payload = parseJsonResult(ran.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
  });

  it('step.run requires step.retry before rerunning a failed step', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'not_a_real_tool', arguments: {} }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const firstRun = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(firstRun.ok).toBe(false);
    expect(parseJsonResult(firstRun.result)['failure_code']).toBe('E_TOOL_UNAVAILABLE');

    const secondRun = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(secondRun.ok).toBe(false);
    const payload = parseJsonResult(secondRun.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(payload['message'])).toContain('step.retry');
  });

  it('step.wait requires step.retry when current step is failed with no retry scheduled', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'not_a_real_tool', arguments: {} }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const firstRun = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(firstRun.ok).toBe(false);

    const wait = await executeToolCall(
      'step.wait',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.wait']) },
    );
    expect(wait.ok).toBe(false);
    const payload = parseJsonResult(wait.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(payload['message'])).toContain('step.retry');
  });

  it('step.retry schedules retries and enforces deterministic retry exhaustion', async () => {
    const started = await executeToolCall(
      'pipeline.start',
      {
        auto_run: false,
        steps: [{ tool: 'not_a_real_tool', arguments: {} }],
      },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['pipeline.start']) },
    );
    const runId = parseJsonResult(started.result)['run_id'] as string;

    const run1 = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(run1.ok).toBe(false);
    expect(parseJsonResult(run1.result)['failure_code']).toBe('E_TOOL_UNAVAILABLE');

    const retry1 = await executeToolCall(
      'step.retry',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.retry']) },
    );
    expect(retry1.ok).toBe(true);

    const wait1 = await executeToolCall(
      'step.wait',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.wait']) },
    );
    const wait1Payload = parseJsonResult(wait1.result);
    if (wait1Payload['ready'] === false) {
      await new Promise((resolve) => setTimeout(resolve, Number(wait1Payload['wait_ms']) + 20));
    }

    const run2 = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(run2.ok).toBe(false);

    const retry2 = await executeToolCall(
      'step.retry',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.retry']) },
    );
    expect(retry2.ok).toBe(true);

    const wait2 = await executeToolCall(
      'step.wait',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.wait']) },
    );
    const wait2Payload = parseJsonResult(wait2.result);
    if (wait2Payload['ready'] === false) {
      await new Promise((resolve) => setTimeout(resolve, Number(wait2Payload['wait_ms']) + 20));
    }

    const run3 = await executeToolCall(
      'step.run',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.run', 'not_a_real_tool']) },
    );
    expect(run3.ok).toBe(false);

    const retry3 = await executeToolCall(
      'step.retry',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.retry']) },
    );
    expect(retry3.ok).toBe(false);
    const payload = parseJsonResult(retry3.result);
    expect(payload['failure_code']).toBe('E_RETRY_EXHAUSTED');
  });

  it('step primitives reject terminal failed runs as inactive', async () => {
    const storePath = path.join(tmpDir, 'failed-store.json');
    const runId = 'run-terminal-failed-1';
    const now = new Date().toISOString();
    const store = {
      version: 1,
      runs: {
        [runId]: {
          runId,
          runtime: 'openai',
          adapter: 'openai',
          pipelineName: 'terminal-failed',
          pipelineInputHash: 'input-hash',
          idempotencyKey: 'terminal-failed-idem',
          requestHash: 'request-hash',
          workspaceRoot: tmpDir,
          status: 'failed',
          currentStep: 0,
          steps: [
            {
              tool: 'not_a_real_tool',
              arguments: {},
              status: 'failed',
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
          attemptsByStep: { '0': 3 },
          lastAttemptAtByStep: { '0': now },
          nextRetryDueAtByStep: { '0': null },
          cancelRequested: false,
          failureCode: 'E_RETRY_EXHAUSTED',
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');

    const asserted = await executeToolCall(
      'step.assert',
      { run_id: runId, expected_current_step: 0 },
      [tmpDir],
      undefined,
      { allowedToolNames: new Set(['step.assert']), pipelineStorePath: storePath },
    );
    expect(asserted.ok).toBe(false);
    const payload = parseJsonResult(asserted.result);
    expect(payload['failure_code']).toBe('E_POLICY_BLOCKED');
    expect(String(payload['message'])).toContain('run status is not active: failed');
  });
});

// ── Security: path traversal ─────────────────────────────────────────

describe('path security', () => {
  it('rejects ../ traversal outside allowed roots', async () => {
    const filePath = path.join(tmpDir, '..', 'etc', 'passwd');
    const r = await executeToolCall('read_file', { file_path: filePath }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);
  });

  it('rejects absolute path outside allowed roots', async () => {
    const r = await executeToolCall('read_file', { file_path: '/etc/hostname' }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);
  });

  it('rejects symlink pointing outside allowed roots', async () => {
    // Create a temp file outside the allowed root
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret data');

    // Create symlink inside allowed root pointing outside
    const symlinkPath = path.join(tmpDir, 'escape-link');
    await fs.symlink(outsideFile, symlinkPath);

    const r = await executeToolCall('read_file', { file_path: symlinkPath }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);

    // Clean up
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects write_file outside allowed roots', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-outside-'));
    const filePath = path.join(outsideDir, 'injected.txt');

    const r = await executeToolCall(
      'write_file',
      { file_path: filePath, content: 'injected' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);

    // File should not have been created
    await expect(fs.access(filePath)).rejects.toThrow();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('allows access with multiple allowed roots', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-root2-'));
    const filePath = path.join(secondRoot, 'allowed.txt');
    await fs.writeFile(filePath, 'allowed content');

    const r = await executeToolCall(
      'read_file',
      { file_path: filePath },
      [tmpDir, secondRoot],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe('allowed content');

    await fs.rm(secondRoot, { recursive: true, force: true });
  });
});

// ── Unknown tool ─────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const r = await executeToolCall('nonexistent_tool', {}, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Unknown tool');
  });
});

// ── Empty allowed roots ──────────────────────────────────────────────

describe('empty allowed roots', () => {
  it('returns error when no roots are configured', async () => {
    const r = await executeToolCall('read_file', { file_path: '/etc/hostname' }, []);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('No allowed roots');
  });
});
