import { describe, expect, it, vi } from 'vitest';

import {
  buildConversationMemorySection,
  generateSummary,
} from './summarizer.js';
import type { RuntimeAdapter } from '../runtime/types.js';

describe('buildConversationMemorySection', () => {
  it('marks lagging summaries as background context and reports turn lag', () => {
    const section = buildConversationMemorySection('fix still pending', 2);

    expect(section).toContain('Conversation memory:');
    expect(section).toContain('Rolling summary only; treat this as background context.');
    expect(section).toContain('It may lag behind the latest 2 turns.');
    expect(section).toContain('trust the fresher evidence');
    expect(section).toContain('fix still pending');
  });

  it('still warns about fresher evidence when turn lag is unknown', () => {
    const section = buildConversationMemorySection('background notes');

    expect(section).toContain('Rolling summary only; treat this as background context.');
    expect(section).not.toContain('It may lag behind the latest');
    expect(section).toContain('recent conversation, reply context, tool output, or the current user message');
  });
});

describe('generateSummary recency guidance', () => {
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
