import { describe, expect, it } from 'vitest';

import { fetchMessageHistory } from './message-history.js';

/** Helper: create a fake Discord message. */
function fakeMsg(id: string, content: string, username: string, bot = false) {
  return {
    id,
    content,
    author: { username, displayName: username, bot },
  };
}

/** Helper: create a fake channel whose messages.fetch returns the given messages (newest-first). */
function fakeChannel(messages: ReturnType<typeof fakeMsg>[]) {
  return {
    messages: {
      fetch: async () => {
        // Discord returns a Collection (Map-like) with newest-first order.
        const map = new Map<string, (typeof messages)[0]>();
        for (const m of messages) map.set(m.id, m);
        return map;
      },
    },
  } as any;
}

describe('fetchMessageHistory', () => {
  it('fetches and formats messages in chronological order', async () => {
    const ch = fakeChannel([
      fakeMsg('3', 'sounds good', 'TestUser'),
      fakeMsg('2', 'Before I create it, let me confirm...', 'Discoclaw', true),
      fakeMsg('1', 'create a status channel', 'TestUser'),
    ]);

    const result = await fetchMessageHistory(ch, '4', { budgetChars: 5000 });
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[TestUser]: create a status channel');
    expect(lines[1]).toBe('[Discoclaw]: Before I create it, let me confirm...');
    expect(lines[2]).toBe('[TestUser]: sounds good');
  });

  it('respects char budget — stops adding messages when full', async () => {
    const ch = fakeChannel([
      fakeMsg('3', 'c', 'User'),
      fakeMsg('2', 'b', 'User'),
      fakeMsg('1', 'aaaaaaaaaa', 'User'), // oldest — long enough to exceed budget
    ]);

    // Budget enough for the two recent short messages but not all three.
    // "[User]: c" = 9 chars, "[User]: b" = 9 chars, + 1 newline = 19 chars
    const result = await fetchMessageHistory(ch, '4', { budgetChars: 19 });
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[User]: b');
    expect(lines[1]).toBe('[User]: c');
  });

  it('truncates bot responses that exceed remaining budget', async () => {
    const longResponse = 'A'.repeat(200);
    const ch = fakeChannel([
      fakeMsg('2', longResponse, 'Discoclaw', true),
      fakeMsg('1', 'hi', 'User'),
    ]);

    // Budget enough for part of the bot response but not all.
    const result = await fetchMessageHistory(ch, '3', { budgetChars: 50 });
    expect(result).toContain('[Discoclaw]:');
    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(55); // some tolerance for formatting
  });

  it('includes user messages in full', async () => {
    const ch = fakeChannel([
      fakeMsg('2', 'this is a user message', 'Alice'),
      fakeMsg('1', 'hello', 'Alice'),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    expect(result).toContain('[Alice]: hello');
    expect(result).toContain('[Alice]: this is a user message');
  });

  it('handles fetch failures gracefully (returns empty string)', async () => {
    const ch = {
      messages: {
        fetch: async () => { throw new Error('forbidden'); },
      },
    } as any;

    const result = await fetchMessageHistory(ch, '1', { budgetChars: 3000 });
    expect(result).toBe('');
  });

  it('returns empty string when no prior messages exist', async () => {
    const ch = fakeChannel([]);
    const result = await fetchMessageHistory(ch, '1', { budgetChars: 3000 });
    expect(result).toBe('');
  });

  it('returns empty string when budget is 0', async () => {
    const ch = fakeChannel([
      fakeMsg('1', 'hello', 'User'),
    ]);
    const result = await fetchMessageHistory(ch, '2', { budgetChars: 0 });
    expect(result).toBe('');
  });
});
