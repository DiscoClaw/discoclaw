import { describe, expect, it, vi } from 'vitest';

import { resolveThreadContext } from './thread-context.js';
import type { ThreadLikeChannel, ThreadMessage } from './thread-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMsg(
  id: string, content: string, username: string, bot = false,
  extra?: { attachments?: { size: number }; embeds?: unknown[] },
): ThreadMessage {
  return {
    id,
    author: { username, displayName: username, bot },
    content,
    ...extra,
  };
}

function fakeThread(opts: {
  name?: string;
  starter?: ThreadMessage | null;
  starterError?: boolean;
  messages?: ThreadMessage[];
  fetchError?: boolean;
}): ThreadLikeChannel {
  return {
    isThread: () => true,
    name: opts.name,
    fetchStarterMessage: opts.starterError
      ? (async () => { throw new Error('forbidden'); })
      : (async () => opts.starter ?? null),
    messages: {
      fetch: opts.fetchError
        ? (async () => { throw new Error('forbidden'); })
        : (async () => {
            const map = new Map<string, ThreadMessage>();
            // Discord returns newest-first
            const msgs = [...(opts.messages ?? [])].reverse();
            for (const m of msgs) map.set(m.id, m);
            return map;
          }),
    },
  };
}

function fakeNonThread(): ThreadLikeChannel {
  return {
    isThread: () => false,
    messages: {
      fetch: async () => new Map(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveThreadContext', () => {
  it('returns null for non-thread channels', async () => {
    const result = await resolveThreadContext(fakeNonThread(), '100');
    expect(result).toBeNull();
  });

  it('returns thread name alone when no starter or messages are available', async () => {
    const ch = fakeThread({ name: 'Login fails when session expires', messages: [] });
    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Thread: "Login fails when session expires"');
  });

  it('returns context with starter message and thread name', async () => {
    const ch = fakeThread({
      name: 'bug-discussion',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: 'We need to fix the login flow',
      },
      messages: [],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Thread: "bug-discussion"');
    expect(result!.section).toContain('[Alice (thread starter)]: We need to fix the login flow');
  });

  it('returns context with recent messages in chronological order', async () => {
    const ch = fakeThread({
      name: 'feature-request',
      starter: {
        id: '1',
        author: { username: 'Bob', displayName: 'Bob', bot: false },
        content: 'Add dark mode',
      },
      messages: [
        fakeMsg('2', 'I agree, dark mode would be great', 'Charlie'),
        fakeMsg('3', 'What about the sidebar?', 'Bob'),
      ],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Bob (thread starter)]: Add dark mode');
    expect(result!.section).toContain('Recent thread messages:');
    expect(result!.section).toContain('[Charlie]: I agree, dark mode would be great');
    expect(result!.section).toContain('[Bob]: What about the sidebar?');
    // Verify chronological order: Charlie (id 2) before Bob (id 3)
    const charlieIdx = result!.section.indexOf('[Charlie]');
    const bobIdx = result!.section.indexOf('[Bob]: What');
    expect(charlieIdx).toBeLessThan(bobIdx);
  });

  it('deduplicates starter message from recent messages', async () => {
    const starter: ThreadMessage = {
      id: '1',
      author: { username: 'Alice', displayName: 'Alice', bot: false },
      content: 'The original post',
    };
    const ch = fakeThread({
      name: 'dedup-test',
      starter,
      // Simulate Discord returning the starter in recent messages too
      messages: [
        { ...starter },
        fakeMsg('2', 'A reply', 'Bob'),
      ],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    // Starter should appear once as thread starter, not again in recent
    const matches = result!.section.match(/The original post/g);
    expect(matches).toHaveLength(1);
    expect(result!.section).toContain('[Alice (thread starter)]: The original post');
    expect(result!.section).toContain('[Bob]: A reply');
  });

  it('uses bot display name for bot-authored messages', async () => {
    const ch = fakeThread({
      name: 'bot-thread',
      starter: {
        id: '1',
        author: { username: 'bot', displayName: 'bot', bot: true },
        content: 'Automated report',
      },
      messages: [
        fakeMsg('2', 'Here are the results', 'bot', true),
      ],
    });

    const result = await resolveThreadContext(ch, '100', { botDisplayName: 'TestBot' });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[TestBot (thread starter)]: Automated report');
    expect(result!.section).toContain('[TestBot]: Here are the results');
  });

  it('respects budget — truncates starter when content exceeds limit', async () => {
    const longContent = 'A'.repeat(500);
    const ch = fakeThread({
      name: 'test-thread',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: longContent,
      },
      messages: [],
    });

    const result = await resolveThreadContext(ch, '100', { budgetChars: 100 });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('...');
  });

  it('drops recent messages when budget is exhausted', async () => {
    const ch = fakeThread({
      name: 'budget-test',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: 'A'.repeat(200),
      },
      messages: [
        fakeMsg('2', 'B'.repeat(200), 'Bob'),
        fakeMsg('3', 'should not appear', 'Charlie'),
      ],
    });

    // Budget just enough for thread name + starter + maybe one message
    const result = await resolveThreadContext(ch, '100', { budgetChars: 300 });
    expect(result).not.toBeNull();
    expect(result!.section).not.toContain('should not appear');
  });

  it('handles starter message fetch failure gracefully', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = fakeThread({
      name: 'broken-thread',
      starterError: true,
      messages: [
        fakeMsg('2', 'still here', 'Dave'),
      ],
    });

    const result = await resolveThreadContext(ch, '100', { log });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Dave]: still here');
    expect(log.warn).toHaveBeenCalled();
  });

  it('handles starter message returning null gracefully', async () => {
    const ch = fakeThread({
      name: 'null-starter-thread',
      starter: null,
      messages: [
        fakeMsg('2', 'discussion continues', 'Eve'),
      ],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Eve]: discussion continues');
    expect(result!.section).not.toContain('thread starter');
  });

  it('handles message fetch failure gracefully', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = fakeThread({
      name: 'broken-thread',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: 'The original post',
      },
      fetchError: true,
    });

    const result = await resolveThreadContext(ch, '100', { log });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Alice (thread starter)]: The original post');
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns thread name when both fetches fail', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = fakeThread({
      name: 'totally-broken',
      starterError: true,
      fetchError: true,
    });

    const result = await resolveThreadContext(ch, '100', { log });
    expect(result).not.toBeNull();
    expect(result!.section).toBe('Thread: "totally-broken"');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('returns null when thread has no name, no starter, and no messages', async () => {
    const ch = fakeThread({ messages: [] });
    const result = await resolveThreadContext(ch, '100');
    expect(result).toBeNull();
  });

  it('skips empty content messages without media', async () => {
    const ch = fakeThread({
      name: 'test',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: '',
      },
      messages: [
        fakeMsg('2', '', 'Bob'),
        fakeMsg('3', 'actual content', 'Charlie'),
      ],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).not.toContain('[Bob]');
    expect(result!.section).toContain('[Charlie]: actual content');
  });

  it('renders empty-content messages with attachments as [attachment/embed]', async () => {
    const ch = fakeThread({
      name: 'media-test',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: '',
        attachments: { size: 1 },
      },
      messages: [],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Alice (thread starter)]: [attachment/embed]');
  });

  it('renders empty-content messages with embeds as [attachment/embed]', async () => {
    const ch = fakeThread({
      name: 'embed-test',
      messages: [
        fakeMsg('2', '', 'Bob', false, { attachments: { size: 0 }, embeds: [{}] }),
      ],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Bob]: [attachment/embed]');
  });

  it('handles channel without fetchStarterMessage method', async () => {
    const ch: ThreadLikeChannel = {
      isThread: () => true,
      name: 'no-starter-method',
      messages: {
        fetch: async () => {
          const map = new Map<string, ThreadMessage>();
          map.set('2', fakeMsg('2', 'hello', 'User'));
          return map;
        },
      },
    };

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[User]: hello');
  });

  it('truncates bot messages in recent thread posts to fit budget', async () => {
    const longBotResponse = 'B'.repeat(300);
    const ch = fakeThread({
      name: 'test',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: 'Start',
      },
      messages: [
        fakeMsg('2', longBotResponse, 'Discoclaw', true),
      ],
    });

    const result = await resolveThreadContext(ch, '100', { budgetChars: 200 });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('...');
    expect(result!.section.length).toBeLessThanOrEqual(250);
  });

  it('respects recentMessageLimit option', async () => {
    const ch = fakeThread({
      name: 'busy-thread',
      starter: {
        id: '1',
        author: { username: 'Alice', displayName: 'Alice', bot: false },
        content: 'Start here',
      },
      messages: [
        fakeMsg('2', 'msg one', 'Bob'),
        fakeMsg('3', 'msg two', 'Charlie'),
        fakeMsg('4', 'msg three', 'Dave'),
      ],
    });

    const result = await resolveThreadContext(ch, '100', { recentMessageLimit: 2 });
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Recent thread messages:');
  });

  it('defaults botDisplayName to Discoclaw', async () => {
    const ch = fakeThread({
      name: 'test',
      starter: {
        id: '1',
        author: { username: 'bot', displayName: 'bot', bot: true },
        content: 'bot starter',
      },
      messages: [],
    });

    const result = await resolveThreadContext(ch, '100');
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Discoclaw (thread starter)]');
  });

  it('sorts messages by snowflake ID for correct chronological order', async () => {
    // Provide messages in non-chronological order in the Map
    const ch: ThreadLikeChannel = {
      isThread: () => true,
      name: 'sort-test',
      messages: {
        fetch: async () => {
          const map = new Map<string, ThreadMessage>();
          // Insert out of order
          map.set('300', fakeMsg('300', 'third', 'Charlie'));
          map.set('100', fakeMsg('100', 'first', 'Alice'));
          map.set('200', fakeMsg('200', 'second', 'Bob'));
          return map;
        },
      },
    };

    const result = await resolveThreadContext(ch, '999');
    expect(result).not.toBeNull();
    const aliceIdx = result!.section.indexOf('first');
    const bobIdx = result!.section.indexOf('second');
    const charlieIdx = result!.section.indexOf('third');
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(charlieIdx);
  });
});
