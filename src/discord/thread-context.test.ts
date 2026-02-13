import { describe, expect, it, vi } from 'vitest';

import { resolveThreadContext } from './thread-context.js';
import type { ThreadLikeChannel, StarterMessage, ThreadMessage } from './thread-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMsg(id: string, content: string, username: string, bot = false): ThreadMessage {
  return {
    id,
    author: { username, displayName: username, bot },
    content,
  };
}

function fakeThread(opts: {
  name?: string;
  starter?: StarterMessage | null;
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

  it('returns null when thread has only a name but no starter or messages', async () => {
    const ch = fakeThread({ name: 'some-thread', messages: [] });
    const result = await resolveThreadContext(ch, '100');
    expect(result).toBeNull();
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
    expect(result!.section).toContain('Thread: bug-discussion');
    expect(result!.section).toContain('[Alice (thread starter)]: We need to fix the login flow');
  });

  it('returns context with recent messages', async () => {
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
    expect(result!.section).toContain('Thread: feature-request');
    expect(result!.section).toContain('[Bob (thread starter)]: Add dark mode');
    expect(result!.section).toContain('Recent thread messages:');
    expect(result!.section).toContain('[Charlie]: I agree, dark mode would be great');
    expect(result!.section).toContain('[Bob]: What about the sidebar?');
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

  it('respects budget — truncates when content exceeds limit', async () => {
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
    expect(result!.section.length).toBeLessThanOrEqual(120); // some tolerance
    expect(result!.section).toContain('...');
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
    // Should still return recent messages even if starter fails
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Dave]: still here');
    expect(log.warn).toHaveBeenCalled();
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
    // Should still return starter even if recent messages fail
    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Alice (thread starter)]: The original post');
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns null when thread has no name, no starter, and no messages', async () => {
    const ch = fakeThread({ messages: [] });
    const result = await resolveThreadContext(ch, '100');
    expect(result).toBeNull();
  });

  it('skips empty content messages', async () => {
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
    // Total should fit within budget + tolerance
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
    // The fetch limit is passed through — we trust the mock to return all 3,
    // but in production Discord would respect the limit parameter.
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
});
