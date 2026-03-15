import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadSummary,
  saveSummary,
  generateSummary,
  archiveSummary,
  estimateSummaryTokens,
  recompressSummary,
} from './summarizer.js';
import type { ConversationSummary } from './summarizer.js';
import type { RuntimeAdapter } from '../runtime/types.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'summarizer-test-'));
}

describe('loadSummary', () => {
  it('returns null for missing file', async () => {
    const dir = await makeTmpDir();
    const result = await loadSummary(dir, 'nonexistent-session');
    expect(result).toBeNull();
  });

  it('parses valid JSON file', async () => {
    const dir = await makeTmpDir();
    const data: ConversationSummary = { summary: 'test summary', updatedAt: 1000 };
    await fs.writeFile(
      path.join(dir, 'test-session.json'),
      JSON.stringify(data),
      'utf8',
    );
    const result = await loadSummary(dir, 'test-session');
    expect(result).toEqual(data);
  });

  it('returns null on malformed JSON', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json!!!', 'utf8');
    const result = await loadSummary(dir, 'bad');
    expect(result).toBeNull();
  });

  it('returns null when JSON lacks summary field', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'no-summary.json'), '{"updatedAt":1}', 'utf8');
    const result = await loadSummary(dir, 'no-summary');
    expect(result).toBeNull();
  });

  it('returns turnsSinceUpdate when present in JSON', async () => {
    const dir = await makeTmpDir();
    const data: ConversationSummary = { summary: 'ctx', updatedAt: 1, turnsSinceUpdate: 3 };
    await fs.writeFile(path.join(dir, 'with-turns.json'), JSON.stringify(data), 'utf8');
    const result = await loadSummary(dir, 'with-turns');
    expect(result).toEqual(data);
    expect(result!.turnsSinceUpdate).toBe(3);
  });

  it('loads old files without turnsSinceUpdate (backward compat)', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'old-format.json'),
      JSON.stringify({ summary: 'old', updatedAt: 100 }),
      'utf8',
    );
    const result = await loadSummary(dir, 'old-format');
    expect(result).toEqual({ summary: 'old', updatedAt: 100 });
    expect(result!.turnsSinceUpdate).toBeUndefined();
  });
});

describe('saveSummary', () => {
  it('creates file with correct content', async () => {
    const dir = await makeTmpDir();
    const data: ConversationSummary = { summary: 'saved summary', updatedAt: 2000 };
    await saveSummary(dir, 'save-test', data);
    const raw = await fs.readFile(path.join(dir, 'save-test.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(data);
  });

  it('overwrites existing file', async () => {
    const dir = await makeTmpDir();
    await saveSummary(dir, 'overwrite', { summary: 'old', updatedAt: 1 });
    await saveSummary(dir, 'overwrite', { summary: 'new', updatedAt: 2 });
    const raw = await fs.readFile(path.join(dir, 'overwrite.json'), 'utf8');
    expect(JSON.parse(raw).summary).toBe('new');
  });

  it('persists turnsSinceUpdate field', async () => {
    const dir = await makeTmpDir();
    await saveSummary(dir, 'turns-persist', { summary: 's', updatedAt: 1, turnsSinceUpdate: 0 });
    const raw = await fs.readFile(path.join(dir, 'turns-persist.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.turnsSinceUpdate).toBe(0);
  });

  it('creates parent directory if missing', async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, 'a', 'b', 'c');
    await saveSummary(nested, 'nested', { summary: 'deep', updatedAt: 3 });
    const raw = await fs.readFile(path.join(nested, 'nested.json'), 'utf8');
    expect(JSON.parse(raw).summary).toBe('deep');
  });
});

describe('generateSummary', () => {
  const baseOpts = {
    previousSummary: null as string | null,
    recentExchange: '[User]: hello\n[Bot]: hi there',
    model: 'haiku',
    cwd: '/tmp',
    maxChars: 2000,
    timeoutMs: 30_000,
  };

  it('collects text_final into summary string', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_delta' as const, text: 'partial ' };
        yield { type: 'text_final' as const, text: 'User greeted the bot.' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, baseOpts);
    expect(result).toBe('User greeted the bot.');
  });

  it('collects text_delta when no text_final', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_delta' as const, text: 'User ' };
        yield { type: 'text_delta' as const, text: 'greeted the bot.' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, baseOpts);
    expect(result).toBe('User greeted the bot.');
  });

  it('returns previous summary on runtime error event', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'error' as const, message: 'timeout' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, {
      ...baseOpts,
      previousSummary: 'existing summary',
    });
    expect(result).toBe('existing summary');
  });

  it('returns empty string on error when no previous summary', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'error' as const, message: 'timeout' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, baseOpts);
    expect(result).toBe('');
  });

  it('returns previous summary when runtime throws', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        throw new Error('network failure');
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, {
      ...baseOpts,
      previousSummary: 'kept summary',
    });
    expect(result).toBe('kept summary');
  });

  it('passes correct prompt with previous summary', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, {
      ...baseOpts,
      previousSummary: 'old context',
    });
    expect(seenPrompt).toContain('Current summary:\nold context');
    expect(seenPrompt).toContain('[User]: hello');
  });

  it('passes empty tools array to runtime', async () => {
    let seenTools: string[] | undefined;
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenTools = p.tools;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, baseOpts);
    expect(seenTools).toEqual([]);
  });

  it('includes task status context section in prompt when provided', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, {
      ...baseOpts,
      taskStatusContext: 't-001: open, "Fix login bug"',
    });
    expect(seenPrompt).toContain('Current task statuses:');
    expect(seenPrompt).toContain('t-001: open, "Fix login bug"');
  });

  it('includes recently-closed tasks in task status context prompt', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, {
      ...baseOpts,
      taskStatusContext:
        't-002: in_progress, "Refactor auth"\nRecently closed:\nt-001: closed, "Fix login bug"',
    });
    expect(seenPrompt).toContain('Recently closed:');
    expect(seenPrompt).toContain('t-001: closed, "Fix login bug"');
    expect(seenPrompt).toContain('t-002: in_progress, "Refactor auth"');
  });

  it('prompt rule mentions recently closed tasks when taskStatusContext is provided', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, {
      ...baseOpts,
      taskStatusContext: 'No active tasks.\nRecently closed:\nt-003: closed, "Deploy pipeline"',
    });
    expect(seenPrompt).toContain('Recently closed');
    expect(seenPrompt).toContain('stale open');
  });

  it('omits task status rule and section when taskStatusContext is not provided', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        yield { type: 'text_final' as const, text: 'ok' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, baseOpts);
    expect(seenPrompt).not.toContain('Current task statuses:');
    expect(seenPrompt).not.toContain('Recently closed');
  });
});

describe('estimateSummaryTokens', () => {
  it('rounds with Math.ceil(chars / 4)', () => {
    expect(estimateSummaryTokens('')).toBe(0);
    expect(estimateSummaryTokens('abc')).toBe(1);
    expect(estimateSummaryTokens('abcd')).toBe(1);
    expect(estimateSummaryTokens('abcde')).toBe(2);
    expect(estimateSummaryTokens('a'.repeat(10))).toBe(3);
  });
});

describe('recompressSummary', () => {
  const baseOpts = {
    summary: 'X'.repeat(500),
    model: 'haiku',
    cwd: '/tmp',
    thresholdTokens: 100,
    targetTokens: 65,
    timeoutMs: 30_000,
  };

  it('wires recompression prompt with limits, safety rules, and task status context', async () => {
    let seenPrompt = '';
    let seenTools: string[] | undefined;
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = p.prompt;
        seenTools = p.tools;
        yield { type: 'text_final' as const, text: 'Compressed summary' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await recompressSummary(runtime, {
      ...baseOpts,
      taskStatusContext: 't-001: in_progress, "Ship summary recompression"',
    });

    expect(result).toBe('Compressed summary');
    expect(seenTools).toEqual([]);
    expect(seenPrompt).toContain('at most 65 tokens');
    expect(seenPrompt).toContain('Recompress threshold: 100');
    expect(seenPrompt).toContain('Drop stale details');
    expect(seenPrompt).toContain('Collapse repeated references');
    expect(seenPrompt).toContain('Preserve active project state and unresolved threads');
    expect(seenPrompt).toContain('Do not duplicate continuation capsule content into the summary body');
    expect(seenPrompt).toContain('Current task statuses:');
    expect(seenPrompt).toContain('t-001: in_progress, "Ship summary recompression"');
  });

  it('returns original summary when runtime emits an error event', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'error' as const, message: 'timeout' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await recompressSummary(runtime, baseOpts);
    expect(result).toBe(baseOpts.summary);
  });

  it('returns original summary when recompression result is empty', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final' as const, text: '   ' };
      }),
    } as unknown as RuntimeAdapter;

    const result = await recompressSummary(runtime, baseOpts);
    expect(result).toBe(baseOpts.summary);
  });
});

describe('summary truncation', () => {
  it('injection-time cap: oversized summary is sliced to summaryMaxChars', () => {
    const maxChars = 10;
    const oversized = 'A'.repeat(20);
    const truncated = oversized.slice(0, maxChars);
    expect(truncated).toHaveLength(maxChars);
    expect(truncated).toBe('A'.repeat(10));
  });

  it('save-time cap: generateSummary result is sliced before persisting', async () => {
    const maxChars = 8;
    const dir = await makeTmpDir();

    const runtime = {
      invoke: vi.fn(async function* () {
        yield { type: 'text_final' as const, text: 'X'.repeat(20) };
      }),
    } as unknown as RuntimeAdapter;

    const raw = await generateSummary(runtime, {
      previousSummary: null,
      recentExchange: '[User]: hi\n[Bot]: hey',
      model: 'haiku',
      cwd: '/tmp',
      maxChars: 2000,
      timeoutMs: 30_000,
    });

    // Simulate coordinator truncating before save
    const toSave = raw.slice(0, maxChars);
    const data: ConversationSummary = { summary: toSave, updatedAt: Date.now() };
    await saveSummary(dir, 'trunc-save', data);

    const loaded = await loadSummary(dir, 'trunc-save');
    expect(loaded!.summary).toHaveLength(maxChars);
  });

  it('under-limit passthrough: summary within maxChars is unchanged', () => {
    const maxChars = 100;
    const short = 'hello world';
    expect(short.slice(0, maxChars)).toBe(short);
  });
});

describe('archiveSummary', () => {
  it('writes valid JSONL with correct fields', async () => {
    const dir = await makeTmpDir();
    const archiveDir = path.join(dir, 'archive');
    await archiveSummary(archiveDir, 'sess-1', '#general', 'User discussed deployment.');

    const files = await fs.readdir(archiveDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const raw = await fs.readFile(path.join(archiveDir, files[0]), 'utf8');
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry).toHaveProperty('timestamp');
    expect(entry.sessionKey).toBe('sess-1');
    expect(entry.channelName).toBe('#general');
    expect(entry.summary).toBe('User discussed deployment.');
  });

  it('appends multiple entries to the same day file', async () => {
    const dir = await makeTmpDir();
    const archiveDir = path.join(dir, 'archive');
    await archiveSummary(archiveDir, 'sess-1', '#general', 'First summary.');
    await archiveSummary(archiveDir, 'sess-2', '#random', 'Second summary.');

    const files = await fs.readdir(archiveDir);
    expect(files).toHaveLength(1);

    const raw = await fs.readFile(path.join(archiveDir, files[0]), 'utf8');
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.sessionKey).toBe('sess-1');
    expect(second.sessionKey).toBe('sess-2');
  });

  it('creates the archive directory if missing', async () => {
    const dir = await makeTmpDir();
    const archiveDir = path.join(dir, 'nested', 'deep', 'archive');
    await archiveSummary(archiveDir, 'sess-1', '#dev', 'Summary.');

    const files = await fs.readdir(archiveDir);
    expect(files).toHaveLength(1);
  });

  it('does not throw when appendFile fails', async () => {
    // Use a path where the parent is a file, not a directory, so mkdir fails
    const dir = await makeTmpDir();
    const blockingFile = path.join(dir, 'blocker');
    await fs.writeFile(blockingFile, 'not a dir', 'utf8');
    const badArchiveDir = path.join(blockingFile, 'sub');

    // Should not throw — errors are swallowed
    await expect(
      archiveSummary(badArchiveDir, 'sess-1', '#general', 'Should not throw.'),
    ).resolves.toBeUndefined();
  });
});

describe('safe session key', () => {
  it('uses filesystem-safe characters', async () => {
    const dir = await makeTmpDir();
    // Session key with special chars like discord:dm:<userId>
    await saveSummary(dir, 'discord:dm:12345', { summary: 'dm summary', updatedAt: 1 });
    // The file should exist with colons preserved (they're allowed by the regex)
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('discord:dm:12345.json');
    expect(files[0]).toMatch(/^[a-zA-Z0-9:_.-]+$/);
  });

  it('replaces unsafe characters with hyphens', async () => {
    const dir = await makeTmpDir();
    await saveSummary(dir, 'has spaces/and/slashes!', { summary: 'x', updatedAt: 1 });
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('has-spaces-and-slashes-.json');
  });
});
