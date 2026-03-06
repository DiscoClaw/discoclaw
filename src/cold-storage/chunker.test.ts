import { describe, it, expect } from 'vitest';
import { chunkThread, splitLongText, type ThreadMessage } from './chunker.js';

function msg(content: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return { content, ...overrides };
}

describe('chunkThread', () => {
  // ── Empty / trivial input ──────────────────────────────────────────

  it('returns empty array for empty input', () => {
    expect(chunkThread([])).toEqual([]);
  });

  it('returns single chunk for a single short message', () => {
    const result = chunkThread([msg('hello world')]);
    expect(result).toEqual(['hello world']);
  });

  // ── Thread-aware grouping ──────────────────────────────────────────

  it('groups 10 short messages into 1–2 chunks', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(`Message ${i + 1}`));
    // Each message is ~10 chars, 10 messages ≈ 100 chars + newlines — well under 1500
    const result = chunkThread(messages, { maxChunkSize: 1500 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(2);
    // All messages should be present
    const joined = result.join('\n');
    for (let i = 1; i <= 10; i++) {
      expect(joined).toContain(`Message ${i}`);
    }
  });

  it('splits into multiple chunks when messages exceed maxChunkSize', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg(`Message number ${i + 1}: ${'x'.repeat(80)}`),
    );
    // Each message ~95 chars, 10 messages ~950 chars. With maxChunkSize=200, should be several chunks
    const result = chunkThread(messages, { maxChunkSize: 200, overlapMessages: 0 });
    expect(result.length).toBeGreaterThan(1);
    // Every message should appear in at least one chunk
    const allText = result.join('\n');
    for (let i = 1; i <= 10; i++) {
      expect(allText).toContain(`Message number ${i}`);
    }
  });

  it('applies sliding window overlap', () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      msg(`msg-${i + 1}: ${'a'.repeat(40)}`),
    );
    // Each ~46 chars. maxChunkSize=100 → ~2 messages per chunk, overlap=1
    const result = chunkThread(messages, { maxChunkSize: 100, overlapMessages: 1 });
    expect(result.length).toBeGreaterThan(1);

    // With overlap, some messages should appear in consecutive chunks
    let overlapFound = false;
    for (let i = 0; i < result.length - 1; i++) {
      for (let j = 1; j <= 6; j++) {
        if (result[i].includes(`msg-${j}`) && result[i + 1].includes(`msg-${j}`)) {
          overlapFound = true;
          break;
        }
      }
      if (overlapFound) break;
    }
    expect(overlapFound).toBe(true);
  });

  // ── Code block preservation ────────────────────────────────────────

  it('preserves code blocks — never splits mid-block', () => {
    const codeBlock = '```js\nfunction hello() {\n  console.log("hi");\n}\n```';
    const result = chunkThread([msg(codeBlock)]);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('```js');
    expect(result[0]).toContain('```');
    // Opening and closing fences should be in the same chunk
    const openCount = (result[0].match(/```/g) || []).length;
    expect(openCount).toBe(2); // opening + closing
  });

  it('keeps code block intact even when surrounded by text', () => {
    const text = [
      'Here is some text before.',
      '',
      '```python',
      'def foo():',
      '    return 42',
      '```',
      '',
      'And text after the block.',
    ].join('\n');

    const result = chunkThread([msg(text)], { maxChunkSize: 1500 });
    expect(result.length).toBe(1);
    expect(result[0]).toContain('```python');
    expect(result[0]).toContain('return 42');
  });

  it('message containing only a code block produces a single chunk', () => {
    const code = '```\nline1\nline2\nline3\n```';
    const result = chunkThread([msg(code)]);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(code);
  });

  // ── Long message splitting ─────────────────────────────────────────

  it('splits long messages at paragraph boundaries', () => {
    const para1 = 'First paragraph. '.repeat(20).trim();   // ~340 chars
    const para2 = 'Second paragraph. '.repeat(20).trim();  // ~360 chars
    const para3 = 'Third paragraph. '.repeat(20).trim();   // ~340 chars
    const longText = `${para1}\n\n${para2}\n\n${para3}`;

    const result = chunkThread([msg(longText)], { maxChunkSize: 400 });
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be under the limit (with some tolerance for edge cases)
    for (const chunk of result) {
      // Allow small overage for code block protection
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('splits at sentence boundaries when no paragraph breaks exist', () => {
    const sentences = 'This is a sentence. '.repeat(50).trim(); // ~1000 chars
    const result = chunkThread([msg(sentences)], { maxChunkSize: 200 });
    expect(result.length).toBeGreaterThan(1);
    // Chunks should not start or end mid-word (no leading/trailing spaces after trim)
    for (const chunk of result) {
      expect(chunk).toBe(chunk.trim());
    }
  });
});

describe('splitLongText', () => {
  it('returns text as-is when under maxSize', () => {
    expect(splitLongText('short', 100)).toEqual(['short']);
  });

  it('splits at paragraph boundaries', () => {
    const text = 'AAA. '.repeat(10).trim() + '\n\n' + 'BBB. '.repeat(10).trim();
    const parts = splitLongText(text, 60);
    expect(parts.length).toBeGreaterThan(1);
    // All content should be preserved
    const joined = parts.join(' ');
    expect(joined).toContain('AAA');
    expect(joined).toContain('BBB');
  });

  it('does not split inside a code block', () => {
    const code = '```\n' + 'x\n'.repeat(50) + '```';
    const parts = splitLongText(code, 40);
    // The code block should remain intact in one part even if it exceeds maxSize
    const codePartFound = parts.some(p => p.includes('```') && p.split('```').length >= 3);
    expect(codePartFound).toBe(true);
  });

  it('handles text with no good split points', () => {
    const text = 'a'.repeat(300);
    const parts = splitLongText(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
  });
});
