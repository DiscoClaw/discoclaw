import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadSummary, saveSummary, generateSummary } from './summarizer.js';
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
