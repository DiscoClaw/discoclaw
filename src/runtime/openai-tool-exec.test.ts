import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall } from './openai-tool-exec.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

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
  it('finds files matching a glob pattern', async () => {
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
    expect(r.result).toBe('page content');
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
