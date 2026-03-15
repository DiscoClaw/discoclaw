import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { executePollAction } from './actions-poll.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(channels: any[]): ActionContext {
  const cache = new Map<string, any>();
  for (const ch of channels) cache.set(ch.id, ch);

  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => cache.get(id),
          find: (fn: any) => {
            for (const ch of cache.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
          values: () => cache.values(),
        },
      },
    } as any,
    client: {} as any,
    channelId: 'ch1',
    messageId: 'msg1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('poll', () => {
  it('creates a poll in a channel', async () => {
    const ch = {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      send: vi.fn(async () => ({})),
    };
    const ctx = makeCtx([ch]);

    const result = await executePollAction(
      {
        type: 'poll',
        channel: '#general',
        question: 'What should we build?',
        answers: ['Feature A', 'Feature B', 'Feature C'],
      },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      summary: 'Created poll "What should we build?" in #general with 3 options',
    });
    expect(ch.send).toHaveBeenCalledWith({
      poll: {
        question: { text: 'What should we build?' },
        answers: [{ text: 'Feature A' }, { text: 'Feature B' }, { text: 'Feature C' }],
        allowMultiselect: false,
        duration: 24,
      },
    });
  });

  it('supports multiselect and custom duration', async () => {
    const ch = {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      send: vi.fn(async () => ({})),
    };
    const ctx = makeCtx([ch]);

    await executePollAction(
      {
        type: 'poll',
        channel: '#general',
        question: 'Pick all that apply',
        answers: ['A', 'B'],
        allowMultiselect: true,
        durationHours: 48,
      },
      ctx,
    );

    expect(ch.send).toHaveBeenCalledWith({
      poll: {
        question: { text: 'Pick all that apply' },
        answers: [{ text: 'A' }, { text: 'B' }],
        allowMultiselect: true,
        duration: 48,
      },
    });
  });

  it('fails when channel not found', async () => {
    const ctx = makeCtx([]);
    const result = await executePollAction(
      { type: 'poll', channel: '#nonexistent', question: 'Q?', answers: ['A', 'B'] },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'Channel "#nonexistent" not found' });
  });
});
