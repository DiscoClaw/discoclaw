import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildConversationMemorySection,
  generateSummary,
  loadSummary,
} from './summarizer.js';
import type { RuntimeAdapter } from '../runtime/types.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'summarizer-recency-'));
}

describe('buildConversationMemorySection', () => {
  it('annotates elapsed time and newer turns from regeneratedAt', () => {
    const section = buildConversationMemorySection('fix still pending', {
      regeneratedAt: 1_000,
      turnsSinceUpdate: 2,
      now: 7_501_000,
    });

    expect(section).toContain('Conversation memory:');
    expect(section).toContain('Rolling summary only; treat this as background context.');
    expect(section).toContain('Last regenerated 2h 5m ago; 2 newer turns since then.');
    expect(section).toContain('trust the fresher evidence');
    expect(section).toContain('fix still pending');
  });

  it('omits the recency annotation for old files without regeneratedAt', () => {
    const section = buildConversationMemorySection('background notes', {
      turnsSinceUpdate: 4,
      now: 7_501_000,
    });

    expect(section).toContain('Rolling summary only; treat this as background context.');
    expect(section).not.toContain('Last regenerated');
    expect(section).not.toContain('newer turns since then');
    expect(section).toContain('recent conversation, reply context, tool output, or the current user message');
  });
});

describe('generateSummary recency guidance', () => {
  it('supports resolved output that drops stale pending claims', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield {
          type: 'text_final' as const,
          text: 'The `!models reset` fix is merged and deployed. Forge-auditor defaults are now set.',
        };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, {
      previousSummary: '`!models reset` is still pending. Forge-auditor defaults are unset.',
      recentExchange: '[User]: The fix merged and deployed.\n[Bot]: Confirmed the defaults are live.',
      model: 'haiku',
      cwd: '/tmp',
      maxChars: 2000,
      timeoutMs: 30_000,
    });

    expect(result).toContain('merged and deployed');
    expect(result).toContain('defaults are now set');
    expect(result).not.toContain('pending');
    expect(result).not.toContain('unset');
  });

  it('preserves unrelated context while correcting contradicted status', async () => {
    const runtime = {
      invoke: vi.fn(async function* () {
        yield {
          type: 'text_final' as const,
          text: 'The fix is deployed. The user still prefers terse status updates.',
        };
      }),
    } as unknown as RuntimeAdapter;

    const result = await generateSummary(runtime, {
      previousSummary: 'The fix is pending. The user prefers terse status updates.',
      recentExchange: '[User]: It was deployed this morning.\n[Bot]: Confirmed.',
      model: 'haiku',
      cwd: '/tmp',
      maxChars: 2000,
      timeoutMs: 30_000,
    });

    expect(result).toContain('deployed');
    expect(result).toContain('prefers terse status updates');
    expect(result).not.toContain('pending');
  });

  it('tells the summarizer to replace stale details with newer exchange state', async () => {
    let seenPrompt = '';
    const runtime = {
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = String(p.prompt ?? '');
        yield { type: 'text_final' as const, text: 'updated summary' };
      }),
    } as unknown as RuntimeAdapter;

    await generateSummary(runtime, {
      previousSummary: 'The fix is still pending.',
      recentExchange: '[User]: The fix merged and deployed today.\n[Bot]: Confirmed.',
      model: 'haiku',
      cwd: '/tmp',
      maxChars: 2000,
      timeoutMs: 30_000,
    });

    expect(seenPrompt).toContain('Treat the new exchange as fresher than the current summary.');
    expect(seenPrompt).toContain('replace stale details with the newer state');
    expect(seenPrompt).toContain('remove stale "pending" wording');
  });
});

describe('loadSummary regeneratedAt compatibility', () => {
  it('loads regeneratedAt when present', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'with-regenerated-at.json'),
      JSON.stringify({
        summary: 'fresh summary',
        updatedAt: 200,
        regeneratedAt: 150,
        turnsSinceUpdate: 1,
      }),
      'utf8',
    );

    const result = await loadSummary(dir, 'with-regenerated-at');

    expect(result).toEqual({
      summary: 'fresh summary',
      updatedAt: 200,
      regeneratedAt: 150,
      turnsSinceUpdate: 1,
    });
  });

  it('keeps backward compatibility for files without regeneratedAt', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'without-regenerated-at.json'),
      JSON.stringify({
        summary: 'legacy summary',
        updatedAt: 100,
        turnsSinceUpdate: 3,
      }),
      'utf8',
    );

    const result = await loadSummary(dir, 'without-regenerated-at');

    expect(result).toEqual({
      summary: 'legacy summary',
      updatedAt: 100,
      turnsSinceUpdate: 3,
    });
    expect(result?.regeneratedAt).toBeUndefined();
  });
});
