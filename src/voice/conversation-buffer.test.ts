import { describe, it, expect } from 'vitest';
import { ConversationBuffer, CAPACITY } from './conversation-buffer.js';

describe('ConversationBuffer', () => {
  // -- Basic push/get round-trip -----------------------------------------------

  it('stores a single turn and retrieves it', () => {
    const buf = new ConversationBuffer();
    buf.push('hello', 'hi there');
    expect(buf.size).toBe(1);
    expect(buf.getHistory()).toBe('[User]: hello\n[Assistant]: hi there');
  });

  it('stores multiple turns in order', () => {
    const buf = new ConversationBuffer();
    buf.push('first', 'reply-1');
    buf.push('second', 'reply-2');
    expect(buf.size).toBe(2);
    expect(buf.getHistory()).toBe(
      '[User]: first\n[Assistant]: reply-1\n[User]: second\n[Assistant]: reply-2',
    );
  });

  // -- Eviction at capacity ----------------------------------------------------

  it('evicts oldest turn when capacity is exceeded', () => {
    const buf = new ConversationBuffer();
    for (let i = 0; i < CAPACITY + 3; i++) {
      buf.push(`user-${i}`, `bot-${i}`);
    }
    expect(buf.size).toBe(CAPACITY);

    const history = buf.getHistory();
    // Oldest 3 turns (0, 1, 2) should be gone
    expect(history).not.toContain('[User]: user-0\n');
    expect(history).not.toContain('[User]: user-1\n');
    expect(history).not.toContain('[User]: user-2\n');
    // Most recent should be present
    expect(history).toContain(`[User]: user-${CAPACITY + 2}`);
    // First surviving turn
    expect(history).toContain('[User]: user-3\n');
  });

  it('maintains correct order after wrap-around', () => {
    const buf = new ConversationBuffer();
    for (let i = 0; i < CAPACITY + 2; i++) {
      buf.push(`u${i}`, `a${i}`);
    }
    const lines = buf.getHistory().split('\n');
    // Should start with the oldest surviving turn (index 2)
    expect(lines[0]).toBe('[User]: u2');
    expect(lines[1]).toBe('[Assistant]: a2');
    // Should end with the newest turn
    expect(lines[lines.length - 2]).toBe(`[User]: u${CAPACITY + 1}`);
    expect(lines[lines.length - 1]).toBe(`[Assistant]: a${CAPACITY + 1}`);
  });

  // -- Backfill ----------------------------------------------------------------

  it('populates history from backfill', () => {
    const buf = new ConversationBuffer();
    buf.backfill([
      { user: 'old-q', assistant: 'old-a' },
      { user: 'recent-q', assistant: 'recent-a' },
    ]);
    expect(buf.size).toBe(2);
    expect(buf.getHistory()).toContain('[User]: old-q');
    expect(buf.getHistory()).toContain('[User]: recent-q');
  });

  it('keeps only most recent entries when backfill exceeds capacity', () => {
    const buf = new ConversationBuffer();
    const turns = Array.from({ length: CAPACITY + 5 }, (_, i) => ({
      user: `q-${i}`,
      assistant: `a-${i}`,
    }));
    buf.backfill(turns);
    expect(buf.size).toBe(CAPACITY);

    const history = buf.getHistory();
    // Oldest 5 should be gone
    for (let i = 0; i < 5; i++) {
      expect(history).not.toContain(`[User]: q-${i}\n`);
    }
    // Most recent should be present
    expect(history).toContain(`[User]: q-${CAPACITY + 4}`);
  });

  // -- Backfill + push interaction ---------------------------------------------

  it('evicts backfilled turns when new pushes overflow capacity', () => {
    const buf = new ConversationBuffer();
    buf.backfill([
      { user: 'backfill-1', assistant: 'bf-reply-1' },
      { user: 'backfill-2', assistant: 'bf-reply-2' },
    ]);
    // Fill remaining capacity plus one extra to trigger eviction
    for (let i = 0; i < CAPACITY - 1; i++) {
      buf.push(`live-${i}`, `live-reply-${i}`);
    }
    expect(buf.size).toBe(CAPACITY);

    const history = buf.getHistory();
    // First backfill turn should have been evicted
    expect(history).not.toContain('backfill-1');
    // Second backfill turn should still be present
    expect(history).toContain('backfill-2');
  });

  // -- Clear -------------------------------------------------------------------

  it('resets state on clear', () => {
    const buf = new ConversationBuffer();
    buf.push('q', 'a');
    buf.push('q2', 'a2');
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.getHistory()).toBe('');
  });

  it('accepts new pushes after clear', () => {
    const buf = new ConversationBuffer();
    buf.push('before', 'before-a');
    buf.clear();
    buf.push('after', 'after-a');
    expect(buf.size).toBe(1);
    expect(buf.getHistory()).toBe('[User]: after\n[Assistant]: after-a');
  });

  // -- Empty buffer ------------------------------------------------------------

  it('returns empty string for empty buffer', () => {
    const buf = new ConversationBuffer();
    expect(buf.getHistory()).toBe('');
    expect(buf.size).toBe(0);
  });

  // -- Per-entry truncation ----------------------------------------------------

  it('truncates user text exceeding 500 chars', () => {
    const buf = new ConversationBuffer();
    const longText = 'x'.repeat(600);
    buf.push(longText, 'short reply');
    const history = buf.getHistory();
    const userLine = history.split('\n')[0];
    // 500 chars + ellipsis + prefix
    expect(userLine).toBe(`[User]: ${'x'.repeat(500)}…`);
  });

  it('truncates assistant text exceeding 500 chars', () => {
    const buf = new ConversationBuffer();
    const longReply = 'y'.repeat(600);
    buf.push('short question', longReply);
    const history = buf.getHistory();
    const assistantLine = history.split('\n')[1];
    expect(assistantLine).toBe(`[Assistant]: ${'y'.repeat(500)}…`);
  });

  it('does not truncate text at exactly 500 chars', () => {
    const buf = new ConversationBuffer();
    const exact = 'z'.repeat(500);
    buf.push(exact, exact);
    const history = buf.getHistory();
    expect(history).not.toContain('…');
    expect(history).toBe(`[User]: ${exact}\n[Assistant]: ${exact}`);
  });
});
