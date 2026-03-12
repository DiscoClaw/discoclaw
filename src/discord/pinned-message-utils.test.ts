import { describe, expect, it } from 'vitest';

import { countPinnedMessages, normalizePinnedMessages } from './pinned-message-utils.js';

describe('normalizePinnedMessages', () => {
  it('normalizes legacy collection-like pinned message results', () => {
    const messages = new Map([
      ['p1', { id: 'p1', content: 'Pinned one' }],
      ['p2', { id: 'p2', content: 'Pinned two' }],
    ]);

    expect(normalizePinnedMessages(messages)).toEqual([
      { id: 'p1', content: 'Pinned one' },
      { id: 'p2', content: 'Pinned two' },
    ]);
    expect(countPinnedMessages(messages)).toBe(2);
  });

  it('normalizes discord.js fetchPins() responses', () => {
    const response = {
      items: [
        { pinnedTimestamp: 1, message: { id: 'p1', content: 'Pinned one' } },
        { pinnedTimestamp: 2, message: { id: 'p2', content: 'Pinned two' } },
      ],
      hasMore: false,
    };

    expect(normalizePinnedMessages(response)).toEqual([
      { id: 'p1', content: 'Pinned one' },
      { id: 'p2', content: 'Pinned two' },
    ]);
    expect(countPinnedMessages(response)).toBe(2);
  });

  it('handles empty and malformed pin payloads without throwing', () => {
    expect(normalizePinnedMessages(null)).toEqual([]);
    expect(normalizePinnedMessages({ items: [] })).toEqual([]);
    expect(normalizePinnedMessages({ values: () => ({}) })).toEqual([]);
    expect(countPinnedMessages({})).toBe(0);
  });
});
