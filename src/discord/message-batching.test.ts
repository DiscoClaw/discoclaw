import { describe, expect, it } from 'vitest';
import type { BatchedMessage } from './message-batching.js';
import { formatBatchedMessages, isCommandMessage } from './message-batching.js';

describe('isCommandMessage', () => {
  it('returns true for !help', () => {
    expect(isCommandMessage('!help')).toBe(true);
  });

  it('returns true for !stop', () => {
    expect(isCommandMessage('!stop')).toBe(true);
  });

  it('returns true for !cancel', () => {
    expect(isCommandMessage('!cancel')).toBe(true);
  });

  it('returns true for !memory commands', () => {
    expect(isCommandMessage('!memory')).toBe(true);
    expect(isCommandMessage('!memory show')).toBe(true);
    expect(isCommandMessage('!memory remember something important')).toBe(true);
    expect(isCommandMessage('!memory forget something')).toBe(true);
    expect(isCommandMessage('!memory reset rolling')).toBe(true);
  });

  it('returns true for !plan commands', () => {
    expect(isCommandMessage('!plan create')).toBe(true);
    expect(isCommandMessage('!plan list')).toBe(true);
    expect(isCommandMessage('!plan help')).toBe(true);
  });

  it('returns true for !forge commands', () => {
    expect(isCommandMessage('!forge run a task')).toBe(true);
    expect(isCommandMessage('!forge help')).toBe(true);
    expect(isCommandMessage('!forge status')).toBe(true);
  });

  it('returns true for !models commands', () => {
    expect(isCommandMessage('!models')).toBe(true);
    expect(isCommandMessage('!models set main gpt-4o')).toBe(true);
    expect(isCommandMessage('!models help')).toBe(true);
  });

  it('returns true for !health commands', () => {
    expect(isCommandMessage('!health')).toBe(true);
    expect(isCommandMessage('!health verbose')).toBe(true);
  });

  it('returns true for !status', () => {
    expect(isCommandMessage('!status')).toBe(true);
  });

  it('returns true for !restart', () => {
    expect(isCommandMessage('!restart')).toBe(true);
  });

  it('returns true for !update commands', () => {
    expect(isCommandMessage('!update')).toBe(true);
    expect(isCommandMessage('!update help')).toBe(true);
  });

  it('returns true for !confirm tokens', () => {
    expect(isCommandMessage('!confirm abc123def')).toBe(true);
    expect(isCommandMessage('!confirm some-token-here')).toBe(true);
  });

  it('strips leading whitespace before checking', () => {
    expect(isCommandMessage('  !stop')).toBe(true);
    expect(isCommandMessage('\t!help')).toBe(true);
    expect(isCommandMessage('  !memory show')).toBe(true);
  });

  it('returns false for regular conversation messages', () => {
    expect(isCommandMessage('hello world')).toBe(false);
    expect(isCommandMessage('how do I do X?')).toBe(false);
    expect(isCommandMessage('what time is it')).toBe(false);
    expect(isCommandMessage('can you help me with something')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCommandMessage('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isCommandMessage('   ')).toBe(false);
    expect(isCommandMessage('\t\n')).toBe(false);
  });

  it('returns false when ! appears mid-message', () => {
    expect(isCommandMessage('this is not !a command')).toBe(false);
    expect(isCommandMessage('exciting!')).toBe(false);
  });
});

describe('formatBatchedMessages', () => {
  it('returns empty string for an empty array', () => {
    expect(formatBatchedMessages([])).toBe('');
  });

  it('returns content unchanged for a single message without author', () => {
    const msgs: BatchedMessage[] = [{ content: 'hello there' }];
    expect(formatBatchedMessages(msgs)).toBe('hello there');
  });

  it('returns content unchanged for a single message with author (no wrapper needed)', () => {
    const msgs: BatchedMessage[] = [{ content: 'hello there', authorDisplayName: 'Alice' }];
    expect(formatBatchedMessages(msgs)).toBe('hello there');
  });

  it('formats two messages without author names', () => {
    const msgs: BatchedMessage[] = [
      { content: 'first message' },
      { content: 'second message' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('2 messages');
    expect(result).toContain('1. first message');
    expect(result).toContain('2. second message');
  });

  it('formats two messages with the same author', () => {
    const msgs: BatchedMessage[] = [
      { content: 'first message', authorDisplayName: 'Alice' },
      { content: 'second message', authorDisplayName: 'Alice' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('Alice: first message');
    expect(result).toContain('Alice: second message');
  });

  it('formats messages from different authors', () => {
    const msgs: BatchedMessage[] = [
      { content: 'hi there', authorDisplayName: 'Alice' },
      { content: 'and me too', authorDisplayName: 'Bob' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('Alice: hi there');
    expect(result).toContain('Bob: and me too');
  });

  it('formats three or more messages', () => {
    const msgs: BatchedMessage[] = [
      { content: 'msg 1' },
      { content: 'msg 2' },
      { content: 'msg 3' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('3 messages');
    expect(result).toContain('1. msg 1');
    expect(result).toContain('2. msg 2');
    expect(result).toContain('3. msg 3');
  });

  it('preserves multi-line content within messages', () => {
    const msgs: BatchedMessage[] = [
      { content: 'line1\nline2\nline3' },
      { content: 'other message' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('line1\nline2\nline3');
  });

  it('includes a note that messages arrived during processing', () => {
    const msgs: BatchedMessage[] = [
      { content: 'a' },
      { content: 'b' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toMatch(/in progress|previous.*response|processing/i);
  });

  it('omits author prefix when authorDisplayName is absent', () => {
    const msgs: BatchedMessage[] = [
      { content: 'no author' },
      { content: 'also no author' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).not.toContain('undefined:');
    expect(result).not.toMatch(/^\d+\. :/m);
  });

  it('messages appear in the original order', () => {
    const msgs: BatchedMessage[] = [
      { content: 'alpha' },
      { content: 'beta' },
      { content: 'gamma' },
    ];
    const result = formatBatchedMessages(msgs);
    const alphaIdx = result.indexOf('alpha');
    const betaIdx = result.indexOf('beta');
    const gammaIdx = result.indexOf('gamma');
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(gammaIdx);
  });

  it('mixed: some messages with author and some without', () => {
    const msgs: BatchedMessage[] = [
      { content: 'with author', authorDisplayName: 'Dave' },
      { content: 'without author' },
    ];
    const result = formatBatchedMessages(msgs);
    expect(result).toContain('Dave: with author');
    expect(result).toContain('2. without author');
    expect(result).not.toContain('undefined:');
  });
});
