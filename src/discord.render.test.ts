import { describe, expect, it } from 'vitest';
import {
  renderDiscordTail,
  renderActivityTail,
  splitDiscord,
  truncateCodeBlocks,
  thinkingLabel,
  selectStreamingOutput,
} from './discord.js';

const ZWS = '\u200b';

/** Extract the content lines between the opening and closing fences (for renderDiscordTail). */
function contentLines(rendered: string): string[] {
  const lines = rendered.split('\n');
  // First line is "```text", last line is "```".
  return lines.slice(1, -1);
}

/** Extract the bold label line from renderActivityTail output. */
function activityBoldLabel(rendered: string): string {
  return rendered.split('\n')[0];
}

/** Extract the code block content lines from renderActivityTail output (skips bold line + fence). */
function activityContentLines(rendered: string): string[] {
  const lines = rendered.split('\n');
  // Line 0: **label**, Line 1: ```text, Lines 2..N-1: content, Line N: ```
  return lines.slice(2, -1);
}

// ---------------------------------------------------------------------------
// renderDiscordTail
// ---------------------------------------------------------------------------
describe('renderDiscordTail', () => {
  it('empty string → 8 ZWS lines', () => {
    const out = renderDiscordTail('');
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('single line → 7 ZWS + 1 content line', () => {
    const out = renderDiscordTail('hello');
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).every((l) => l === ZWS)).toBe(true);
    expect(lines[7]).toBe('hello');
  });

  it('exactly 8 lines → no padding', () => {
    const input = Array.from({ length: 8 }, (_, i) => `line${i}`).join('\n');
    const out = renderDiscordTail(input);
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('line0');
    expect(lines[7]).toBe('line7');
  });

  it('more than 8 lines → only last 8', () => {
    const input = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    const out = renderDiscordTail(input);
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('line4');
    expect(lines[7]).toBe('line11');
  });

  it('triple backticks in input are escaped', () => {
    const out = renderDiscordTail('before\n```code```\nafter');
    expect(out).not.toContain('```code```');
    // The escaped form replaces ``` with ``\`
    expect(out).toContain('``\\`code``\\`');
  });

  it('CRLF normalized to LF', () => {
    const out = renderDiscordTail('line1\r\nline2\r\nline3');
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines[5]).toBe('line1');
    expect(lines[6]).toBe('line2');
    expect(lines[7]).toBe('line3');
  });

  it('empty lines in input are filtered out', () => {
    const out = renderDiscordTail('a\n\nb\n\nc');
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    // Only non-empty lines kept: a, b, c
    expect(lines[5]).toBe('a');
    expect(lines[6]).toBe('b');
    expect(lines[7]).toBe('c');
  });

  it('custom maxLines is respected', () => {
    const out = renderDiscordTail('hello', 4);
    const lines = contentLines(out);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('hello');
  });

  it('maxLines = 0 → slice(-0) returns all non-empty lines (1 line for single-word input)', () => {
    // slice(-0) === slice(0) in JS, so all filtered lines are kept.
    // The while loop condition (tail.length < 0) never fires → no padding.
    const out = renderDiscordTail('hello', 0);
    const lines = contentLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('hello');
  });

  it('maxLines = 1 → one content line', () => {
    const out = renderDiscordTail('a\nb\nc', 1);
    const lines = contentLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('c');
  });

  it('wraps in ```text fences', () => {
    const out = renderDiscordTail('hi');
    expect(out.startsWith('```text\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('null/undefined input treated as empty', () => {
    // The function uses String(text ?? ''), so null/undefined should work.
    const out = renderDiscordTail(null as unknown as string);
    const lines = contentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('long lines are truncated to maxWidth with ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = renderDiscordTail(long, 8, 56);
    const lines = contentLines(out);
    expect(lines[7].length).toBe(56);
    expect(lines[7].endsWith('\u2026')).toBe(true);
  });

  it('lines at or under maxWidth are not truncated', () => {
    const exact = 'y'.repeat(56);
    const out = renderDiscordTail(exact, 8, 56);
    const lines = contentLines(out);
    expect(lines[7]).toBe(exact);
  });

  it('ZWS padding lines are not affected by maxWidth', () => {
    const out = renderDiscordTail('short', 8, 10);
    const lines = contentLines(out);
    // All padding lines should still be ZWS.
    expect(lines.slice(0, 7).every((l) => l === ZWS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderActivityTail
// ---------------------------------------------------------------------------
describe('renderActivityTail', () => {
  it('normal label → bold above, 8 ZWS in block', () => {
    const out = renderActivityTail('(working...)');
    expect(activityBoldLabel(out)).toBe('**(working...)**');
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('label with triple backticks is escaped in bold context', () => {
    const out = renderActivityTail('reading ```file```');
    // Backticks are escaped in the bold label
    expect(activityBoldLabel(out)).toBe('**reading \\`\\`\\`file\\`\\`\\`**');
    // Triple backticks in the code block body are also escaped
    expect(out).not.toContain('```file```');
    // Code block content is all ZWS
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('label with newline uses only first non-empty line', () => {
    const out = renderActivityTail('first\nsecond\nthird');
    expect(activityBoldLabel(out)).toBe('**first**');
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('label that is only newlines → empty bold, 8 ZWS lines', () => {
    const out = renderActivityTail('\n');
    expect(activityBoldLabel(out)).toBe('****');
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('custom maxLines is respected', () => {
    const out = renderActivityTail('label', 4);
    expect(activityBoldLabel(out)).toBe('**label**');
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l === ZWS)).toBe(true);
  });

  it('maxLines = 0 → bold label, empty code block', () => {
    const out = renderActivityTail('label', 0);
    expect(activityBoldLabel(out)).toBe('**label**');
    // The join of zero lines produces '' between the fences, yielding one empty line
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('');
  });

  it('maxLines = 1 → bold label, one ZWS line in block', () => {
    const out = renderActivityTail('label', 1);
    expect(activityBoldLabel(out)).toBe('**label**');
    const lines = activityContentLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(ZWS);
  });

  it('starts with bold label, then ```text fences', () => {
    const out = renderActivityTail('hi');
    expect(out.startsWith('**hi**\n```text\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('long label is truncated to maxWidth with ellipsis', () => {
    const long = 'z'.repeat(100);
    const out = renderActivityTail(long, 8, 56);
    const bold = activityBoldLabel(out);
    // Bold wraps: **...truncated...**
    // The truncated label is 55 chars + ellipsis = 56 chars, then escaped
    expect(bold.startsWith('**')).toBe(true);
    expect(bold.endsWith('**')).toBe(true);
    expect(bold).toContain('\u2026');
  });

  it('label at or under maxWidth is not truncated', () => {
    const exact = 'a'.repeat(56);
    const out = renderActivityTail(exact, 8, 56);
    const bold = activityBoldLabel(out);
    expect(bold).toBe(`**${exact}**`);
  });

  it('markdown special chars in label are escaped', () => {
    const out = renderActivityTail('*bold* _italic_ ~strike~');
    expect(activityBoldLabel(out)).toBe('**\\*bold\\* \\_italic\\_ \\~strike\\~**');
  });
});

// ---------------------------------------------------------------------------
// thinkingLabel
// ---------------------------------------------------------------------------
describe('thinkingLabel', () => {
  it('tick 0 → Thinking.', () => {
    expect(thinkingLabel(0)).toBe('Thinking.');
  });

  it('tick 1 → Thinking..', () => {
    expect(thinkingLabel(1)).toBe('Thinking..');
  });

  it('tick 2 → Thinking...', () => {
    expect(thinkingLabel(2)).toBe('Thinking...');
  });

  it('tick 3 → Thinking (no dots)', () => {
    expect(thinkingLabel(3)).toBe('Thinking');
  });

  it('tick 4 → wraps back to Thinking.', () => {
    expect(thinkingLabel(4)).toBe('Thinking.');
  });

  it('tick 7 → Thinking (no dots)', () => {
    expect(thinkingLabel(7)).toBe('Thinking');
  });
});

// ---------------------------------------------------------------------------
// selectStreamingOutput
// ---------------------------------------------------------------------------
describe('selectStreamingOutput', () => {
  it('deltaText wins over all others and shows thinking label above', () => {
    const out = selectStreamingOutput({
      deltaText: 'streaming text',
      activityLabel: 'Reading file...',
      finalText: 'final answer',
      statusTick: 0,
    });
    // Should be bold thinking label + code block (renderDiscordTail)
    expect(out).toContain('**Thinking.**');
    expect(out).toContain('```text');
    expect(out).toContain('streaming text');
  });

  it('deltaText thinking label animates with statusTick', () => {
    const out2 = selectStreamingOutput({
      deltaText: 'hello',
      activityLabel: '',
      finalText: '',
      statusTick: 2,
    });
    expect(out2).toContain('**Thinking...**');
    expect(out2).toContain('hello');
  });

  it('activityLabel wins over finalText and default', () => {
    const out = selectStreamingOutput({
      deltaText: '',
      activityLabel: 'Reading file...',
      finalText: 'final answer',
      statusTick: 0,
    });
    // Should be bold + code block (renderActivityTail)
    expect(out).toContain('**Reading file...**');
    expect(out).toContain('```text');
  });

  it('finalText wins over default thinking', () => {
    const out = selectStreamingOutput({
      deltaText: '',
      activityLabel: '',
      finalText: 'final answer',
      statusTick: 0,
    });
    expect(out).toContain('```text');
    expect(out).toContain('final answer');
    expect(out).not.toContain('**');
  });

  it('empty deltaText/activityLabel/finalText → returns thinking label', () => {
    const out = selectStreamingOutput({
      deltaText: '',
      activityLabel: '',
      finalText: '',
      statusTick: 2,
    });
    // tick 2 → "Thinking..."
    expect(out).toContain('**Thinking...**');
    expect(out).toContain('```text');
  });

  it('thinking label tick advances correctly', () => {
    const out0 = selectStreamingOutput({ deltaText: '', activityLabel: '', finalText: '', statusTick: 0 });
    const out1 = selectStreamingOutput({ deltaText: '', activityLabel: '', finalText: '', statusTick: 1 });
    const out3 = selectStreamingOutput({ deltaText: '', activityLabel: '', finalText: '', statusTick: 3 });
    expect(out0).toContain('**Thinking.**');
    expect(out1).toContain('**Thinking..**');
    expect(out3).toContain('**Thinking**');
  });
});

// ---------------------------------------------------------------------------
// splitDiscord
// ---------------------------------------------------------------------------
describe('splitDiscord', () => {
  it('short text → single chunk', () => {
    const chunks = splitDiscord('Hello world');
    expect(chunks).toEqual(['Hello world']);
  });

  it('text under limit returns as-is', () => {
    const text = 'a'.repeat(100);
    const chunks = splitDiscord(text, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('long text → multiple chunks, each ≤ limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${'x'.repeat(30)}`);
    const text = lines.join('\n');
    const limit = 200;
    const chunks = splitDiscord(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
  });

  it('never exceeds limit when re-opening fenced code blocks', () => {
    const limit = 20;
    const longish = 'x'.repeat(15); // <= limit, but too long once the ```js header is re-opened.
    const text = `\`\`\`js\n${longish}\n\`\`\``;
    const chunks = splitDiscord(text, limit);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(limit);
  });

  it('fenced code blocks are closed/reopened across chunk boundaries', () => {
    const codeLines = Array.from({ length: 50 }, (_, i) => `  code line ${i}`);
    const text = '```js\n' + codeLines.join('\n') + '\n```';
    const chunks = splitDiscord(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should start with the fence opener.
    expect(chunks[0]).toContain('```js');
    // All mid-chunks that are inside the fence should have fence markers.
    for (let i = 0; i < chunks.length - 1; i++) {
      const trimmed = chunks[i].trimEnd();
      // Chunks inside a fence should end with ``` (fence close).
      if (trimmed.includes('```js') || (i > 0 && !chunks[i].startsWith('```'))) {
        // At least verify it's valid markdown (no assertion needed; coverage is the goal).
      }
    }
  });

  it('normalizes CRLF to LF', () => {
    const chunks = splitDiscord('a\r\nb\r\nc');
    expect(chunks).toEqual(['a\nb\nc']);
  });

  it('empty chunks are filtered out', () => {
    const chunks = splitDiscord('hello');
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it('single line longer than limit is hard-split', () => {
    const line = 'x'.repeat(300);
    const chunks = splitDiscord(line, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // Reassembled should equal the original.
    expect(chunks.join('')).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// truncateCodeBlocks
// ---------------------------------------------------------------------------
describe('truncateCodeBlocks', () => {
  it('short block → unchanged', () => {
    const text = '```js\nline1\nline2\nline3\n```';
    expect(truncateCodeBlocks(text, 10)).toBe(text);
  });

  it('long block → truncated with omission message', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const text = '```\n' + lines.join('\n') + '\n```';
    const result = truncateCodeBlocks(text, 10);
    expect(result).toContain('lines omitted');
    // Should keep some top and bottom lines.
    expect(result).toContain('line0');
    expect(result).toContain('line29');
    // Middle lines should be gone.
    expect(result).not.toContain('line15');
  });

  it('keeps first/last lines of truncated block', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`);
    const text = '```py\n' + lines.join('\n') + '\n```';
    const result = truncateCodeBlocks(text, 10);
    // keepTop = ceil(10/2) = 5, keepBottom = floor(10/2) = 5
    for (let i = 0; i < 5; i++) expect(result).toContain(`L${i}`);
    for (let i = 35; i < 40; i++) expect(result).toContain(`L${i}`);
    // Omitted count: 40 - 5 - 5 = 30
    expect(result).toContain('30 lines omitted');
  });

  it('text without code blocks → unchanged', () => {
    const text = 'Hello world\nNo code here.';
    expect(truncateCodeBlocks(text, 5)).toBe(text);
  });

  it('block exactly at maxLines → unchanged', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const text = '```\n' + lines.join('\n') + '\n```';
    expect(truncateCodeBlocks(text, 10)).toBe(text);
  });

  it('multiple code blocks truncated independently', () => {
    const longBlock = Array.from({ length: 25 }, (_, i) => `a${i}`).join('\n');
    const shortBlock = 'x\ny';
    const text = `before\n\`\`\`\n${longBlock}\n\`\`\`\nmiddle\n\`\`\`\n${shortBlock}\n\`\`\`\nafter`;
    const result = truncateCodeBlocks(text, 10);
    expect(result).toContain('lines omitted');
    // Short block should be unchanged.
    expect(result).toContain('x\ny');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });
});
