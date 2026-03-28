import { describe, expect, it, vi } from 'vitest';

import { fetchMessageHistory, formatRelativeTime } from './message-history.js';

/** Helper: create a fake Discord message. */
function fakeMsg(
  id: string,
  content: string,
  username: string,
  bot = false,
  opts?: { attachmentCount?: number; embedCount?: number; createdTimestamp?: number },
) {
  return {
    id,
    content,
    author: { username, displayName: username, bot },
    ...(opts?.createdTimestamp !== undefined ? { createdTimestamp: opts.createdTimestamp } : {}),
    ...(opts?.attachmentCount
      ? { attachments: new Map(Array.from({ length: opts.attachmentCount }, (_, i) => [String(i), { url: `https://cdn.discordapp.com/${i}.png`, name: `${i}.png` }])) }
      : {}),
    ...(opts?.embedCount
      ? { embeds: Array.from({ length: opts.embedCount }, () => ({ type: 'rich' })) }
      : {}),
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
  });

  it('returns empty result when no prior messages exist', async () => {
    const ch = fakeChannel([]);
    const result = await fetchMessageHistory(ch, '1', { budgetChars: 3000 });
    expect(result.text).toBe('');
  });

  it('returns empty result when budget is 0', async () => {
    const ch = fakeChannel([
      fakeMsg('1', 'hello', 'User'),
    ]);
    const result = await fetchMessageHistory(ch, '2', { budgetChars: 0 });
    expect(result.text).toBe('');
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

  // --- Attachment / embed text marker tests ---

  it('renders empty-content messages with attachments as [attachment]', async () => {
    const ch = fakeChannel([
      fakeMsg('2', 'look at this', 'User'),
      fakeMsg('1', '', 'User', false, { attachmentCount: 1 }),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[User]: [attachment]');
    expect(lines[1]).toBe('[User]: look at this');
  });

  it('renders empty-content messages with embeds as [embed]', async () => {
    const ch = fakeChannel([
      fakeMsg('1', '', 'User', false, { embedCount: 1 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result.text).toBe('[User]: [embed]');
  });

  it('prefers [attachment] over [embed] when both present', async () => {
    const ch = fakeChannel([
      fakeMsg('1', '', 'User', false, { attachmentCount: 1, embedCount: 1 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result.text).toBe('[User]: [attachment]');
  });

  it('skips empty-content messages with no attachments or embeds', async () => {
    const ch = fakeChannel([
      fakeMsg('2', 'visible', 'User'),
      fakeMsg('1', '', 'User'),
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000 });
    expect(result.text).toBe('[User]: visible');
  });

  it('keeps text content as-is when message also has attachments', async () => {
    const ch = fakeChannel([
      fakeMsg('1', 'here is my screenshot', 'User', false, { attachmentCount: 2 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result.text).toBe('[User]: here is my screenshot');
  });

  it('does not include historyAttachments in result', async () => {
    const ch = fakeChannel([
      fakeMsg('1', '', 'User', false, { attachmentCount: 1 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000 });
    expect(result).not.toHaveProperty('historyAttachments');
  });

  // --- Temporal signal tests ---

  it('includes relative timestamps when createdTimestamp is present', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('2', 'recent msg', 'Alice', false, { createdTimestamp: now - 5 * 60_000 }),  // 5m ago
      fakeMsg('1', 'old msg', 'Bob', false, { createdTimestamp: now - 3 * 86_400_000 }),   // 3d ago
    ]);

    const result = await fetchMessageHistory(ch, '3', { budgetChars: 5000, now });
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('[Bob, 3d ago]: old msg');
    expect(lines[1]).toBe('[Alice, 5m ago]: recent msg');
  });

  it('shows "just now" for messages under 60 seconds old', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'fresh', 'User', false, { createdTimestamp: now - 10_000 }), // 10s ago
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
      fakeMsg('1', 'bot reply', 'Discoclaw', true, { createdTimestamp: now - 2 * 3600_000 }), // 2h ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[Discoclaw, 2h ago]: bot reply');
  });

  it('shows hours correctly at boundary', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'msg', 'User', false, { createdTimestamp: now - 23 * 3600_000 }), // 23h ago
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now });
    expect(result.text).toBe('[User, 23h ago]: msg');
  });

  it('filters out messages older than maxAgeMs', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('3', 'recent', 'User', false, { createdTimestamp: now - 60_000 }),          // 1m ago
      fakeMsg('2', 'stale', 'User', false, { createdTimestamp: now - 25 * 3600_000 }),    // 25h ago
      fakeMsg('1', 'ancient', 'User', false, { createdTimestamp: now - 72 * 3600_000 }),  // 3d ago
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
      fakeMsg('1', 'old', 'User', false, { createdTimestamp: now - 48 * 3600_000 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now, maxAgeMs: 24 * 3600_000 });
    expect(result.text).toBe('');
  });

  it('does not filter by age when maxAgeMs is 0', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'ancient', 'User', false, { createdTimestamp: now - 100 * 86_400_000 }),
    ]);

    const result = await fetchMessageHistory(ch, '2', { budgetChars: 5000, now, maxAgeMs: 0 });
    expect(result.text).toContain('ancient');
  });

  it('shows weeks for messages older than 30 days', async () => {
    const now = 1700000000000;
    const ch = fakeChannel([
      fakeMsg('1', 'ancient', 'User', false, { createdTimestamp: now - 45 * 86_400_000 }), // 45d ago
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
