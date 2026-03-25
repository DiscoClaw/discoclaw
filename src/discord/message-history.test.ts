import { describe, expect, it, vi } from 'vitest';

import type { AttachmentLike } from './image-download.js';
import { fetchMessageHistory, formatRelativeTime } from './message-history.js';

/** Helper: create a fake Discord message. */
function fakeMsg(
  id: string,
  content: string,
  username: string,
  bot = false,
  attachments?: AttachmentLike[],
  createdTimestamp?: number,
) {
  return {
    id,
    content,
    author: { username, displayName: username, bot },
    ...(createdTimestamp !== undefined ? { createdTimestamp } : {}),
    ...(attachments
      ? { attachments: new Map(attachments.map((a, i) => [String(i), a])) }
      : {}),
  };
}

/** Shorthand for an image attachment. */
function imgAtt(name: string, url = `https://cdn.discordapp.com/${name}`): AttachmentLike {
  return { url, name, contentType: 'image/png', size: 1024 };
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
    const lines = result.text.split('\n');
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
    const lines = result.text.split('\n');
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
    expect(result.text).toContain('[Discoclaw]:');
    expect(result.text).toContain('...');
    expect(result.text.length).toBeLessThanOrEqual(55); // some tolerance for formatting
  });

  it('includes user messages in full', async () => {
    const ch = fakeChannel([
      fakeMsg('2', 'this is a user message', 'Alice'),
      fakeMsg('1', 'hello', 'Alice'),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    expect(result.text).toContain('[Alice]: hello');
    expect(result.text).toContain('[Alice]: this is a user message');
  });

  it('handles fetch failures gracefully (returns empty result)', async () => {
    const ch = {
      messages: {
        fetch: async () => { throw new Error('forbidden'); },
      },
    } as any;

    const result = await fetchMessageHistory(ch, '1', { budgetChars: 3000 });
    expect(result.text).toBe('');
    expect(result.historyAttachments).toEqual([]);
  });

  it('returns empty result when no prior messages exist', async () => {
    const ch = fakeChannel([]);
    const result = await fetchMessageHistory(ch, '1', { budgetChars: 3000 });
    expect(result.text).toBe('');
    expect(result.historyAttachments).toEqual([]);
  });

  it('returns empty result when budget is 0', async () => {
    const ch = fakeChannel([
      fakeMsg('1', 'hello', 'User'),
    ]);
    const result = await fetchMessageHistory(ch, '2', { budgetChars: 0 });
    expect(result.text).toBe('');
    expect(result.historyAttachments).toEqual([]);
  });

  it('can fetch the latest messages and exclude specific message ids', async () => {
    const fetch = vi.fn(async () => new Map([
      ['3', fakeMsg('3', 'latest follow-up', 'User')],
      ['2', fakeMsg('2', 'skip this message', 'User')],
      ['1', fakeMsg('1', 'earlier context', 'User')],
    ]));

    const ch = {
      messages: { fetch },
    } as any;

    const result = await fetchMessageHistory(ch, undefined, {
      budgetChars: 5000,
      excludeMessageIds: ['2'],
    });

    expect(fetch).toHaveBeenCalledWith({ limit: 11 });
    expect(result.text).toBe('[User]: earlier context\n[User]: latest follow-up');
  });

  // --- Image / attachment extraction tests ---

  it('extracts image attachments from channel history messages', async () => {
    const att1 = imgAtt('screenshot.png');
    const att2 = imgAtt('diagram.png');
    const ch = fakeChannel([
      fakeMsg('3', 'here is a screenshot', 'User', false, [att1]),
      fakeMsg('2', 'no images here', 'User'),
      fakeMsg('1', 'and a diagram', 'User', false, [att2]),
    ]);

    const result = await fetchMessageHistory(ch, '4', { budgetChars: 5000 });
    expect(result.historyAttachments).toHaveLength(2);
    // Newest-first ordering: att1 (msg 3) before att2 (msg 1)
    expect(result.historyAttachments[0]).toBe(att1);
    expect(result.historyAttachments[1]).toBe(att2);
  });

  it('returns attachments newest-first across multiple messages', async () => {
    const a1 = imgAtt('old.png');
    const a2 = imgAtt('mid.png');
    const a3 = imgAtt('new.png');
    const ch = fakeChannel([
      fakeMsg('3', 'newest', 'User', false, [a3]),
      fakeMsg('2', 'middle', 'User', false, [a2]),
      fakeMsg('1', 'oldest', 'User', false, [a1]),
    ]);

    const result = await fetchMessageHistory(ch, '4', { budgetChars: 5000 });
    expect(result.historyAttachments).toEqual([a3, a2, a1]);
  });

  it('returns multiple attachments from a single message in order', async () => {
    const a1 = imgAtt('first.png');
    const a2 = imgAtt('second.png');
    const ch = fakeChannel([
      fakeMsg('1', 'two images', 'User', false, [a1, a2]),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result.historyAttachments).toEqual([a1, a2]);
  });

  it('returns empty attachments when messages have no images', async () => {
    const ch = fakeChannel([
      fakeMsg('2', 'just text', 'User'),
      fakeMsg('1', 'more text', 'User'),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    expect(result.historyAttachments).toEqual([]);
  });

  it('does not include attachments from excluded messages', async () => {
    const att = imgAtt('excluded.png');
    const ch = fakeChannel([
      fakeMsg('2', 'keep this', 'User'),
      fakeMsg('1', 'exclude this', 'User', false, [att]),
    ]);

    const result = await fetchMessageHistory(ch, '3', {
      budgetChars: 5000,
      excludeMessageIds: ['1'],
    });
    expect(result.text).toBe('[User]: keep this');
    expect(result.historyAttachments).toEqual([]);
  });

  it('text is chronological while attachments are newest-first', async () => {
    const oldAtt = imgAtt('old.png');
    const newAtt = imgAtt('new.png');
    const ch = fakeChannel([
      fakeMsg('2', 'new message', 'User', false, [newAtt]),
      fakeMsg('1', 'old message', 'User', false, [oldAtt]),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    // Text: chronological (old first)
    const lines = result.text.split('\n');
    expect(lines[0]).toContain('old message');
    expect(lines[1]).toContain('new message');
    // Attachments: newest-first
    expect(result.historyAttachments[0]).toBe(newAtt);
    expect(result.historyAttachments[1]).toBe(oldAtt);
  });

  // --- Temporal signal tests ---

  it('includes relative timestamps when createdTimestamp is present', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('2', 'recent msg', 'Alice', false, undefined, now - 5 * 60_000),  // 5m ago
      fakeMsg('1', 'old msg', 'Bob', false, undefined, now - 3 * 86_400_000),   // 3d ago
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000, now });
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('[Bob, 3d ago]: old msg');
    expect(lines[1]).toBe('[Alice, 5m ago]: recent msg');
  });

  it('shows "just now" for messages under 60 seconds old', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'fresh', 'User', false, undefined, now - 10_000), // 10s ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[User, just now]: fresh');
  });

  it('omits age label when createdTimestamp is missing', async () => {
    const ch = fakeChannel([
      fakeMsg('1', 'no timestamp', 'User'),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result.text).toBe('[User]: no timestamp');
  });

  it('includes age label on bot messages too', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'bot reply', 'Discoclaw', true, undefined, now - 2 * 3600_000), // 2h ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[Discoclaw, 2h ago]: bot reply');
  });

  it('shows hours correctly at boundary', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'msg', 'User', false, undefined, now - 23 * 3600_000), // 23h ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[User, 23h ago]: msg');
  });

  it('filters out messages older than maxAgeMs', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('3', 'recent', 'User', false, undefined, now - 60_000),          // 1m ago
      fakeMsg('2', 'stale', 'User', false, undefined, now - 25 * 3600_000),    // 25h ago
      fakeMsg('1', 'ancient', 'User', false, undefined, now - 72 * 3600_000),  // 3d ago
    ]);

    // maxAgeMs = 24h — only the 1m-ago message should survive
    const result = await fetchMessageHistory(ch, '4', { budgetChars: 5000, now, maxAgeMs: 24 * 3600_000 });
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[User, 1m ago]: recent');
  });

  it('returns empty when all messages exceed maxAgeMs', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'old', 'User', false, undefined, now - 48 * 3600_000),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now, maxAgeMs: 24 * 3600_000 });
    expect(result.text).toBe('');
    expect(result.historyAttachments).toEqual([]);
  });

  it('does not filter by age when maxAgeMs is 0', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'ancient', 'User', false, undefined, now - 100 * 86_400_000),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now, maxAgeMs: 0 });
    expect(result.text).toContain('ancient');
  });

  it('shows weeks for messages older than 30 days', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'ancient', 'User', false, undefined, now - 45 * 86_400_000), // 45d ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[User, 6w ago]: ancient');
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for < 60s', () => {
    expect(formatRelativeTime(0)).toBe('just now');
    expect(formatRelativeTime(30_000)).toBe('just now');
    expect(formatRelativeTime(59_999)).toBe('just now');
  });

  it('returns minutes', () => {
    expect(formatRelativeTime(60_000)).toBe('1m ago');
    expect(formatRelativeTime(45 * 60_000)).toBe('45m ago');
  });

  it('returns hours', () => {
    expect(formatRelativeTime(3600_000)).toBe('1h ago');
    expect(formatRelativeTime(5 * 3600_000)).toBe('5h ago');
  });

  it('returns days', () => {
    expect(formatRelativeTime(86_400_000)).toBe('1d ago');
    expect(formatRelativeTime(7 * 86_400_000)).toBe('7d ago');
  });

  it('returns weeks for >= 30 days', () => {
    expect(formatRelativeTime(30 * 86_400_000)).toBe('4w ago');
    expect(formatRelativeTime(60 * 86_400_000)).toBe('8w ago');
  });
});
