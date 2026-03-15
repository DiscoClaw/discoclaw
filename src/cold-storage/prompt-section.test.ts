import { describe, it, expect } from 'vitest';
import { buildColdStorageSection, formatResultLine } from './prompt-section.js';
import type { SearchResult, Chunk } from './types.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 1,
    content: 'test content',
    guild_id: '100000000000000001',
    channel_id: '200000000000000001',
    thread_id: null,
    message_id: '300000000000000001',
    user_id: '400000000000000001',
    parent_message_id: null,
    created_at: '2025-01-15T12:00:00.000Z',
    chunk_type: 'message',
    token_count: 3,
    ...overrides,
  };
}

function makeResult(overrides: {
  chunk?: Partial<Chunk>;
  score?: number;
  jump_url?: string | null;
} = {}): SearchResult {
  return {
    chunk: makeChunk(overrides.chunk),
    score: overrides.score ?? 0.85,
    jump_url: overrides.jump_url !== undefined
      ? overrides.jump_url
      : 'https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('formatResultLine', () => {
  it('formats a message result with score and jump URL', () => {
    const result = makeResult();
    const line = formatResultLine(result);

    expect(line).toBe(
      '[0.850] test content (https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001)',
    );
  });

  it('omits source parenthetical for message type with no jump URL', () => {
    const result = makeResult({ jump_url: null });
    const line = formatResultLine(result);

    expect(line).toBe('[0.850] test content');
  });

  it('includes chunk_type for non-message types', () => {
    const result = makeResult({ chunk: { chunk_type: 'note' } });
    const line = formatResultLine(result);

    expect(line).toContain('(note,');
  });

  it('shows only chunk_type when jump_url is null for non-message types', () => {
    const result = makeResult({
      chunk: { chunk_type: 'summary' },
      jump_url: null,
    });
    const line = formatResultLine(result);

    expect(line).toBe('[0.850] test content (summary)');
  });

  it('collapses newlines and extra whitespace in content', () => {
    const result = makeResult({
      chunk: { content: 'line one\nline two\n\nline three' },
    });
    const line = formatResultLine(result);

    expect(line).toContain('line one line two line three');
  });

  it('formats score to 3 decimal places', () => {
    const result = makeResult({ score: 0.1 });
    const line = formatResultLine(result);

    expect(line).toMatch(/^\[0\.100\]/);
  });
});

describe('buildColdStorageSection', () => {
  it('returns empty string for empty results', () => {
    expect(buildColdStorageSection([])).toBe('');
  });

  it('builds section with header and result lines', () => {
    const results = [makeResult(), makeResult({ score: 0.72 })];
    const section = buildColdStorageSection(results);

    expect(section).toContain('Relevant context from conversation history:');
    expect(section).toContain('[0.850]');
    expect(section).toContain('[0.720]');
  });

  it('respects maxChars budget', () => {
    const results = Array.from({ length: 50 }, (_, i) =>
      makeResult({
        score: 0.9 - i * 0.01,
        chunk: { content: `Result number ${i} with some content to fill space` },
      }),
    );

    const section = buildColdStorageSection(results, { maxChars: 300 });

    expect(section.length).toBeLessThanOrEqual(330); // allow for truncation marker
    expect(section).toContain('(more results available)');
  });

  it('does not add truncation marker when all results fit', () => {
    const results = [makeResult()];
    const section = buildColdStorageSection(results, { maxChars: 5000 });

    expect(section).not.toContain('(more results available)');
  });

  it('returns empty when first result alone exceeds budget', () => {
    const longContent = 'a'.repeat(2000);
    const results = [makeResult({ chunk: { content: longContent } })];
    const section = buildColdStorageSection(results, { maxChars: 100 });

    expect(section).toBe('');
  });

  it('uses default maxChars of 1500', () => {
    const results = Array.from({ length: 100 }, (_, i) =>
      makeResult({
        score: 0.9 - i * 0.005,
        chunk: { content: `Result ${i}` },
      }),
    );

    const section = buildColdStorageSection(results);

    // Should be within default budget (1500) + truncation marker
    expect(section.length).toBeLessThanOrEqual(1550);
  });
});
